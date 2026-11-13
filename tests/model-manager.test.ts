import { describe, expect, it, vi } from 'vitest';
import {
  INTEGRITY_DIGEST_ERROR,
  INTEGRITY_SIZE_ERROR,
  isModelIntegrityError,
  ModelManager,
} from '@/engine/model/manager';
import { sha256Hex } from '@/engine/model/sha256';
import type { BackendSelection } from '@/engine/in-browser/backend';
import type { ModelStatus } from '@/shared/engine-status';
import { bytesOf, FakeRuntime, MemoryFileStore, entryRecord, makeEntry } from './support/fakes';

const PAYLOAD = bytesOf('hello world!');

const ENTRY = makeEntry({
  size: PAYLOAD.length,
  sha256: sha256Hex(PAYLOAD),
  url: 'https://example.test/model.gguf',
});

const SELECTION: BackendSelection = {
  tier: 'c8',
  backend: 'cpu-wasm',
  nGpuLayers: 0,
  nThreads: 8,
  nParallel: 1,
  nCtx: 2048,
};

function createManager(
  store: MemoryFileStore,
  options: {
    createRuntime?: (blob: Blob, selection: BackendSelection) => Promise<FakeRuntime>;
    fetchImpl?: typeof fetch;
    fallbackStore?: MemoryFileStore;
    copyChunkBytes?: number;
    hashBlob?: (blob: Blob) => Promise<string>;
  } = {},
): { manager: ModelManager; createRuntime: ReturnType<typeof vi.fn> } {
  const createRuntime = vi.fn(
    options.createRuntime ?? (async () => new FakeRuntime(() => 'こんにちは')),
  );
  const manager = new ModelManager({
    store,
    entries: entryRecord(ENTRY),
    createRuntime,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.fallbackStore ? { fallbackStore: options.fallbackStore } : {}),
    ...(options.copyChunkBytes !== undefined ? { copyChunkBytes: options.copyChunkBytes } : {}),
    ...(options.hashBlob ? { hashBlob: options.hashBlob } : {}),
  });
  return { manager, createRuntime };
}

async function seedVerified(store: MemoryFileStore): Promise<void> {
  const { manager } = createManager(store, {
    fetchImpl: async () => new Response(new Uint8Array(PAYLOAD), { status: 200 }),
  });
  await manager.download(ENTRY.id, { signal: new AbortController().signal });
}

async function downloadedManager(): Promise<{
  manager: ModelManager;
  store: MemoryFileStore;
  createRuntime: ReturnType<typeof vi.fn>;
}> {
  const store = new MemoryFileStore();
  const { manager, createRuntime } = createManager(store, {
    fetchImpl: async () => new Response(new Uint8Array(PAYLOAD), { status: 200 }),
  });
  await manager.download(ENTRY.id, { signal: new AbortController().signal });
  return { manager, store, createRuntime };
}

describe('ModelManager', () => {
  it('reports an absent model, then ready after a verified download', async () => {
    const store = new MemoryFileStore();
    const { manager } = createManager(store, {
      fetchImpl: async () => new Response(new Uint8Array(PAYLOAD), { status: 200 }),
    });

    expect(await manager.status(ENTRY.id)).toMatchObject({ state: 'absent', progress: 0 });

    await manager.download(ENTRY.id, { signal: new AbortController().signal });

    expect(await manager.status(ENTRY.id)).toMatchObject({
      state: 'ready',
      received: PAYLOAD.length,
      total: PAYLOAD.length,
      progress: 1,
    });
    expect(store.text(`models/${ENTRY.id}/model.json`)).toContain(ENTRY.sha256);
    expect(store.files.has(`models/${ENTRY.id}/model.gguf`)).toBe(true);
  });

  it('keeps an HTTP 403 on the model status', async () => {
    const store = new MemoryFileStore();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 403 }));
    const { manager } = createManager(store, { fetchImpl });

    await expect(
      manager.download(ENTRY.id, { signal: new AbortController().signal }),
    ).rejects.toThrow(/HTTP 403/);
    expect(await manager.status(ENTRY.id)).toMatchObject({
      state: 'error',
      error: expect.stringContaining('HTTP 403'),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reports progress from a partial file and refuses to start without space', async () => {
    const store = new MemoryFileStore();
    await store.append(`models/${ENTRY.id}/model.gguf.part`, PAYLOAD.slice(0, 5), 0);
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(PAYLOAD), { status: 200 }));
    const { manager } = createManager(store, { fetchImpl });

    expect(await manager.status(ENTRY.id)).toMatchObject({
      state: 'partial',
      received: 5,
      progress: 5 / PAYLOAD.length,
    });

    store.quota = 10;
    await expect(
      manager.download(ENTRY.id, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'storage-insufficient' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps resumed bytes monotonic while the prefix is hashed', async () => {
    const store = new MemoryFileStore();
    await store.append(`models/${ENTRY.id}/model.gguf.part`, PAYLOAD.slice(0, 5), 0);
    const statuses: ModelStatus[] = [];
    const manager = new ModelManager({
      store,
      entries: entryRecord(ENTRY),
      createRuntime: async () => new FakeRuntime(() => 'こんにちは'),
      fetchImpl: async () =>
        new Response(PAYLOAD.slice(5), {
          status: 206,
          headers: {
            'Content-Length': String(PAYLOAD.length - 5),
            'Content-Range': `bytes 5-${String(PAYLOAD.length - 1)}/${String(PAYLOAD.length)}`,
          },
        }),
      onStatus: (status) => statuses.push(status),
    });

    await manager.download(ENTRY.id, { signal: new AbortController().signal });

    expect(statuses.some((status) => status.state === 'verifying' && status.received === 5)).toBe(
      false,
    );
    for (let index = 1; index < statuses.length; index += 1) {
      expect(statuses[index]?.received ?? 0).toBeGreaterThanOrEqual(
        statuses[index - 1]?.received ?? 0,
      );
      if (statuses[index - 1]?.state === 'verifying') {
        expect(statuses[index]?.state).not.toBe('downloading');
      }
    }
    expect(statuses.at(-1)).toMatchObject({ state: 'ready', progress: 1 });
  });

  it('loads one runtime at a time and reuses it', async () => {
    const { manager, createRuntime } = await downloadedManager();

    const [first, second] = await Promise.all([
      manager.ensureLoaded(ENTRY.id, SELECTION),
      manager.ensureLoaded(ENTRY.id, SELECTION),
    ]);

    expect(createRuntime).toHaveBeenCalledOnce();
    expect(first.runtime).toBe(second.runtime);
    expect(manager.loadedModel?.id).toBe(ENTRY.id);
    expect(await manager.status(ENTRY.id)).toMatchObject({ state: 'loaded' });
  });

  it('unloads the runtime and can load it again', async () => {
    const { manager, createRuntime } = await downloadedManager();
    const loaded = await manager.ensureLoaded(ENTRY.id, SELECTION);

    await manager.unload();
    expect((loaded.runtime as FakeRuntime).disposed).toBe(true);
    expect(manager.loadedModel).toBeNull();
    expect(await manager.status(ENTRY.id)).toMatchObject({ state: 'ready' });

    await manager.ensureLoaded(ENTRY.id, SELECTION);
    expect(createRuntime).toHaveBeenCalledTimes(2);
  });

  it('rejects a load without a downloaded model', async () => {
    const store = new MemoryFileStore();
    const { manager } = createManager(store);

    await expect(manager.ensureLoaded(ENTRY.id, SELECTION)).rejects.toMatchObject({
      code: 'model-missing',
    });
  });

  it('maps a NotAllowedError on read to model-folder-permission, not a missing file', async () => {
    const { manager, store } = await downloadedManager();
    const original = store.read.bind(store);
    store.read = async (path: string) => {
      if (path.endsWith('model.gguf')) {
        throw new DOMException('Permission denied.', 'NotAllowedError');
      }
      return original(path);
    };

    await expect(manager.ensureLoaded(ENTRY.id, SELECTION)).rejects.toMatchObject({
      code: 'model-folder-permission',
    });
  });

  it('propagates load failures and retries on the next call', async () => {
    const { manager, createRuntime } = await downloadedManager();
    createRuntime.mockRejectedValueOnce(new Error('out of memory'));

    await expect(manager.ensureLoaded(ENTRY.id, SELECTION)).rejects.toThrow('out of memory');
    expect(manager.loadedModel).toBeNull();

    await expect(manager.ensureLoaded(ENTRY.id, SELECTION)).resolves.toBeDefined();
    expect(createRuntime).toHaveBeenCalledTimes(2);
  });

  it('deletes every file and unloads a loaded runtime', async () => {
    const { manager, store } = await downloadedManager();
    const loaded = await manager.ensureLoaded(ENTRY.id, SELECTION);

    await manager.deleteModel(ENTRY.id);

    expect((loaded.runtime as FakeRuntime).disposed).toBe(true);
    expect(manager.loadedModel).toBeNull();
    expect(await manager.status(ENTRY.id)).toMatchObject({ state: 'absent', received: 0 });
    expect([...store.files.keys()].some((path) => path.startsWith(`models/${ENTRY.id}`))).toBe(
      false,
    );
  });

  it('skips a second hash when size and lastModified still match the sidecar', async () => {
    const store = new MemoryFileStore();
    const hashBlob = vi.fn(async (blob: Blob) =>
      sha256Hex(new Uint8Array(await blob.arrayBuffer())),
    );
    const hashing = new ModelManager({
      store,
      entries: entryRecord(ENTRY),
      createRuntime: async () => new FakeRuntime(() => 'こんにちは'),
      fetchImpl: async () => new Response(new Uint8Array(PAYLOAD), { status: 200 }),
      hashBlob,
    });

    await hashing.download(ENTRY.id, { signal: new AbortController().signal });
    const afterDownload = hashBlob.mock.calls.length;
    expect(await hashing.status(ENTRY.id)).toMatchObject({ state: 'ready' });
    expect(hashBlob.mock.calls.length).toBe(afterDownload);

    await hashing.ensureLoaded(ENTRY.id, SELECTION);
    expect(hashBlob.mock.calls.length).toBe(afterDownload);
  });

  it('rehashes when lastModified changes and rejects a digest mismatch', async () => {
    const store = new MemoryFileStore();
    const hashing = new ModelManager({
      store,
      entries: entryRecord(ENTRY),
      createRuntime: async () => new FakeRuntime(() => 'こんにちは'),
      fetchImpl: async () => new Response(new Uint8Array(PAYLOAD), { status: 200 }),
    });
    await hashing.download(ENTRY.id, { signal: new AbortController().signal });

    store.files.set(`models/${ENTRY.id}/model.gguf`, bytesOf('tampered!!!!'));
    store.modified.set(`models/${ENTRY.id}/model.gguf`, Date.now() + 10_000);

    await expect(
      hashing.download(ENTRY.id, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'model-integrity' });
    expect(await hashing.status(ENTRY.id)).toMatchObject({
      state: 'error',
      error: INTEGRITY_DIGEST_ERROR,
    });
  });

  it('refuses a file whose size is not the pin, and does not download over it', async () => {
    const store = new MemoryFileStore();
    await store.append(`models/${ENTRY.id}/model.gguf`, bytesOf('nope'), 0);
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(PAYLOAD), { status: 200 }));
    const { manager } = createManager(store, { fetchImpl });

    await expect(
      manager.download(ENTRY.id, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'model-integrity', message: INTEGRITY_SIZE_ERROR });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await manager.status(ENTRY.id)).toMatchObject({
      state: 'error',
      error: INTEGRITY_SIZE_ERROR,
    });
  });

  it('loads from the OPFS fallback when the shared folder has no file yet', async () => {
    const opfs = new MemoryFileStore();
    const shared = new MemoryFileStore();
    const { manager, createRuntime } = createManager(opfs, {
      fetchImpl: async () => new Response(new Uint8Array(PAYLOAD), { status: 200 }),
    });
    await manager.download(ENTRY.id, { signal: new AbortController().signal });
    manager.setStores(shared, opfs);

    expect(await manager.status(ENTRY.id)).toMatchObject({ state: 'ready' });
    await manager.ensureLoaded(ENTRY.id, SELECTION);
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(new Uint8Array(await (await manager.modelBlob(ENTRY.id)).arrayBuffer())).toEqual(
      PAYLOAD,
    );

    await manager.deleteModel(ENTRY.id);
    expect(shared.files.size).toBe(0);
    expect(await manager.fallbackCopyPresent(ENTRY.id)).toBe(true);

    await manager.deleteFallbackCopy(ENTRY.id);
    expect(await manager.fallbackCopyPresent(ENTRY.id)).toBe(false);
  });

  it('copies a verified OPFS model into an empty shared folder without fetching', async () => {
    const opfs = new MemoryFileStore();
    const shared = new MemoryFileStore();
    await seedVerified(opfs);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network download should not run');
    });
    const { manager } = createManager(shared, { fallbackStore: opfs, fetchImpl });

    await manager.adoptPresentModels();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await manager.primaryReady(ENTRY.id)).toBe(true);
    expect(await manager.status(ENTRY.id)).toMatchObject({ state: 'ready', progress: 1 });
    expect(new Uint8Array(shared.files.get(`models/${ENTRY.id}/model.gguf`) ?? [])).toEqual(
      PAYLOAD,
    );
    expect(shared.text(`models/${ENTRY.id}/model.json`)).toContain(ENTRY.sha256);
    expect(opfs.files.has(`models/${ENTRY.id}/model.gguf`)).toBe(true);
    expect(await manager.fallbackCopyPresent(ENTRY.id)).toBe(true);
    await manager.ensureLoaded(ENTRY.id, SELECTION);
    expect(new Uint8Array(await (await manager.modelBlob(ENTRY.id)).arrayBuffer())).toEqual(
      PAYLOAD,
    );
  });

  it('downloads by moving from OPFS instead of hitting the network', async () => {
    const opfs = new MemoryFileStore();
    const shared = new MemoryFileStore();
    await seedVerified(opfs);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network download should not run');
    });
    const { manager } = createManager(shared, { fallbackStore: opfs, fetchImpl });

    await manager.download(ENTRY.id, { signal: new AbortController().signal });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await manager.primaryReady(ENTRY.id)).toBe(true);
    expect(opfs.files.has(`models/${ENTRY.id}/model.gguf`)).toBe(true);
  });

  it('keeps the OPFS copy when folder verification fails', async () => {
    const opfs = new MemoryFileStore();
    const shared = new MemoryFileStore();
    await seedVerified(opfs);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network download should not run');
    });
    const { manager } = createManager(shared, {
      fallbackStore: opfs,
      fetchImpl,
      hashBlob: async () => 'f'.repeat(64),
    });

    await manager.adoptPresentModels();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await manager.primaryReady(ENTRY.id)).toBe(false);
    expect(shared.files.has(`models/${ENTRY.id}/model.gguf`)).toBe(false);
    expect(shared.files.has(`models/${ENTRY.id}/model.gguf.part`)).toBe(false);
    expect(opfs.files.has(`models/${ENTRY.id}/model.gguf`)).toBe(true);
  });

  it('does not copy a digest-failed OPFS model again on the next adopt', async () => {
    const opfs = new MemoryFileStore();
    const shared = new MemoryFileStore();
    await seedVerified(opfs);
    const hashBlob = vi.fn(async () => 'f'.repeat(64));
    const { manager } = createManager(shared, { fallbackStore: opfs, hashBlob });

    await manager.adoptPresentModels();
    await manager.adoptPresentModels();

    expect(hashBlob).toHaveBeenCalledOnce();
    expect(await manager.primaryReady(ENTRY.id)).toBe(false);
    expect(opfs.files.has(`models/${ENTRY.id}/model.gguf`)).toBe(true);

    const { manager: restarted } = createManager(shared, { fallbackStore: opfs, hashBlob });
    await restarted.adoptPresentModels();
    expect(hashBlob).toHaveBeenCalledOnce();
  });

  it('keeps the loaded OPFS runtime and browser copy after sharing the model', async () => {
    const opfs = new MemoryFileStore();
    const shared = new MemoryFileStore();
    await seedVerified(opfs);
    const { manager, createRuntime } = createManager(shared, { fallbackStore: opfs });
    await manager.ensureLoaded(ENTRY.id, SELECTION);
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(manager.loadedModel?.id).toBe(ENTRY.id);

    await manager.adoptPresentModels();

    expect(manager.loadedModel?.id).toBe(ENTRY.id);
    expect(opfs.files.has(`models/${ENTRY.id}/model.gguf`)).toBe(true);
    expect(await manager.primaryReady(ENTRY.id)).toBe(true);
    await manager.ensureLoaded(ENTRY.id, SELECTION);
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(manager.loadedModel?.id).toBe(ENTRY.id);
  });

  it('falls back to the retained OPFS copy when the shared folder is revoked', async () => {
    const opfs = new MemoryFileStore();
    const shared = new MemoryFileStore();
    await seedVerified(opfs);
    const { manager, createRuntime } = createManager(shared, { fallbackStore: opfs });
    await manager.adoptPresentModels();
    expect(await manager.primaryReady(ENTRY.id)).toBe(true);

    const originalStat = shared.stat.bind(shared);
    shared.stat = async () => null;
    shared.read = async () => {
      throw new DOMException('Permission denied.', 'NotAllowedError');
    };
    try {
      expect(await manager.status(ENTRY.id)).toMatchObject({ state: 'ready' });
      await manager.ensureLoaded(ENTRY.id, SELECTION);
      expect(createRuntime).toHaveBeenCalledOnce();
      expect(manager.loadedModel?.id).toBe(ENTRY.id);
    } finally {
      shared.stat = originalStat;
    }
  });

  it('leaves no valid shared file when an OPFS copy is interrupted', async () => {
    const opfs = new MemoryFileStore();
    const shared = new MemoryFileStore();
    await seedVerified(opfs);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network download should not run');
    });
    const { manager } = createManager(shared, {
      fallbackStore: opfs,
      fetchImpl,
      copyChunkBytes: 4,
    });
    const controller = new AbortController();

    await expect(
      manager.download(ENTRY.id, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === 'download' && progress.received > 0) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'aborted' });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(shared.files.has(`models/${ENTRY.id}/model.gguf`)).toBe(false);
    expect(shared.files.has(`models/${ENTRY.id}/model.gguf.part`)).toBe(false);
    expect(shared.files.has(`models/${ENTRY.id}/model.json`)).toBe(false);
    expect(opfs.files.has(`models/${ENTRY.id}/model.gguf`)).toBe(true);
  });

  it('does not copy an OPFS model over a pin-sized folder file that only needs a hash', async () => {
    const opfs = new MemoryFileStore();
    const shared = new MemoryFileStore();
    await seedVerified(opfs);
    await shared.append(`models/${ENTRY.id}/model.gguf`, PAYLOAD, 0);
    const before = shared.files.get(`models/${ENTRY.id}/model.gguf`);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network download should not run');
    });
    const { manager } = createManager(shared, { fallbackStore: opfs, fetchImpl });

    await manager.adoptPresentModels();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(shared.files.get(`models/${ENTRY.id}/model.gguf`)).toBe(before);
    expect(opfs.files.has(`models/${ENTRY.id}/model.gguf`)).toBe(true);
    expect(await manager.primaryReady(ENTRY.id)).toBe(true);
  });

  it('does not copy an OPFS model over a wrong-sized file already in the folder', async () => {
    const opfs = new MemoryFileStore();
    const shared = new MemoryFileStore();
    await seedVerified(opfs);
    await shared.append(`models/${ENTRY.id}/model.gguf`, bytesOf('nope'), 0);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network download should not run');
    });
    const { manager } = createManager(shared, { fallbackStore: opfs, fetchImpl });

    await manager.adoptPresentModels();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(shared.files.get(`models/${ENTRY.id}/model.gguf`))).toBe(
      'nope',
    );
    expect(await manager.primaryReady(ENTRY.id)).toBe(false);
    expect(opfs.files.has(`models/${ENTRY.id}/model.gguf`)).toBe(true);
  });

  it('adopts a correctly sized file already in the shared folder without fetching', async () => {
    const store = new MemoryFileStore();
    await store.append(`models/${ENTRY.id}/model.gguf`, PAYLOAD, 0);
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(PAYLOAD), { status: 200 }));
    const { manager } = createManager(store, { fetchImpl });

    await manager.adoptPresentModels();
    expect(await manager.status(ENTRY.id)).toMatchObject({ state: 'ready' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.text(`models/${ENTRY.id}/model.json`)).toContain(ENTRY.sha256);
  });

  it('keeps integrity failures as tokens, not user-facing English', () => {
    expect(isModelIntegrityError(INTEGRITY_SIZE_ERROR)).toBe(true);
    expect(isModelIntegrityError(INTEGRITY_DIGEST_ERROR)).toBe(true);
    expect(isModelIntegrityError('The file is not the official PLaMo model')).toBe(false);
    expect(INTEGRITY_SIZE_ERROR).toBe('integrity-size');
    expect(INTEGRITY_DIGEST_ERROR).toBe('integrity-digest');
  });
});
