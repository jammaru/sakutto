import { describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { EngineClient } from '@/background/engine-client';
import type { OffscreenController } from '@/background/offscreen-lifecycle';
import { DEFAULT_LOCAL_SERVER_PARALLEL } from '@/engine/local-server/url';
import { DEFAULT_MODEL_ID } from '@/engine/model/catalog';
import type { TranslateOptions, TranslationChunk } from '@/engine/types';
import { normalizeSettings, SETTINGS_SCHEMA_VERSION } from '@/shared/settings';
import { loadSettings } from '@/shared/storage';
import { FakePort, flushTasks } from './support/ports';

vi.mock('wxt/browser', () => ({
  browser: { runtime: { id: 'test-extension', connect: vi.fn() } },
}));

vi.mock('@/shared/storage', () => ({
  loadSettings: vi.fn(async () => {
    throw new Error('no settings');
  }),
}));

const loadSettingsMock = vi.mocked(loadSettings);

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

  it('pushes source-set from a pre-upgrade stored record before other host messages', async () => {
    loadSettingsMock.mockResolvedValue(upgradedLocalServerSettings());
    try {
      const port = new FakePort();
      connect.mockReturnValue(port.port);
      const client = new EngineClient(controller());
      const pending = client.status();

      const source = await waitForMessage<{
        requestId: string;
        engineSource: string;
        localServer: { parallel: number };
      }>(port, 'source-set');
      expect(source.engineSource).toBe('local-server');
      expect(source.localServer.parallel).toBe(DEFAULT_LOCAL_SERVER_PARALLEL);
      expect(port.messagesOfType('status')).toHaveLength(0);
      port.emit({ type: 'response', requestId: source.requestId, ok: true, value: null });

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
      await pending;
    } finally {
      loadSettingsMock.mockReset();
      loadSettingsMock.mockRejectedValue(new Error('no settings'));
    }
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
    },
    'en',
  );
}

async function waitForMessage<T>(port: FakePort, type: string): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const message = port.messagesOfType(type)[0];
    if (message) return message as T;
    await flushTasks();
  }
  throw new Error(`Timed out waiting for a ${type} host message.`);
}
