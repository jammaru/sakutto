import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_ID, type ModelId } from '@/engine/model/catalog';
import type { DownloadProgress } from '@/engine/model/download';
import type { BackendSelection } from '@/engine/in-browser/backend';
import { EngineError } from '@/engine/errors';
import { selectBackend } from '@/engine/in-browser/backend';
import { EngineHost, loadWithCpuFallback, type EngineServices } from '@/engine/offscreen/host';
import type { LoadedModel } from '@/engine/model/manager';
import type { ModelStatus } from '@/shared/engine-status';
import type { TranslateOptions } from '@/engine/types';
import { serializeTranslateOptions } from '@/engine/offscreen/protocol';
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

function createHost(services: EngineServices, idleReleaseMs = 60_000): EngineHost {
  return new EngineHost({ createServices: async () => services, idleReleaseMs });
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
});

describe('model load on the GPU tier', () => {
  const gpu = selectBackend({ webgpu: true, hardwareConcurrency: 8 });
  const loaded = {} as LoadedModel;

  it('keeps the GPU when the model lands on it', async () => {
    const ensureLoaded = vi.fn(async () => loaded);
    const result = await loadWithCpuFallback(ensureLoaded, gpu, new AbortController().signal);

    expect(result.selection).toBe(gpu);
    expect(ensureLoaded).toHaveBeenCalledTimes(1);
  });

  it('loads on the CPU tier when WebGPU will not take the model', async () => {
    const ensureLoaded = vi.fn(async (selection: BackendSelection) => {
      if (selection.backend === 'webgpu') throw new EngineError('gpu-unavailable', 'no GPU');
      return loaded;
    });
    const result = await loadWithCpuFallback(ensureLoaded, gpu, new AbortController().signal);

    expect(result.loaded).toBe(loaded);
    expect(result.selection).toMatchObject({ backend: 'cpu-wasm', nParallel: 1, nCtx: 2048 });
  });

  it('does not retry an aborted load', async () => {
    const controller = new AbortController();
    const ensureLoaded = vi.fn(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });

    await expect(loadWithCpuFallback(ensureLoaded, gpu, controller.signal)).rejects.toThrow();
    expect(ensureLoaded).toHaveBeenCalledTimes(1);
  });
});
