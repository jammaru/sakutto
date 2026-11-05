import { describe, expect, it, vi } from 'vitest';
import { ModelManager } from '@/engine/model/manager';
import { sha256Hex } from '@/engine/model/sha256';
import type { BackendSelection } from '@/engine/in-browser/backend';
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
  });
  return { manager, createRuntime };
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
});
