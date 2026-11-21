import { describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { EngineClient } from '@/background/engine-client';
import { ModelDownloads } from '@/background/model-downloads';
import type { OffscreenController } from '@/background/offscreen-lifecycle';
import type { BackendSelection } from '@/engine/in-browser/backend';
import { DEFAULT_MODEL_ID, type ModelId } from '@/engine/model/catalog';
import type { DownloadProgress } from '@/engine/model/download';
import { EngineHost, type EngineServices } from '@/engine/offscreen/host';
import type { ModelStatus } from '@/shared/engine-status';
import { FakePort, deferred, flushTasks } from './support/ports';

vi.mock('wxt/browser', () => ({
  browser: { runtime: { id: 'test-extension', connect: vi.fn() } },
}));

vi.mock('@/shared/storage', () => ({
  loadSettings: vi.fn(async () => {
    throw new Error('no settings');
  }),
  saveSettings: vi.fn(async () => undefined),
}));

const SELECTION: BackendSelection = {
  tier: 'c8',
  backend: 'cpu-wasm',
  nGpuLayers: 0,
  nThreads: 8,
  nParallel: 1,
  nCtx: 2048,
};

type DownloadFn = (
  modelId: ModelId,
  options: { signal: AbortSignal; onProgress?: (progress: DownloadProgress) => void },
) => Promise<void>;

type StatusFn = (modelId: ModelId, options?: { signal?: AbortSignal }) => Promise<ModelStatus>;

function status(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: DEFAULT_MODEL_ID,
    state: 'partial',
    received: 0,
    total: 100,
    progress: 0,
    ...overrides,
  };
}

function createStack(handlers: { download: DownloadFn; status: StatusFn }) {
  const cancel = vi.fn();
  const services = {
    manager: {
      loadedModel: null,
      status: vi.fn(handlers.status),
      download: vi.fn(handlers.download),
      cancel,
      deleteModel: vi.fn(async () => undefined),
      ensureLoaded: vi.fn(async () => ({})),
      unload: vi.fn(async () => undefined),
    },
    router: { activeEngine: null, translate: vi.fn() },
    chrome: { available: true, dispose: vi.fn(async () => undefined) },
    lazy: { kind: 'plamo', reset: vi.fn(), translate: vi.fn() },
    load: vi.fn(async () => ({})),
    selection: SELECTION,
    disposeRetryRuntime: vi.fn(async () => undefined),
  } as unknown as EngineServices;
  const host = new EngineHost({ createServices: async () => services, idleReleaseMs: 60_000 });
  const hostSide = new FakePort();
  const clientSide = new FakePort();
  const outgoing: unknown[] = [];
  hostSide.postMessage = (message: unknown): void => clientSide.emit(message);
  clientSide.postMessage = (message: unknown): void => {
    outgoing.push(message);
    hostSide.emit(message);
  };
  host.handlePort(hostSide.port);
  vi.mocked(browser.runtime.connect).mockReturnValue(clientSide.port);

  const offscreen = {
    ensure: vi.fn(async () => undefined),
    recreate: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as OffscreenController;
  const client = new EngineClient(offscreen);
  const broadcasts: ModelStatus[] = [];
  const downloads = new ModelDownloads(client, async (message) => {
    broadcasts.push(message.status);
  });
  return { services, cancel, hostSide, outgoing, downloads, broadcasts };
}

function progress(received: number): DownloadProgress {
  return { received, total: 100, ratio: received / 100, resumedFrom: 0, phase: 'download' };
}

describe('ModelDownloads cross-layer lifecycle', () => {
  it('reattaches and cancels a live host download with an empty worker map', async () => {
    let liveSignal: AbortSignal | undefined;
    const stack = createStack({
      status: async () => status(),
      download: async (_modelId, options) => {
        liveSignal = options.signal;
        options.onProgress?.(progress(40));
        await new Promise<void>((resolve) => {
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });

    // This request belongs to the previous service worker. The new coordinator starts empty.
    stack.hostSide.emit({
      type: 'model-download',
      requestId: 'previous-worker',
      modelId: DEFAULT_MODEL_ID,
    });
    await flushTasks();
    expect(liveSignal?.aborted).toBe(false);

    await expect(stack.downloads.attach(DEFAULT_MODEL_ID)).resolves.toMatchObject({
      state: 'downloading',
      received: 40,
    });
    await stack.downloads.cancel(DEFAULT_MODEL_ID);

    expect(liveSignal?.aborted).toBe(true);
    expect(stack.cancel).toHaveBeenCalledWith(DEFAULT_MODEL_ID);
    expect(stack.broadcasts.at(-1)).toMatchObject({ state: 'partial', received: 40 });
    expect(stack.services.manager.download).toHaveBeenCalledOnce();
  });

  it('returns an immediate status when attaching before the first progress chunk', async () => {
    const downloadStarted = deferred<void>();
    const stack = createStack({
      status: async () => status({ received: 25, progress: 0.25 }),
      download: async (_modelId, options) => {
        downloadStarted.resolve();
        await new Promise<void>((resolve) => {
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    stack.downloads.start(DEFAULT_MODEL_ID);
    await downloadStarted.promise;

    await expect(stack.downloads.attach(DEFAULT_MODEL_ID)).resolves.toMatchObject({
      state: 'downloading',
      received: 25,
      progress: 0.25,
    });
    expect(
      stack.outgoing.filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'model-download',
      ),
    ).toHaveLength(1);
    await stack.downloads.cancel(DEFAULT_MODEL_ID);
  });

  it('ignores a late attach-only result and preserves the immediate Resume controller', async () => {
    const statusStarted = deferred<void>();
    const lateStatus = deferred<ModelStatus>();
    const resumeStarted = deferred<void>();
    let attachSignal: AbortSignal | undefined;
    let resumeSignal: AbortSignal | undefined;
    let resumeProgress: ((value: DownloadProgress) => void) | undefined;
    const stack = createStack({
      status: async (_modelId, options) => {
        if (!options?.signal) return status();
        attachSignal = options.signal;
        statusStarted.resolve();
        return lateStatus.promise;
      },
      download: async (_modelId, options) => {
        resumeSignal = options.signal;
        resumeProgress = options.onProgress;
        resumeStarted.resolve();
        await new Promise<void>((resolve) => {
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });

    const attached = stack.downloads.attach(DEFAULT_MODEL_ID);
    await statusStarted.promise;
    const cancelled = stack.downloads.cancel(DEFAULT_MODEL_ID);
    stack.downloads.start(DEFAULT_MODEL_ID);
    await cancelled;
    await resumeStarted.promise;
    await expect(attached).resolves.toBeNull();
    expect(attachSignal?.aborted).toBe(true);

    lateStatus.resolve(status({ state: 'verifying', received: 100, progress: 0 }));
    await flushTasks();
    expect(stack.broadcasts).not.toContainEqual(expect.objectContaining({ state: 'verifying' }));

    resumeProgress?.(progress(60));
    await expect(stack.downloads.attach(DEFAULT_MODEL_ID)).resolves.toMatchObject({
      state: 'downloading',
      received: 60,
    });
    expect(
      stack.outgoing.filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'model-download',
      ),
    ).toHaveLength(2);

    await stack.downloads.cancel(DEFAULT_MODEL_ID);
    expect(resumeSignal?.aborted).toBe(true);
    expect(stack.services.manager.download).toHaveBeenCalledOnce();
  });
});
