import { describe, expect, it, vi } from 'vitest';
import { AssetManager } from '@/engine/model/asset-manager';
import { OcrHost, type OcrRuntimeLike } from '@/engine/ocr/host';
import type { OcrTier } from '@/engine/ocr/catalog';
import { sha256Hex } from '@/engine/model/sha256';
import { MemoryFileStore, bytesOf } from './support/fakes';

const empty = {
  id: 'empty',
  size: 1,
  files: [
    {
      path: 'model.onnx',
      commit: 'pin',
      size: 1,
      sha256: '0'.repeat(64),
      url: 'https://example.test/model.onnx',
    },
  ],
} as const;
const bundles = { standard: { ...empty, id: 'standard' }, high: { ...empty, id: 'high' } } as const;

function assetsFor(store: MemoryFileStore = new MemoryFileStore()): AssetManager<OcrTier> {
  return new AssetManager<OcrTier>({ store, bundles });
}

function assets(): AssetManager<OcrTier> {
  return assetsFor();
}

const image = { width: 1, height: 1, data: new Uint8ClampedArray(4) };

describe('OcrHost', () => {
  it('stays lazy until recognition and caches the selected runtime', async () => {
    const manager = assets();
    const createAssetManager = vi.fn(async () => manager);
    const result = { text: '認識', lines: [], regions: [] };
    const runtime: OcrRuntimeLike = {
      recognize: vi.fn(async () => result),
      release: vi.fn(),
    };
    const createRuntime = vi.fn(async () => runtime);
    const host = new OcrHost({ createAssetManager, createRuntime });
    expect(createAssetManager).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();

    await expect(host.recognize('one', 'standard', image)).resolves.toBe(result);
    await expect(host.recognize('two', 'standard', image)).resolves.toBe(result);
    expect(createAssetManager).toHaveBeenCalledOnce();
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(await host.status('standard')).toMatchObject({ state: 'loaded' });
  });

  it('maps cancellation to an engine abort and deletes only after inference settles', async () => {
    const manager = assets();
    let finished = false;
    const runtime: OcrRuntimeLike = {
      recognize: (_image, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            finished = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
      release: vi.fn(async () => {
        expect(finished).toBe(true);
      }),
    };
    const host = new OcrHost({
      createAssetManager: async () => manager,
      createRuntime: async () => runtime,
    });
    const pending = host.recognize('cancel-me', 'standard', image);
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.cancel('cancel-me');
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await host.delete('standard');
    expect(runtime.release).toHaveBeenCalledOnce();
    expect(await host.status('standard')).toMatchObject({ state: 'absent' });
  });

  it('serializes independent same-tier callers without aborting either request', async () => {
    const manager = assets();
    const signals: AbortSignal[] = [];
    const runtime: OcrRuntimeLike = {
      recognize: async (_image, signal) => {
        signals.push(signal);
        return { text: 'ok', lines: [], regions: [] };
      },
      release: vi.fn(),
    };
    const host = new OcrHost({
      createAssetManager: async () => manager,
      createRuntime: async () => runtime,
    });

    const first = host.recognize('reader-a', 'standard', image);
    const second = host.recognize('reader-b', 'standard', image);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });

  it('keeps a replacement registered when the aborted request cleans up late', async () => {
    const manager = assets();
    const signals: AbortSignal[] = [];
    const runtime: OcrRuntimeLike = {
      recognize: (_image, signal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
      release: vi.fn(),
    };
    const host = new OcrHost({
      createAssetManager: async () => manager,
      createRuntime: async () => runtime,
    });

    const first = host.recognize('same-id', 'standard', image);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const second = host.recognize('same-id', 'standard', image);
    await expect(first).rejects.toMatchObject({ code: 'aborted' });
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    host.cancel('same-id');
    await expect(second).rejects.toMatchObject({ code: 'aborted' });
  });

  it('defers a folder-change refresh until an in-flight download settles', async () => {
    const browser = new MemoryFileStore();
    const folder = new MemoryFileStore();
    const payload = bytesOf('bundle bytes');
    const file = {
      path: 'model.onnx',
      commit: 'pinned-commit',
      size: payload.length,
      sha256: sha256Hex(payload),
      url: 'https://example.test/model.onnx',
    };
    const downloadBundles = {
      standard: { id: 'standard', files: [file], size: payload.length },
      high: { id: 'high', files: [file], size: payload.length },
    } as const;

    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gateOpen = false;

    function managerFor(store: MemoryFileStore): AssetManager<OcrTier> {
      return new AssetManager<OcrTier>({
        store,
        bundles: downloadBundles,
        fetchImpl: async () => {
          if (!gateOpen) {
            fetchStarted();
            await gate;
          }
          return new Response(new Uint8Array(payload), { status: 200 });
        },
        hashBlob: async (blob) => sha256Hex(new Uint8Array(await blob.arrayBuffer())),
      });
    }

    let storeCall = 0;
    const createAssetManager = vi.fn(async () => managerFor(storeCall++ === 0 ? browser : folder));
    const host = new OcrHost({ createAssetManager });

    // Start the download against browser storage, then adopt a shared folder mid-flight.
    const downloading = host.download('in-flight', 'standard');
    await started;
    expect([...browser.files.keys()]).toEqual([]);

    const refreshing = host.refreshStore();
    let refreshApplied = false;
    void refreshing.then(() => {
      refreshApplied = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshApplied).toBe(false);
    expect(createAssetManager).toHaveBeenCalledTimes(1);

    // Let the ranged transfer finish on its original store; the refresh must then be applied
    // before refreshStore() resolves, so no stale OPFS manager survives the folder switch.
    gateOpen = true;
    release();
    await expect(downloading).resolves.toMatchObject({ state: 'ready' });
    await refreshing;
    expect(refreshApplied).toBe(true);
    expect([...browser.files.keys()]).toContain('models/ocr-standard/model.onnx');
    // The verified bundle follows the folder. A plain reload keeps the browser copy.
    expect([...folder.files.keys()]).toContain('models/ocr-standard/model.onnx');
    expect([...folder.files.keys()]).toContain('models/ocr-standard/asset.json');

    // A later load re-resolves storage and serves the migrated bundle without re-downloading.
    await host.download('after-adopt', 'standard');
    expect(createAssetManager).toHaveBeenCalledTimes(3);
    expect(await host.status('standard')).toMatchObject({ state: 'ready' });
  });

  it('defers a folder-change refresh until an in-flight recognition settles', async () => {
    const browser = new MemoryFileStore();
    const folder = new MemoryFileStore();
    let recognizeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      recognizeStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime: OcrRuntimeLike = {
      recognize: async () => {
        recognizeStarted();
        await gate;
        return { text: 'ok' };
      },
      release: vi.fn(),
    };
    let storeCall = 0;
    const createAssetManager = vi.fn(async () => assetsFor(storeCall++ === 0 ? browser : folder));
    const host = new OcrHost({ createAssetManager, createRuntime: async () => runtime });

    const recognizing = host.recognize('in-flight', 'standard', image);
    await started;
    const refreshing = host.refreshStore();
    let refreshApplied = false;
    void refreshing.then(() => {
      refreshApplied = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshApplied).toBe(false);
    expect(runtime.release).not.toHaveBeenCalled();

    release();
    await expect(recognizing).resolves.toMatchObject({ text: 'ok' });
    await refreshing;
    expect(runtime.release).toHaveBeenCalledOnce();
    expect(await host.status('standard')).toMatchObject({ state: 'absent' });
    // One manager for the original store, one to migrate into, one for the next status call.
    expect(createAssetManager).toHaveBeenCalledTimes(3);
  });

  function bundleStorePair() {
    const browser = new MemoryFileStore();
    const folder = new MemoryFileStore();
    const payload = bytesOf('bundle bytes');
    const file = {
      path: 'model.onnx',
      commit: 'pinned-commit',
      size: payload.length,
      sha256: sha256Hex(payload),
      url: 'https://example.test/model.onnx',
    };
    const bundles = {
      standard: { id: 'standard', files: [file], size: payload.length },
      high: { id: 'high', files: [file], size: payload.length },
    } as const;
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(payload), { status: 200 }));
    return {
      browser,
      folder,
      payload,
      fetchImpl,
      managerFor: (store: MemoryFileStore) =>
        new AssetManager<OcrTier>({
          store,
          bundles,
          fetchImpl,
          hashBlob: async (blob) => sha256Hex(new Uint8Array(await blob.arrayBuffer())),
        }),
    };
  }

  it('moves verified OCR bundles into an adopted folder and deletes the browser tier', async () => {
    const { browser, folder, fetchImpl, managerFor } = bundleStorePair();
    const browserManager = managerFor(browser);
    const folderManager = managerFor(folder);
    let call = 0;
    const host = new OcrHost({
      createAssetManager: async () => (call++ === 0 ? browserManager : folderManager),
    });

    await host.download('install', 'standard');
    expect([...browser.files.keys()]).toContain('models/ocr-standard/model.onnx');

    await host.refreshStore({ removeSource: true });

    expect(
      [...browser.files.keys()].filter((path) => path.startsWith('models/ocr-standard/')),
    ).toEqual([]);
    expect([...folder.files.keys()].sort()).toEqual([
      'models/ocr-standard/asset.json',
      'models/ocr-standard/model.onnx',
    ]);
    expect(await folderManager.status('standard')).toMatchObject({ state: 'ready', progress: 1 });
    expect(await (await folderManager.readFile('standard', 'model.onnx')).text()).toBe(
      'bundle bytes',
    );
    expect(await host.status('standard')).toMatchObject({ state: 'ready' });

    const fetches = fetchImpl.mock.calls.length;
    await host.download('after-move', 'standard');
    expect(fetchImpl).toHaveBeenCalledTimes(fetches);
  });

  it('copies verified folder bundles back to browser storage without deleting folder files', async () => {
    const { browser, folder, managerFor } = bundleStorePair();
    const folderManager = managerFor(folder);
    const browserManager = managerFor(browser);
    let call = 0;
    const host = new OcrHost({
      createAssetManager: async () => (call++ === 0 ? folderManager : browserManager),
    });

    await host.download('install', 'standard');
    await host.refreshStore();

    expect([...browser.files.keys()].sort()).toEqual([
      'models/ocr-standard/asset.json',
      'models/ocr-standard/model.onnx',
    ]);
    expect([...folder.files.keys()]).toContain('models/ocr-standard/model.onnx');
    expect(await browserManager.status('standard')).toMatchObject({ state: 'ready', progress: 1 });
    expect(await host.status('standard')).toMatchObject({ state: 'ready' });
  });

  it('keeps the browser bundle when a move cannot verify its folder copy', async () => {
    const { browser, folder, managerFor } = bundleStorePair();
    const browserManager = managerFor(browser);
    const folderManager = managerFor(folder);
    let call = 0;
    const host = new OcrHost({
      createAssetManager: async () => (call++ === 0 ? browserManager : folderManager),
    });
    await host.download('install', 'standard');

    vi.spyOn(folder, 'createWriter').mockRejectedValue(new Error('no space'));
    await expect(host.refreshStore({ removeSource: true })).resolves.toBeUndefined();

    expect([...browser.files.keys()]).toContain('models/ocr-standard/model.onnx');
    expect([...folder.files.keys()]).toEqual([]);
  });

  it('unwedges the queue when a runtime load never settles', async () => {
    const manager = assets();
    let loadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      loadStarted = resolve;
    });
    const runtime: OcrRuntimeLike = {
      recognize: vi.fn(async () => ({ text: 'ok' })),
      release: vi.fn(),
    };
    let loads = 0;
    const createRuntime = vi.fn(async () => {
      loadStarted();
      loads += 1;
      // Only the first load stalls; a later request must be able to use the queue again.
      return loads === 1 ? new Promise<OcrRuntimeLike>(() => undefined) : runtime;
    });
    const host = new OcrHost({ createAssetManager: async () => manager, createRuntime });

    const stalled = host.recognize('stalled', 'standard', image);
    await started;
    host.cancel('stalled');
    await expect(stalled).rejects.toMatchObject({ code: 'aborted' });

    await expect(host.recognize('next', 'standard', image)).resolves.toMatchObject({ text: 'ok' });
    expect(createRuntime).toHaveBeenCalledTimes(2);
    await expect(host.delete('standard')).resolves.toMatchObject({ state: 'absent' });
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('cancels every tier before draining the queue on delete', async () => {
    const manager = assets();
    let recognitionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      recognitionStarted = resolve;
    });
    let highSignal: AbortSignal | undefined;
    const runtime: OcrRuntimeLike = {
      recognize: (_image, signal) => {
        highSignal = signal;
        recognitionStarted();
        // A native run that ignores abort still settles the queue via withinSignal().
        return new Promise(() => undefined);
      },
      release: vi.fn(),
    };
    const host = new OcrHost({
      createAssetManager: async () => manager,
      createRuntime: async () => runtime,
    });

    const high = host.recognize('slow-high', 'high', image);
    await started;
    await expect(host.delete('standard')).resolves.toMatchObject({ state: 'absent' });
    expect(highSignal?.aborted).toBe(true);
    await expect(high).rejects.toMatchObject({ code: 'aborted' });
  });

  it('applies the host timeout to a stalled runtime load without blocking delete', async () => {
    const manager = assets();
    let loadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      loadStarted = resolve;
    });
    const host = new OcrHost({
      createAssetManager: async () => manager,
      createRuntime: async () => {
        loadStarted();
        return new Promise<OcrRuntimeLike>(() => undefined);
      },
      timeoutMs: (tier) => (tier === 'high' ? 80 : 20),
    });

    const recognizing = host.recognize('timed-out', 'standard', image);
    await started;
    await expect(recognizing).rejects.toMatchObject({ code: 'aborted' });
    await expect(host.delete('standard')).resolves.toMatchObject({ state: 'absent' });
  });

  it('settles a recognition that ignores abort and releases its session only afterwards', async () => {
    const manager = assets();
    let recognitionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      recognitionStarted = resolve;
    });
    let finishRecognition!: () => void;
    const recognized = new Promise<void>((resolve) => {
      finishRecognition = resolve;
    });
    const runtime: OcrRuntimeLike = {
      recognize: async () => {
        recognitionStarted();
        await recognized;
        return { text: 'late' };
      },
      release: vi.fn(),
    };
    const host = new OcrHost({
      createAssetManager: async () => manager,
      createRuntime: async () => runtime,
    });

    const pending = host.recognize('ignores-abort', 'standard', image);
    await started;
    host.cancel('ignores-abort');
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await expect(host.delete('standard')).resolves.toMatchObject({ state: 'absent' });
    expect(runtime.release).not.toHaveBeenCalled();

    finishRecognition();
    await vi.waitFor(() => expect(runtime.release).toHaveBeenCalledOnce());
  });
});
