import { describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { EngineClient } from '@/background/engine-client';
import type { OffscreenController } from '@/background/offscreen-lifecycle';
import { DEFAULT_LOCAL_SERVER_PARALLEL } from '@/engine/local-server/url';
import { DEFAULT_MODEL_ID, HIGH_QUALITY_MODEL_ID } from '@/engine/model/catalog';
import type { TranslateOptions, TranslationChunk } from '@/engine/types';
import { normalizeSettings, SETTINGS_SCHEMA_VERSION } from '@/shared/settings';
import { loadSettings, saveSettings } from '@/shared/storage';
import { FakePort, flushTasks } from './support/ports';

vi.mock('wxt/browser', () => ({
  browser: { runtime: { id: 'test-extension', connect: vi.fn() } },
}));

vi.mock('@/shared/storage', () => ({
  loadSettings: vi.fn(async () => {
    throw new Error('no settings');
  }),
  saveSettings: vi.fn(async () => undefined),
}));

const loadSettingsMock = vi.mocked(loadSettings);
const saveSettingsMock = vi.mocked(saveSettings);

const connect = vi.mocked(browser.runtime.connect);

function options(signal = new AbortController().signal): TranslateOptions {
  return { tgt: 'ja', form: 'polite', priority: 10, signal };
}

function controller(): OffscreenController {
  return {
    ensure: vi.fn(async () => undefined),
    recreate: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as OffscreenController;
}

describe('EngineClient', () => {
  it('fails every open stream when the host port disconnects', async () => {
    const port = new FakePort();
    connect.mockReturnValue(port.port);
    const client = new EngineClient(controller());

    const iterator = client
      .translate([{ id: 'a', text: 'Hello.' }], options())
      [Symbol.asyncIterator]();
    const first = iterator.next();
    await flushTasks();
    expect(port.messagesOfType('translate')).toHaveLength(1);

    port.disconnect();

    await expect(first).rejects.toMatchObject({ code: 'offscreen-unavailable' });
  });

  it('recreates the offscreen document once after a request times out', async () => {
    vi.useFakeTimers();
    try {
      const port = new FakePort();
      connect.mockReturnValue(port.port);
      const offscreen = controller();
      const client = new EngineClient(offscreen);

      const pending = client.status();
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'offscreen-unavailable',
      });
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(offscreen.recreate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps chunk provenance from the host', async () => {
    const port = new FakePort();
    connect.mockReturnValue(port.port);
    const client = new EngineClient(controller());
    const chunks: TranslationChunk[] = [];

    const pending = (async () => {
      for await (const chunk of client.translate([{ id: 'a', text: 'Hello.' }], options())) {
        chunks.push(chunk);
      }
    })();
    await flushTasks();

    port.emit({
      type: 'chunk',
      requestId: (port.messagesOfType('translate')[0] as { requestId: string }).requestId,
      chunk: { id: 'a', final: 'こんにちは', engine: 'chrome' },
    });
    port.emit({
      type: 'done',
      requestId: (port.messagesOfType('translate')[0] as { requestId: string }).requestId,
    });
    await pending;

    expect(chunks).toEqual([{ id: 'a', final: 'こんにちは', engine: 'chrome' }]);
  });

  it('ends the translate generator when the host aborts for a model change', async () => {
    const port = new FakePort();
    connect.mockReturnValue(port.port);
    const client = new EngineClient(controller());
    const pending = (async () => {
      const chunks: TranslationChunk[] = [];
      for await (const chunk of client.translate([{ id: 'a', text: 'Hello.' }], options())) {
        chunks.push(chunk);
      }
      return chunks;
    })();
    await flushTasks();

    const requestId = (port.messagesOfType('translate')[0] as { requestId: string }).requestId;
    port.emit({
      type: 'chunk',
      requestId,
      chunk: { id: 'a', textDelta: 'こん', engine: 'plamo' },
    });
    port.emit({
      type: 'error',
      requestId,
      error: { code: 'model-changed', message: 'The selected model changed.' },
    });

    await expect(pending).rejects.toMatchObject({ code: 'model-changed' });
  });

  it('posts translate before model-set finishes, and a host abort ends that stream', async () => {
    loadSettingsMock.mockResolvedValue(upgradedLocalServerSettings());
    try {
      const port = new FakePort();
      connect.mockReturnValue(port.port);
      const client = new EngineClient(controller());
      const statusPending = client.status();

      const source = await waitForMessage<{ requestId: string }>(port, 'source-set');
      port.emit({ type: 'response', requestId: source.requestId, ok: true, value: null });
      const runtime = await waitForMessage<{ requestId: string }>(port, 'runtime-set');
      port.emit({ type: 'response', requestId: runtime.requestId, ok: true, value: null });
      const model = await waitForMessage<{ requestId: string }>(port, 'model-set');

      const pending = client.translate([{ id: 'a', text: 'Hello.' }], options()).next();
      await flushTasks();
      expect(port.messagesOfType('status')).toHaveLength(0);
      const translate = await waitForMessage<{ requestId: string }>(port, 'translate');

      port.emit({
        type: 'error',
        requestId: translate.requestId,
        error: { code: 'model-changed', message: 'The selected model changed.' },
      });
      await expect(pending).rejects.toMatchObject({ code: 'model-changed' });

      port.emit({ type: 'response', requestId: model.requestId, ok: true, value: null });
      const status = await waitForMessage<{ requestId: string }>(port, 'status');
      port.emit({
        type: 'response',
        requestId: status.requestId,
        ok: true,
        value: {
          model: {
            id: HIGH_QUALITY_MODEL_ID,
            state: 'ready',
            received: 1,
            total: 1,
            progress: 1,
          },
          backend: 'local-server',
          tier: null,
          threads: 1,
          parallel: DEFAULT_LOCAL_SERVER_PARALLEL,
          plamoReady: true,
          chromeSupported: false,
          active: null,
          engineSource: 'local-server',
        },
      });
      await statusPending;
    } finally {
      loadSettingsMock.mockReset();
      loadSettingsMock.mockRejectedValue(new Error('no settings'));
    }
  });

  it('pushes source-set from a pre-upgrade stored record before other host messages', async () => {
    loadSettingsMock.mockResolvedValue(upgradedLocalServerSettings());
    try {
      const port = new FakePort();
      connect.mockReturnValue(port.port);
      const client = new EngineClient(controller());
      const pending = client.status();

      const pushed = await acceptStoredPush(port);
      expect(pushed['source-set']).toMatchObject({
        engineSource: 'local-server',
        localServer: { parallel: DEFAULT_LOCAL_SERVER_PARALLEL },
      });
      expect(pushed['model-set']).toMatchObject({ modelId: HIGH_QUALITY_MODEL_ID });
      expect(pushed['runtime-set']).toMatchObject({
        idleMinutes: 1,
        tier: 'c4',
        targetLanguage: 'en',
        consented: false,
      });

      const status = await waitForMessage<{ requestId: string }>(port, 'status');
      port.emit({
        type: 'response',
        requestId: status.requestId,
        ok: true,
        value: {
          model: {
            id: DEFAULT_MODEL_ID,
            state: 'ready',
            received: 1,
            total: 1,
            progress: 1,
          },
          backend: 'local-server',
          tier: null,
          threads: 1,
          parallel: DEFAULT_LOCAL_SERVER_PARALLEL,
          plamoReady: true,
          chromeSupported: false,
          active: null,
          engineSource: 'local-server',
        },
      });

      await expect(pending).resolves.toMatchObject({
        backend: 'local-server',
        engineSource: 'local-server',
      });
    } finally {
      loadSettingsMock.mockReset();
      loadSettingsMock.mockRejectedValue(new Error('no settings'));
    }
  });

  it('closes a leftover offscreen document when booting a stored local-server source', async () => {
    loadSettingsMock.mockResolvedValue(upgradedLocalServerSettings());
    try {
      const port = new FakePort();
      connect.mockReturnValue(port.port);
      const offscreen = controller();
      const client = new EngineClient(offscreen);
      const pending = client.bootSource();

      const source = await waitForMessage<{ requestId: string }>(port, 'source-set');
      expect(offscreen.close).toHaveBeenCalled();
      port.emit({ type: 'response', requestId: source.requestId, ok: true, value: null });
      const runtime = await waitForMessage<{ requestId: string }>(port, 'runtime-set');
      port.emit({ type: 'response', requestId: runtime.requestId, ok: true, value: null });
      const model = await waitForMessage<{ requestId: string; modelId: string }>(port, 'model-set');
      expect(model.modelId).toBe(HIGH_QUALITY_MODEL_ID);
      port.emit({ type: 'response', requestId: model.requestId, ok: true, value: null });
      await pending;
    } finally {
      loadSettingsMock.mockReset();
      loadSettingsMock.mockRejectedValue(new Error('no settings'));
    }
  });

  it('does not push a stale selected model when a settings change only sends runtime-set', async () => {
    loadSettingsMock.mockResolvedValue(upgradedLocalServerSettings());
    try {
      const port = new FakePort();
      connect.mockReturnValue(port.port);
      const client = new EngineClient(controller());
      const pending = client.status();

      const pushed = await acceptStoredPush(port);
      expect(pushed['model-set']).toMatchObject({ modelId: HIGH_QUALITY_MODEL_ID });

      const status = await waitForMessage<{ requestId: string }>(port, 'status');
      port.emit({
        type: 'response',
        requestId: status.requestId,
        ok: true,
        value: {
          model: {
            id: HIGH_QUALITY_MODEL_ID,
            state: 'ready',
            received: 1,
            total: 1,
            progress: 1,
          },
          backend: 'local-server',
          tier: null,
          threads: 1,
          parallel: DEFAULT_LOCAL_SERVER_PARALLEL,
          plamoReady: true,
          chromeSupported: false,
          active: null,
          engineSource: 'local-server',
        },
      });
      await pending;

      const modelSetsBefore = port.messagesOfType('model-set').length;
      const runtimeSetsBefore = port.messagesOfType('runtime-set').length;
      client.syncStoredSettings({
        ...upgradedLocalServerSettings(),
        selectedModelId: DEFAULT_MODEL_ID,
        idleMinutes: 0,
      });
      await flushTasks();

      const runtime = port.messagesOfType('runtime-set').at(-1) as
        { requestId?: string; idleMinutes?: number } | undefined;
      expect(port.messagesOfType('runtime-set').length).toBeGreaterThan(runtimeSetsBefore);
      expect(runtime?.idleMinutes).toBe(0);
      expect(port.messagesOfType('model-set')).toHaveLength(modelSetsBefore);
      if (runtime?.requestId) {
        port.emit({ type: 'response', requestId: runtime.requestId, ok: true, value: null });
      }
    } finally {
      loadSettingsMock.mockReset();
      loadSettingsMock.mockRejectedValue(new Error('no settings'));
    }
  });

  it('saves a model-persist event before resolving the host response that follows it', async () => {
    let releaseSave: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    saveSettingsMock.mockImplementation(() => gate.then(() => normalizeSettings(null, 'en')));

    const port = new FakePort();
    connect.mockReturnValue(port.port);
    const client = new EngineClient(controller());
    const pending = client.status();
    await flushTasks();

    const status = await waitForMessage<{ requestId: string }>(port, 'status');
    port.emit({ type: 'model-persist', modelId: HIGH_QUALITY_MODEL_ID });
    port.emit({
      type: 'response',
      requestId: status.requestId,
      ok: true,
      value: {
        model: {
          id: HIGH_QUALITY_MODEL_ID,
          state: 'ready',
          received: 1,
          total: 1,
          progress: 1,
        },
        backend: 'cpu-wasm',
        tier: 'c8',
        threads: 8,
        parallel: 1,
        plamoReady: true,
        chromeSupported: false,
        active: null,
        engineSource: 'in-browser',
      },
    });

    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flushTasks();
    expect(settled).toBe(false);
    expect(saveSettingsMock).toHaveBeenCalledWith({ selectedModelId: HIGH_QUALITY_MODEL_ID });

    releaseSave();
    await expect(pending).resolves.toMatchObject({
      model: { id: HIGH_QUALITY_MODEL_ID },
    });
  });
});

function upgradedLocalServerSettings() {
  return normalizeSettings(
    {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      targetLanguage: 'en',
      engineSource: 'local-server',
      localServerUrl: 'http://127.0.0.1:8080/v1',
      localServerModel: 'pfnet/plamo-3-translate-0.8b-MLX-4bit',
      selectedModelId: HIGH_QUALITY_MODEL_ID,
      idleMinutes: 1,
      tier: 'c4',
    },
    'en',
  );
}

async function acceptStoredPush(
  port: FakePort,
): Promise<Record<string, { requestId: string } & Record<string, unknown>>> {
  const accepted: Record<string, { requestId: string } & Record<string, unknown>> = {};
  for (const type of ['source-set', 'runtime-set', 'model-set']) {
    const message = await waitForMessage<{ requestId: string } & Record<string, unknown>>(
      port,
      type,
    );
    accepted[type] = message;
    if (type === 'model-set') expect(port.messagesOfType('status')).toHaveLength(0);
    port.emit({ type: 'response', requestId: message.requestId, ok: true, value: null });
  }
  return accepted;
}

async function waitForMessage<T>(port: FakePort, type: string): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const message = port.messagesOfType(type)[0];
    if (message) return message as T;
    await flushTasks();
  }
  throw new Error(`Timed out waiting for a ${type} host message.`);
}
