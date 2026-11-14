import { describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_MODEL_ID, HIGH_QUALITY_MODEL_ID, type ModelId } from '@/engine/model/catalog';
import type { DownloadProgress } from '@/engine/model/download';
import type { BackendSelection } from '@/engine/in-browser/backend';
import { CachingEngine } from '@/engine/cache/caching-engine';
import { TranslationCache } from '@/engine/cache/cache';
import { buildTranslationCacheKey } from '@/engine/cache/key';
import { MemoryTranslationCacheStore } from '@/engine/cache/store';
import { EngineError } from '@/engine/errors';
import { selectBackend } from '@/engine/in-browser/backend';
import {
  EngineHost,
  RETRY_RUNTIME_IDLE_MS,
  canReuseLoadedRuntimeForRetry,
  loadWithFallback,
  warmup,
  type EngineServices,
} from '@/engine/offscreen/host';
import type { LoadedModel } from '@/engine/model/manager';
import type { ModelStatus } from '@/shared/engine-status';
import { normalizeSettings } from '@/shared/settings';
import * as storage from '@/shared/storage';
import type { IdentifiedEngine, TranslateOptions, TranslateSegment } from '@/engine/types';
import { serializeTranslateOptions } from '@/engine/offscreen/protocol';
import { FakeRuntime } from './support/fakes';
import { FakePort, deferred, flushTasks } from './support/ports';

vi.mock('wxt/browser', () => ({
  browser: { runtime: { id: 'test-extension' } },
}));

const SELECTION: BackendSelection = {
  tier: 'c8',
  backend: 'cpu-wasm',
  nGpuLayers: 0,
  nThreads: 8,
  nParallel: 1,
  nCtx: 2048,
};

function options(): TranslateOptions {
  return { tgt: 'ja', form: 'polite', priority: 10, signal: new AbortController().signal };
}

function modelStatus(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: DEFAULT_MODEL_ID,
    state: 'ready',
    received: 1,
    total: 1,
    progress: 1,
    ...overrides,
  };
}

type DownloadFn = (
  modelId: ModelId,
  options: { signal: AbortSignal; onProgress?: (progress: DownloadProgress) => void },
) => Promise<void>;

function createServices() {
  const unload = vi.fn(async () => undefined);
  const reset = vi.fn();
  const dispose = vi.fn(async () => undefined);
  const download = vi.fn<DownloadFn>(async () => undefined);

  const services = {
    manager: {
      loadedModel: null,
      status: vi.fn(async () => modelStatus()),
      download,
      deleteModel: vi.fn(async () => undefined),
      ensureLoaded: vi.fn(async () => ({})),
      unload,
    },
    router: { activeEngine: null, translate: vi.fn() },
    chrome: { available: true, dispose },
    lazy: { kind: 'plamo', reset, translate: vi.fn() },
    load: vi.fn(async () => ({})),
    selection: SELECTION,
  } as unknown as EngineServices;

  return { services, unload, reset, dispose, download };
}

function installed(
  states: Partial<Record<ModelId, ModelStatus['state']>>,
): (modelId: ModelId) => Promise<ModelStatus> {
  return vi.fn(async (modelId: ModelId) =>
    modelStatus({ id: modelId, state: states[modelId] ?? 'absent' }),
  );
}

function runtimeSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'runtime-set',
    requestId: 'runtime',
    idleMinutes: 5,
    tier: 'auto',
    targetLanguage: 'ja',
    form: 'polite',
    glossary: [],
    consented: false,
    ...overrides,
  };
}

function createHost(services: EngineServices, idleReleaseMs = 60_000): EngineHost {
  return new EngineHost({ createServices: async () => services, idleReleaseMs });
}

function cacheModelIdOf(host: EngineHost): string {
  return (host as unknown as { cacheModelId: () => string }).cacheModelId();
}

function prewarmKeyOf(host: EngineHost): string | null {
  return (host as unknown as { prewarmKey: string | null }).prewarmKey;
}

function lastStatus(port: FakePort): {
  model?: { id?: string };
  modelFallback?: boolean;
  plamoReady?: boolean;
} {
  const response = port.messagesOfType('response').at(-1) as {
    value?: {
      model?: { id?: string };
      modelFallback?: boolean;
      plamoReady?: boolean;
    };
  };
  return response.value ?? {};
}

async function openRunningHost(services: EngineServices): Promise<{
  host: EngineHost;
  port: FakePort;
}> {
  const host = createHost(services);
  const port = new FakePort();
  host.handlePort(port.port);
  port.emit({ type: 'status', requestId: 's0' });
  await flushTasks();
  return { host, port };
}

function cacheRouter(
  host: EngineHost,
  cache: TranslationCache,
  inner: IdentifiedEngine,
): EngineServices['router'] {
  return {
    activeEngine: null,
    translate: (segments: readonly TranslateSegment[], options: TranslateOptions) =>
      new CachingEngine(inner, cache, () => cacheModelIdOf(host)).translate(segments, options),
  } as unknown as EngineServices['router'];
}

describe('EngineHost', () => {
  it('stops a cancelled translation without sending done', async () => {
    const { services } = createServices();
    const release = deferred<void>();
    services.router.translate = async function* () {
      yield { id: 'a', textDelta: 'こん', engine: 'plamo' };
      await release.promise;
      yield { id: 'a', final: 'こんにちは', engine: 'plamo' };
    } as never;

    const host = createHost(services);
    const port = new FakePort();
    host.handlePort(port.port);

    port.emit({
      type: 'translate',
      requestId: 'r1',
      segments: [{ id: 'a', text: 'Hello.' }],
      options: serializeTranslateOptions(options()),
    });
    await flushTasks();
    expect(port.messagesOfType('chunk')).toHaveLength(1);

    port.emit({ type: 'cancel', requestId: 'r1' });
    release.resolve();
    await flushTasks();

    expect(port.messagesOfType('chunk')).toHaveLength(1);
    expect(port.messagesOfType('done')).toHaveLength(0);
    expect(port.messagesOfType('error')).toHaveLength(0);
  });

  it('keeps the model loaded while a request is in flight', async () => {
    const { services, unload, reset } = createServices();
    const release = deferred<void>();
    services.router.translate = async function* () {
      yield { id: 'a', final: 'x', engine: 'plamo' };
      await release.promise;
    } as never;

    const host = createHost(services, 5);
    const port = new FakePort();
    host.handlePort(port.port);

    port.emit({
      type: 'translate',
      requestId: 'r1',
      segments: [{ id: 'a', text: 'Hello.' }],
      options: serializeTranslateOptions(options()),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(unload).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();

    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(reset).toHaveBeenCalled();
    expect(unload).toHaveBeenCalled();
  });

  it('attaches a second download request without starting another transfer', async () => {
    const { services, download } = createServices();
    const release = deferred<void>();
    download.mockImplementation(async () => {
      await release.promise;
    });
    const host = createHost(services);
    const first = new FakePort();
    const second = new FakePort();
    host.handlePort(first.port);
    host.handlePort(second.port);

    first.emit({ type: 'model-download', requestId: 'd1', modelId: DEFAULT_MODEL_ID });
    second.emit({ type: 'model-download', requestId: 'd2', modelId: DEFAULT_MODEL_ID });
    await flushTasks();

    expect(download).toHaveBeenCalledOnce();

    release.resolve();
    await flushTasks();
  });

  it('keeps downloading after the starting port disconnects', async () => {
    const { services, download } = createServices();
    const release = deferred<void>();
    let aborted = false;
    let progress: ((progress: DownloadProgress) => void) | null = null;

    download.mockImplementation(async (modelId, request) => {
      expect(modelId).toBe(DEFAULT_MODEL_ID);
      progress = request.onProgress ?? null;
      progress?.({
        received: 5,
        total: 10,
        ratio: 0.5,
        resumedFrom: 0,
        phase: 'download',
      });
      await new Promise<void>((resolve) => {
        request.signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
        void release.promise.then(resolve);
      });
    });

    const host = createHost(services);
    const port = new FakePort();
    host.handlePort(port.port);

    port.emit({ type: 'model-download', requestId: 'd1', modelId: DEFAULT_MODEL_ID });
    await flushTasks();
    expect(port.messagesOfType('model-progress')).toHaveLength(1);

    port.disconnect();
    release.resolve();
    await flushTasks();

    expect(aborted).toBe(false);
    expect(progress).toBeTypeOf('function');
  });

  it('ignores ports opened from a content script', async () => {
    const { services } = createServices();
    const host = createHost(services);
    const port = new FakePort({ sender: { id: 'test-extension', tab: { id: 3 } } });
    host.handlePort(port.port);

    port.emit({ type: 'status', requestId: 's1' });
    await flushTasks();

    expect(port.sent).toHaveLength(0);
  });

  it('keeps a high-accuracy selection after Use instead of reverting to Standard', async () => {
    const { services } = createServices();
    services.manager.status = vi.fn(async (modelId: ModelId) =>
      modelStatus({ id: modelId, state: 'ready' }),
    );
    const host = createHost(services);
    const port = new FakePort();
    host.handlePort(port.port);

    port.emit({ type: 'model-use', requestId: 'u1', modelId: HIGH_QUALITY_MODEL_ID });
    await flushTasks();
    port.emit({ type: 'status', requestId: 's1' });
    await flushTasks();

    const status = port.messagesOfType('response').at(-1) as {
      value?: { model?: { id?: string } };
    };
    expect(status.value?.model?.id).toBe(HIGH_QUALITY_MODEL_ID);
  });

  it('falls back to an installed model when the selected one is deleted', async () => {
    const { services } = createServices();
    const files = new Map<ModelId, ModelStatus['state']>([
      [DEFAULT_MODEL_ID, 'ready'],
      [HIGH_QUALITY_MODEL_ID, 'ready'],
    ]);
    services.manager.status = vi.fn(async (modelId: ModelId) =>
      modelStatus({ id: modelId, state: files.get(modelId) ?? 'absent' }),
    );
    services.manager.deleteModel = vi.fn(async (modelId: ModelId) => {
      files.set(modelId, 'absent');
    });
    const host = createHost(services);
    const port = new FakePort();
    host.handlePort(port.port);

    port.emit({ type: 'model-delete', requestId: 'd1', modelId: DEFAULT_MODEL_ID });
    await flushTasks();
    port.emit({ type: 'status', requestId: 's1' });
    await flushTasks();

    const status = port.messagesOfType('response').at(-1) as {
      value?: { model?: { id?: string }; modelFallback?: boolean; plamoReady?: boolean };
    };
    expect(status.value?.model?.id).toBe(HIGH_QUALITY_MODEL_ID);
    expect(status.value?.modelFallback).toBe(true);
    expect(status.value?.plamoReady).toBe(true);
    expect(port.messagesOfType('model-persist')).toEqual([
      { type: 'model-persist', modelId: HIGH_QUALITY_MODEL_ID },
    ]);
  });

  it('applies engineSource from source-set without reading chrome.storage', async () => {
    const { services } = createServices();
    const host = createHost(services);
    const port = new FakePort();
    host.handlePort(port.port);

    port.emit({
      type: 'source-set',
      requestId: 'src1',
      engineSource: 'local-server',
      localServer: {
        url: 'http://127.0.0.1:8080/v1',
        model: 'pfnet/plamo-3-translate-0.8b-MLX-4bit',
        apiKey: '',
        timeoutMs: 120_000,
        allowRemote: false,
        parallel: 4,
      },
    });
    await flushTasks();
    port.emit({ type: 'status', requestId: 's1' });
    await flushTasks();

    const status = port.messagesOfType('response').at(-1) as {
      value?: { engineSource?: string; backend?: string };
    };
    expect(status.value?.engineSource).toBe('local-server');
    expect(status.value?.backend).toBe('local-server');
  });

  it('restores a pushed model on the first status when storage is unavailable', async () => {
    const { services } = createServices();
    services.manager.status = installed({
      [DEFAULT_MODEL_ID]: 'ready',
      [HIGH_QUALITY_MODEL_ID]: 'ready',
    });
    const host = createHost(services);
    const port = new FakePort();
    host.handlePort(port.port);

    port.emit({ type: 'model-set', requestId: 'm1', modelId: HIGH_QUALITY_MODEL_ID });
    await flushTasks();
    expect(services.manager.status).not.toHaveBeenCalled();

    port.emit({ type: 'status', requestId: 's1' });
    await flushTasks();

    const status = port.messagesOfType('response').at(-1) as {
      value?: { model?: { id?: string }; modelFallback?: boolean };
    };
    expect(status.value?.model?.id).toBe(HIGH_QUALITY_MODEL_ID);
    expect(status.value?.modelFallback).toBeUndefined();
    expect(port.messagesOfType('model-persist')).toHaveLength(0);
  });

  it('switches an already open document when a saved model arrives', async () => {
    const { services, unload, reset } = createServices();
    services.manager.status = installed({
      [DEFAULT_MODEL_ID]: 'ready',
      [HIGH_QUALITY_MODEL_ID]: 'ready',
    });
    const { host, port } = await openRunningHost(services);

    port.emit({ type: 'model-set', requestId: 'm1', modelId: HIGH_QUALITY_MODEL_ID });
    await flushTasks();
    port.emit({ type: 'status', requestId: 's1' });
    await flushTasks();

    expect(lastStatus(port).model?.id).toBe(HIGH_QUALITY_MODEL_ID);
    expect(reset).toHaveBeenCalled();
    expect(unload).toHaveBeenCalled();
    expect(port.messagesOfType('model-persist')).toHaveLength(0);
    expect(cacheModelIdOf(host)).toBe(HIGH_QUALITY_MODEL_ID);
  });

  it('resets a loaded runtime when model-set changes the id, and caches the next translation under the new model', async () => {
    const { services, unload, reset } = createServices();
    services.manager.status = installed({
      [DEFAULT_MODEL_ID]: 'ready',
      [HIGH_QUALITY_MODEL_ID]: 'ready',
    });
    const cache = new TranslationCache(new MemoryTranslationCacheStore());
    const { host, port } = await openRunningHost(services);
    services.router = cacheRouter(host, cache, {
      kind: 'plamo',
      async *translate() {
        yield { id: 'a', final: 'こんにちは', engine: 'plamo' as const };
      },
    });

    port.emit({ type: 'model-set', requestId: 'm1', modelId: HIGH_QUALITY_MODEL_ID });
    await flushTasks();
    expect(reset).toHaveBeenCalled();
    expect(unload).toHaveBeenCalled();

    port.emit({
      type: 'translate',
      requestId: 't1',
      segments: [{ id: 'a', text: 'Hello.' }],
      options: serializeTranslateOptions(options()),
    });
    await flushTasks();

    expect(port.messagesOfType('done')).toHaveLength(1);
    const nextKey = buildTranslationCacheKey({
      model: HIGH_QUALITY_MODEL_ID,
      tgt: 'ja',
      form: 'polite',
      text: 'Hello.',
    });
    const previousKey = buildTranslationCacheKey({
      model: DEFAULT_MODEL_ID,
      tgt: 'ja',
      form: 'polite',
      text: 'Hello.',
    });
    expect(await cache.get(nextKey)).toEqual({ text: 'こんにちは', engine: 'plamo' });
    expect(await cache.get(previousKey)).toBeUndefined();
  });

  it('does not reload when model-set repeats the active id', async () => {
    const { services, unload, reset } = createServices();
    services.manager.status = installed({
      [DEFAULT_MODEL_ID]: 'ready',
      [HIGH_QUALITY_MODEL_ID]: 'ready',
    });
    const { port } = await openRunningHost(services);

    port.emit({ type: 'model-set', requestId: 'm1', modelId: HIGH_QUALITY_MODEL_ID });
    await flushTasks();
    reset.mockClear();
    unload.mockClear();

    port.emit({ type: 'model-set', requestId: 'm2', modelId: HIGH_QUALITY_MODEL_ID });
    await flushTasks();

    expect(reset).not.toHaveBeenCalled();
    expect(unload).not.toHaveBeenCalled();
    port.emit({ type: 'status', requestId: 's1' });
    await flushTasks();
    expect(lastStatus(port).model?.id).toBe(HIGH_QUALITY_MODEL_ID);
  });

  it('aborts an in-flight translation with an error so the client stream can finish', async () => {
    const { services, unload, reset } = createServices();
    services.manager.status = installed({
      [DEFAULT_MODEL_ID]: 'ready',
      [HIGH_QUALITY_MODEL_ID]: 'ready',
    });
    const release = deferred<void>();
    const cache = new TranslationCache(new MemoryTranslationCacheStore());
    const { host, port } = await openRunningHost(services);
    services.router = cacheRouter(host, cache, {
      kind: 'plamo',
      async *translate() {
        yield { id: 'a', textDelta: 'こん', engine: 'plamo' as const };
        await release.promise;
        yield { id: 'a', final: 'こんにちは', engine: 'plamo' as const };
      },
    });

    port.emit({
      type: 'translate',
      requestId: 't1',
      segments: [{ id: 'a', text: 'Hello.' }],
      options: serializeTranslateOptions(options()),
    });
    await flushTasks();
    expect(port.messagesOfType('chunk')).toHaveLength(1);

    port.emit({ type: 'model-set', requestId: 'm1', modelId: HIGH_QUALITY_MODEL_ID });
    await flushTasks();
    release.resolve();
    await flushTasks();

    expect(reset).toHaveBeenCalled();
    expect(unload).toHaveBeenCalled();
    expect(port.messagesOfType('error')).toEqual([
      {
        type: 'error',
        requestId: 't1',
        error: { code: 'model-changed', message: 'The selected model changed.' },
      },
    ]);
    expect(port.messagesOfType('done')).toHaveLength(0);
    expect(port.messagesOfType('chunk')).toHaveLength(1);
    const nextKey = buildTranslationCacheKey({
      model: HIGH_QUALITY_MODEL_ID,
      tgt: 'ja',
      form: 'polite',
      text: 'Hello.',
    });
    expect(await cache.get(nextKey)).toBeUndefined();
  });

  it('holds a translate retry during unload and caches it under the new model', async () => {
    const { services, unload, reset } = createServices();
    services.manager.status = installed({
      [DEFAULT_MODEL_ID]: 'ready',
      [HIGH_QUALITY_MODEL_ID]: 'ready',
    });
    const unloadHold = deferred<void>();
    let unloaded = false;
    unload.mockImplementation(async () => {
      await unloadHold.promise;
      unloaded = true;
    });
    const first = deferred<void>();
    const seen: string[] = [];
    const cache = new TranslationCache(new MemoryTranslationCacheStore());
    const { host, port } = await openRunningHost(services);
    services.router = cacheRouter(host, cache, {
      kind: 'plamo',
      async *translate() {
        const model = cacheModelIdOf(host);
        seen.push(model);
        if (seen.length === 1) {
          yield { id: 'a', textDelta: 'こん', engine: 'plamo' as const };
          await first.promise;
          return;
        }
        expect(unloaded).toBe(true);
        yield { id: 'a', final: `via:${model}`, engine: 'plamo' as const };
      },
    });

    port.emit({
      type: 'translate',
      requestId: 't1',
      segments: [{ id: 'a', text: 'Hello.' }],
      options: serializeTranslateOptions(options()),
    });
    await flushTasks();
    expect(port.messagesOfType('chunk')).toHaveLength(1);

    port.emit({ type: 'model-set', requestId: 'm1', modelId: HIGH_QUALITY_MODEL_ID });
    await flushTasks();
    expect(reset).toHaveBeenCalled();
    expect(unload).toHaveBeenCalled();
    expect(cacheModelIdOf(host)).toBe(HIGH_QUALITY_MODEL_ID);
    expect(port.messagesOfType('error')).toEqual([
      {
        type: 'error',
        requestId: 't1',
        error: { code: 'model-changed', message: 'The selected model changed.' },
      },
    ]);

    port.emit({
      type: 'translate',
      requestId: 't2',
      segments: [{ id: 'a', text: 'Hello.' }],
      options: serializeTranslateOptions(options()),
    });
    await flushTasks();
    expect(port.messagesOfType('done')).toHaveLength(0);
    expect(
      port
        .messagesOfType('chunk')
        .filter((message) => (message as { requestId?: string }).requestId === 't2'),
    ).toHaveLength(0);
    expect(seen).toEqual([DEFAULT_MODEL_ID]);

    unloadHold.resolve();
    await vi.waitFor(() => {
      expect(port.messagesOfType('done')).toEqual([{ type: 'done', requestId: 't2' }]);
    });
    first.resolve();
    await flushTasks();

    expect(seen).toEqual([DEFAULT_MODEL_ID, HIGH_QUALITY_MODEL_ID]);
    const previousKey = buildTranslationCacheKey({
      model: DEFAULT_MODEL_ID,
      tgt: 'ja',
      form: 'polite',
      text: 'Hello.',
    });
    const nextKey = buildTranslationCacheKey({
      model: HIGH_QUALITY_MODEL_ID,
      tgt: 'ja',
      form: 'polite',
      text: 'Hello.',
    });
    expect(await cache.get(previousKey)).toBeUndefined();
    expect(await cache.get(nextKey)).toEqual({
      text: `via:${HIGH_QUALITY_MODEL_ID}`,
      engine: 'plamo',
    });
  });

  it('fails an in-flight warm when model-set changes the id', async () => {
    const { services, unload, reset } = createServices();
    services.manager.status = installed({
      [DEFAULT_MODEL_ID]: 'ready',
      [HIGH_QUALITY_MODEL_ID]: 'ready',
    });
    const { port } = await openRunningHost(services);
    services.load = vi.fn(async (signal: AbortSignal) => {
      await new Promise<never>((_, reject) => {
        const fail = (): void => reject(new DOMException('aborted', 'AbortError'));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    }) as never;

    port.emit({ type: 'model-warm', requestId: 'w1' });
    await flushTasks();
    port.emit({ type: 'model-set', requestId: 'm1', modelId: HIGH_QUALITY_MODEL_ID });
    await flushTasks();

    expect(reset).toHaveBeenCalled();
    expect(unload).toHaveBeenCalled();
    expect(
      port.sent.filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          (message as { requestId?: string }).requestId === 'w1',
      ),
    ).toEqual([
      {
        type: 'response',
        requestId: 'w1',
        ok: false,
        error: { code: 'model-changed', message: 'The selected model changed.' },
      },
    ]);
  });

  it('clears a prewarm in progress when model-set changes the id', async () => {
    const { services } = createServices();
    services.manager.status = installed({
      [DEFAULT_MODEL_ID]: 'ready',
      [HIGH_QUALITY_MODEL_ID]: 'ready',
    });
    const release = deferred<void>();
    const translate = vi.fn(async function* () {
      yield { id: 'ui-0', final: 'x', engine: 'plamo' as const };
      await release.promise;
    });
    services.router.translate = translate as never;
    services.load = vi.fn(async () => ({
      id: DEFAULT_MODEL_ID,
      selection: SELECTION,
      runtime: { complete: vi.fn(async () => undefined) },
    })) as never;
    const { host, port } = await openRunningHost(services);

    port.emit(runtimeSet({ consented: true, requestId: 'runtime-on' }));
    await flushTasks();
    port.emit({ type: 'model-warm', requestId: 'w1' });
    await vi.waitFor(() => {
      expect(translate).toHaveBeenCalled();
    });
    expect(prewarmKeyOf(host)).not.toBeNull();

    port.emit({ type: 'model-set', requestId: 'm1', modelId: HIGH_QUALITY_MODEL_ID });
    await flushTasks();
    release.resolve();
    await flushTasks();

    expect(prewarmKeyOf(host)).toBeNull();
  });

  it('writes the selected model through chrome.storage and does not emit model-persist', async () => {
    const { services } = createServices();
    services.manager.status = installed({
      [DEFAULT_MODEL_ID]: 'ready',
      [HIGH_QUALITY_MODEL_ID]: 'ready',
    });
    const local = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
    };
    const mockedBrowser = browser as unknown as { storage?: { local: typeof local } };
    mockedBrowser.storage = { local };
    const saveMock = vi
      .spyOn(storage, 'saveSettings')
      .mockResolvedValue(normalizeSettings(null, 'en'));
    try {
      const host = createHost(services);
      const port = new FakePort();
      host.handlePort(port.port);

      port.emit({ type: 'model-use', requestId: 'u1', modelId: HIGH_QUALITY_MODEL_ID });
      await flushTasks();

      expect(saveMock).toHaveBeenCalledWith({ selectedModelId: HIGH_QUALITY_MODEL_ID });
      expect(port.messagesOfType('model-persist')).toHaveLength(0);
    } finally {
      saveMock.mockRestore();
      delete mockedBrowser.storage;
    }
  });

  it('does not replace the selected model when a settings change only pushes runtime-set', async () => {
    const { services } = createServices();
    services.manager.status = installed({
      [DEFAULT_MODEL_ID]: 'ready',
      [HIGH_QUALITY_MODEL_ID]: 'ready',
    });
    const { port } = await openRunningHost(services);

    port.emit({ type: 'model-set', requestId: 'm1', modelId: HIGH_QUALITY_MODEL_ID });
    await flushTasks();
    port.emit(runtimeSet({ idleMinutes: 1, requestId: 'runtime-stale' }));
    await flushTasks();
    port.emit({ type: 'status', requestId: 's1' });
    await flushTasks();

    expect(lastStatus(port).model?.id).toBe(HIGH_QUALITY_MODEL_ID);
  });

  it('persists the installed model when the saved choice is missing', async () => {
    const { services } = createServices();
    services.manager.status = installed({
      [DEFAULT_MODEL_ID]: 'absent',
      [HIGH_QUALITY_MODEL_ID]: 'ready',
    });
    const host = createHost(services);
    const port = new FakePort();
    host.handlePort(port.port);

    port.emit({ type: 'model-set', requestId: 'm1', modelId: DEFAULT_MODEL_ID });
    await flushTasks();
    port.emit({ type: 'status', requestId: 's1' });
    await flushTasks();

    const status = port.messagesOfType('response').at(-1) as {
      value?: { model?: { id?: string }; modelFallback?: boolean; plamoReady?: boolean };
    };
    expect(status.value?.model?.id).toBe(HIGH_QUALITY_MODEL_ID);
    expect(status.value?.modelFallback).toBe(true);
    expect(status.value?.plamoReady).toBe(true);
    expect(port.messagesOfType('model-persist')).toEqual([
      { type: 'model-persist', modelId: HIGH_QUALITY_MODEL_ID },
    ]);
  });

  it('does not persist a choice when no model file is installed', async () => {
    const { services } = createServices();
    services.manager.status = installed({});
    const host = createHost(services);
    const port = new FakePort();
    host.handlePort(port.port);

    port.emit({ type: 'model-set', requestId: 'm1', modelId: HIGH_QUALITY_MODEL_ID });
    await flushTasks();
    port.emit({ type: 'status', requestId: 's1' });
    await flushTasks();

    const status = port.messagesOfType('response').at(-1) as {
      value?: { model?: { id?: string }; modelFallback?: boolean };
    };
    expect(status.value?.model?.id).toBe(HIGH_QUALITY_MODEL_ID);
    expect(status.value?.modelFallback).toBeUndefined();
    expect(port.messagesOfType('model-persist')).toHaveLength(0);
  });

  it('asks the service worker to save an explicit Use', async () => {
    const { services } = createServices();
    services.manager.status = installed({
      [DEFAULT_MODEL_ID]: 'ready',
      [HIGH_QUALITY_MODEL_ID]: 'ready',
    });
    const host = createHost(services);
    const port = new FakePort();
    host.handlePort(port.port);

    port.emit({ type: 'model-use', requestId: 'u1', modelId: HIGH_QUALITY_MODEL_ID });
    await flushTasks();

    expect(port.messagesOfType('model-persist')).toEqual([
      { type: 'model-persist', modelId: HIGH_QUALITY_MODEL_ID },
    ]);
  });

  it('uses the pushed idle timeout when chrome.storage is missing', async () => {
    const { services, unload, reset } = createServices();
    services.router.translate = async function* () {
      yield { id: 'a', final: 'x', engine: 'plamo' };
    } as never;
    const host = createHost(services, 5);
    const port = new FakePort();
    host.handlePort(port.port);

    port.emit(runtimeSet({ idleMinutes: 0, requestId: 'idle' }));
    await flushTasks();
    port.emit({
      type: 'translate',
      requestId: 'r1',
      segments: [{ id: 'a', text: 'Hello.' }],
      options: serializeTranslateOptions(options()),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(reset).not.toHaveBeenCalled();
    expect(unload).not.toHaveBeenCalled();
  });

  it('prewarms from the pushed snapshot when chrome.storage is missing', async () => {
    const { services } = createServices();
    const translate = vi.fn(async function* () {
      yield { id: 'ui-0', final: 'x', engine: 'plamo' as const };
    });
    services.router.translate = translate as never;
    services.load = vi.fn(async () => ({
      id: DEFAULT_MODEL_ID,
      selection: SELECTION,
      runtime: { complete: vi.fn(async () => undefined) },
    })) as never;
    const host = createHost(services);
    const port = new FakePort();
    host.handlePort(port.port);

    port.emit(runtimeSet({ consented: false, requestId: 'runtime-off' }));
    await flushTasks();
    const responsesBeforeWarm = port.messagesOfType('response').length;
    port.emit({ type: 'model-warm', requestId: 'w1' });
    await vi.waitFor(() => {
      expect(port.messagesOfType('response').length).toBeGreaterThan(responsesBeforeWarm);
    });
    await flushTasks();
    expect(translate).not.toHaveBeenCalled();

    port.emit(
      runtimeSet({
        consented: true,
        requestId: 'runtime-on',
        glossary: [{ source: 'Runner', target: 'ランナー' }],
      }),
    );
    await flushTasks();
    port.emit({ type: 'model-warm', requestId: 'w2' });
    await vi.waitFor(() => {
      expect(translate).toHaveBeenCalled();
    });
    const warmOptions = (
      translate.mock.calls as unknown as Array<[unknown, { tgt?: string; glossary?: unknown }]>
    )[0]?.[1];
    expect(warmOptions?.tgt).toBe('ja');
    expect(warmOptions?.glossary).toEqual([{ source: 'Runner', target: 'ランナー' }]);
  });
});

describe('model load on the GPU tier', () => {
  const gpu = selectBackend({ webgpu: true, hardwareConcurrency: 8 });
  const wide = selectBackend({ webgpu: true, hardwareConcurrency: 8, fastBatches: true });
  const loaded = {} as LoadedModel;

  it('keeps the GPU when the model lands on it', async () => {
    const ensureLoaded = vi.fn(async () => loaded);
    const result = await loadWithFallback(ensureLoaded, gpu, new AbortController().signal);

    expect(result.selection).toBe(gpu);
    expect(ensureLoaded).toHaveBeenCalledTimes(1);
  });

  it('loads on the CPU tier when WebGPU will not take the model', async () => {
    const ensureLoaded = vi.fn(async (selection: BackendSelection) => {
      if (selection.backend === 'webgpu') throw new EngineError('gpu-unavailable', 'no GPU');
      return loaded;
    });
    const result = await loadWithFallback(ensureLoaded, gpu, new AbortController().signal);

    expect(result.loaded).toBe(loaded);
    expect(result.selection).toMatchObject({ backend: 'cpu-wasm', nParallel: 1, nCtx: 2048 });
    expect(ensureLoaded).toHaveBeenCalledTimes(2);
  });

  it('abandons a WebGPU load that never settles and continues on the CPU', async () => {
    const tried: Array<[string, number]> = [];
    const ensureLoaded = vi.fn((selection: BackendSelection) => {
      tried.push([selection.backend, selection.nParallel]);
      if (selection.backend === 'webgpu') return new Promise<LoadedModel>(() => undefined);
      return Promise.resolve(loaded);
    });

    const result = await loadWithFallback(ensureLoaded, gpu, new AbortController().signal, {
      webgpuTimeoutMs: 20,
    });

    expect(result.selection).toMatchObject({ backend: 'cpu-wasm', nParallel: 1 });
    expect(tried).toEqual([
      ['webgpu', 4],
      ['cpu-wasm', 1],
    ]);
  });

  it('does not start a second GPU load after gpu-unavailable', async () => {
    const tried: Array<[string, number]> = [];
    const ensureLoaded = vi.fn(async (selection: BackendSelection) => {
      tried.push([selection.backend, selection.nParallel]);
      if (selection.backend === 'webgpu') {
        throw new EngineError('gpu-unavailable', 'no GPU', {
          detail: 'ggml_webgpu: adapter lacks shader-f16; WebGPU backend disabled',
        });
      }
      return loaded;
    });
    await loadWithFallback(ensureLoaded, wide, new AbortController().signal);

    expect(tried).toEqual([
      ['webgpu', 16],
      ['cpu-wasm', 1],
    ]);
  });

  it('tries four slots before the CPU when a wide load fails', async () => {
    const tried: Array<[string, number]> = [];
    const ensureLoaded = vi.fn(async (selection: BackendSelection) => {
      tried.push([selection.backend, selection.nParallel]);
      if (selection.backend === 'webgpu') throw new EngineError('model-load-failed', 'no memory');
      return loaded;
    });
    await loadWithFallback(ensureLoaded, wide, new AbortController().signal);

    expect(tried).toEqual([
      ['webgpu', 16],
      ['webgpu', 4],
      ['webgpu', 1],
      ['cpu-wasm', 1],
    ]);
  });

  it('stops at four slots when they load', async () => {
    const ensureLoaded = vi.fn(async (selection: BackendSelection) => {
      if (selection.nParallel === 16) throw new EngineError('model-load-failed', 'no memory');
      return loaded;
    });
    const result = await loadWithFallback(ensureLoaded, wide, new AbortController().signal);

    expect(result.selection).toMatchObject({ backend: 'webgpu', nParallel: 4, nCtx: 1024 * 4 });
  });

  it('goes straight to the CPU when no adapter was found', async () => {
    const ensureLoaded = vi.fn(async (selection: BackendSelection) => {
      if (selection.backend === 'webgpu') {
        throw new EngineError('gpu-unavailable', 'no GPU', {
          detail: 'ggml_webgpu: Failed to get an adapter: no adapter after high-performance',
        });
      }
      return loaded;
    });
    await loadWithFallback(ensureLoaded, wide, new AbortController().signal);

    expect(ensureLoaded).toHaveBeenCalledTimes(2);
  });

  it('goes straight to the CPU when ggml already retried the device', async () => {
    const tried: Array<[string, number]> = [];
    const ensureLoaded = vi.fn(async (selection: BackendSelection) => {
      tried.push([selection.backend, selection.nParallel]);
      if (selection.backend === 'webgpu') {
        throw new EngineError('gpu-unavailable', 'no GPU', {
          detail: 'ggml_webgpu: Failed to get a device after retries',
        });
      }
      return loaded;
    });
    await loadWithFallback(ensureLoaded, gpu, new AbortController().signal);

    expect(tried).toEqual([
      ['webgpu', 4],
      ['cpu-wasm', 1],
    ]);
  });

  it('does not treat a degenerate warm-up as a load skip', async () => {
    // Warm-up runs after load, in handleWarm, so a collapsed Hello. must not
    // burn the remaining WebGPU slot attempts inside loadWithFallback.
    const tried: Array<[string, number]> = [];
    const ensureLoaded = vi.fn(async (selection: BackendSelection) => {
      tried.push([selection.backend, selection.nParallel]);
      if (selection.backend === 'webgpu') {
        throw new EngineError('model-load-failed', 'repeated', { detail: 'degenerate warmup' });
      }
      return loaded;
    });
    await loadWithFallback(ensureLoaded, wide, new AbortController().signal);

    expect(tried).toEqual([
      ['webgpu', 16],
      ['webgpu', 4],
      ['webgpu', 1],
      ['cpu-wasm', 1],
    ]);
  });

  it('goes straight to the CPU when the correctness probe fails', async () => {
    const tried: Array<[string, number]> = [];
    const ensureLoaded = vi.fn(async (selection: BackendSelection) => {
      tried.push([selection.backend, selection.nParallel]);
      if (selection.backend === 'webgpu') {
        throw new EngineError('model-load-failed', 'aborted', {
          detail: 'ggml_webgpu: correctness probe failed; WebGPU backend disabled',
        });
      }
      return loaded;
    });
    await loadWithFallback(ensureLoaded, wide, new AbortController().signal);

    expect(tried).toEqual([
      ['webgpu', 16],
      ['cpu-wasm', 1],
    ]);
  });

  it('goes straight to the CPU when WGSL rejected subgroups', async () => {
    const tried: Array<[string, number]> = [];
    const ensureLoaded = vi.fn(async (selection: BackendSelection) => {
      tried.push([selection.backend, selection.nParallel]);
      if (selection.backend === 'webgpu') {
        throw new EngineError('model-load-failed', 'aborted', {
          detail: "Error while parsing WGSL: extension 'subgroups' is not allowed",
        });
      }
      return loaded;
    });
    await loadWithFallback(ensureLoaded, wide, new AbortController().signal);

    expect(tried).toEqual([
      ['webgpu', 16],
      ['cpu-wasm', 1],
    ]);
  });

  it('does not retry an aborted load', async () => {
    const controller = new AbortController();
    const ensureLoaded = vi.fn(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });

    await expect(loadWithFallback(ensureLoaded, gpu, controller.signal)).rejects.toThrow();
    expect(ensureLoaded).toHaveBeenCalledTimes(1);
  });
});

describe('warmup', () => {
  it('rejects a repeated token on WebGPU and on the CPU', async () => {
    const gpu = new FakeRuntime(() => ',3'.repeat(200), 1, 'webgpu');
    gpu.fillBudget = true;
    const cpu = new FakeRuntime(() => ',3'.repeat(200));
    cpu.fillBudget = true;
    await expect(warmup(gpu, 'ja')).rejects.toMatchObject({
      code: 'gpu-unavailable',
      detail: 'degenerate warmup',
    });
    await expect(warmup(cpu, 'ja')).rejects.toMatchObject({
      code: 'model-load-failed',
      detail: 'degenerate warmup',
    });
  });

  it('accepts a short translation', async () => {
    await expect(warmup(new FakeRuntime(() => 'こんにちは。'), 'ja')).resolves.toBeUndefined();
  });
});

describe('warm-up session fallback', () => {
  it('leaves WebGPU when warm-up repeats a token', async () => {
    const gpu = new FakeRuntime(() => ',3'.repeat(200), 1, 'webgpu');
    gpu.fillBudget = true;
    const cpu = new FakeRuntime(() => 'こんにちは。');
    const { services, reset } = createServices();
    const gpuModel = {
      id: DEFAULT_MODEL_ID,
      runtime: gpu,
      selection: { ...SELECTION, backend: 'webgpu' as const, nGpuLayers: 99 },
    };
    const cpuModel = { id: DEFAULT_MODEL_ID, runtime: cpu, selection: SELECTION };
    const manager = services.manager as { loadedModel: LoadedModel | null };
    manager.loadedModel = gpuModel as LoadedModel;
    const leaveWebGpu = vi.fn(async () => {
      manager.loadedModel = cpuModel as LoadedModel;
    });
    services.leaveWebGpu = leaveWebGpu;
    services.load = vi.fn(async () => services.manager.loadedModel) as never;

    const { port } = await openRunningHost(services);
    port.emit({ type: 'model-warm', requestId: 'w1' });
    await vi.waitFor(() => {
      expect(leaveWebGpu).toHaveBeenCalledWith('degenerate');
    });
    expect(reset).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(
        port.sent.some(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            (message as { requestId?: string; ok?: boolean }).requestId === 'w1' &&
            (message as { ok?: boolean }).ok === true,
        ),
      ).toBe(true);
    });
  });
});

describe('CPU retry runtime', () => {
  it('reuses a loaded CPU runtime instead of allocating a second copy', () => {
    const runtime = new FakeRuntime(() => 'こんにちは');
    expect(
      canReuseLoadedRuntimeForRetry(
        { id: DEFAULT_MODEL_ID, runtime, selection: SELECTION },
        DEFAULT_MODEL_ID,
      ),
    ).toBe(true);
  });

  it('does not reuse a WebGPU runtime for the CPU retry', () => {
    const runtime = new FakeRuntime(() => 'こんにちは', 1, 'webgpu');
    expect(
      canReuseLoadedRuntimeForRetry(
        {
          id: DEFAULT_MODEL_ID,
          runtime,
          selection: { ...SELECTION, backend: 'webgpu', nGpuLayers: 99 },
        },
        DEFAULT_MODEL_ID,
      ),
    ).toBe(false);
  });

  it('drops the extra CPU copy after a short idle without unloading the model', async () => {
    vi.useFakeTimers();
    try {
      const { services, unload, reset } = createServices();
      const disposeRetry = vi.fn(async () => undefined);
      services.disposeRetryRuntime = disposeRetry;
      services.router.translate = async function* () {
        yield { id: 'a', final: 'x', engine: 'plamo' };
      } as never;
      const host = createHost(services, 5 * 60 * 1000);
      const port = new FakePort();
      host.handlePort(port.port);

      port.emit({ type: 'status', requestId: 's0' });
      await vi.advanceTimersByTimeAsync(0);
      port.emit({
        type: 'translate',
        requestId: 'r1',
        segments: [{ id: 'a', text: 'Hello.' }],
        options: serializeTranslateOptions(options()),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(disposeRetry).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(RETRY_RUNTIME_IDLE_MS);
      expect(disposeRetry).toHaveBeenCalled();
      expect(unload).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
