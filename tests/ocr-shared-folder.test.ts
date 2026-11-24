import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetManager } from '@/engine/model/asset-manager';
import type { AssetBundle } from '@/engine/model/asset';
import { OpfsModelFileStore } from '@/engine/model/file-store';
import { sha256Hex } from '@/engine/model/sha256';
import {
  SharedFolderAssetStore,
  mapAssetPathToSharedName,
  openOcrAssetStore,
  resolveSharedOcrStore,
} from '@/engine/model/shared-asset-store';
import { MemoryFileStore, bytesOf } from './support/fakes';

const { loadFolder, queryPermission } = vi.hoisted(() => ({
  loadFolder: vi.fn(),
  queryPermission: vi.fn(),
}));

vi.mock('@/engine/model/shared-folder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/engine/model/shared-folder')>()),
  sharedFolderSupported: () => true,
  loadStoredSharedFolder: () => loadFolder(),
  queryFolderPermission: (handle: unknown) => queryPermission(handle),
  openSharedModelsDirectory: async (handle: FileSystemDirectoryHandle) => handle,
}));

const DET = bytesOf('tiny detector');
const REC = bytesOf('small recognizer');

function bundle(): AssetBundle<'standard'> {
  const files = [
    { path: 'tiny_det.onnx', payload: DET },
    { path: 'small_rec.onnx', payload: REC },
  ].map(({ path, payload }) => ({
    path,
    url: 'https://example.test/' + path,
    commit: 'pinned-commit',
    size: payload.length,
    sha256: sha256Hex(payload),
  }));
  return { id: 'standard', files, size: DET.length + REC.length };
}

function managerFor(store: SharedFolderAssetStore, fetchImpl?: typeof fetch) {
  return new AssetManager<'standard'>({
    store,
    bundles: { standard: bundle() },
    ...(fetchImpl ? { fetchImpl } : {}),
    hashBlob: async (blob) => sha256Hex(new Uint8Array(await blob.arrayBuffer())),
  });
}

describe('OCR assets in a shared folder', () => {
  beforeEach(() => {
    loadFolder.mockReset();
    queryPermission.mockReset();
  });

  it('maps only pinned OCR files into tier subfolders', () => {
    expect(mapAssetPathToSharedName('models/ocr-standard/tiny_det.onnx')).toBe(
      'ocr-standard/tiny_det.onnx',
    );
    expect(mapAssetPathToSharedName('models/ocr-high/medium_det.onnx.part')).toBe(
      'ocr-high/medium_det.onnx.part',
    );
    expect(mapAssetPathToSharedName('models/ocr-standard/asset.json')).toBe(
      'ocr-standard/asset.json',
    );
    for (const path of [
      'models/plamo-3-translate-0.8b-Q4_K_M/model.gguf',
      'models/ocr-standard/../../secrets.txt',
      'models/ocr-unknown/tiny_det.onnx',
      'models/ocr-standard/unknown.onnx',
    ]) {
      expect(mapAssetPathToSharedName(path)).toBeNull();
    }
  });

  it('stores ONNX bytes and the integrity sidecar in ocr-standard/', async () => {
    const inner = new MemoryFileStore();
    const store = SharedFolderAssetStore.fromStore(inner);
    const manager = managerFor(store, async (input) => {
      const name = String(input).split('/').at(-1);
      return new Response((name === 'tiny_det.onnx' ? DET : REC) as unknown as BodyInit, {
        status: 200,
      });
    });

    await manager.download('standard', { signal: new AbortController().signal });
    expect([...inner.files.keys()].sort()).toEqual([
      'ocr-standard/asset.json',
      'ocr-standard/small_rec.onnx',
      'ocr-standard/tiny_det.onnx',
    ]);
    const sidecar = JSON.parse(await inner.text('ocr-standard/asset.json'));
    expect(sidecar.id).toBe('standard');
    expect(sidecar.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ sha256: sha256Hex(DET) })]),
    );
    expect(await manager.status('standard')).toMatchObject({ state: 'ready', progress: 1 });
  });

  it('reuses verified folder files from another profile without fetching or hashing', async () => {
    const inner = new MemoryFileStore();
    const first = SharedFolderAssetStore.fromStore(inner);
    await first.append('models/ocr-standard/tiny_det.onnx', DET, 0);
    await first.append('models/ocr-standard/small_rec.onnx', REC, 0);
    const sidecar = {
      id: 'standard',
      verifiedAt: Date.now(),
      files: bundle().files.map((file) => ({ ...file, lastModified: 123 })),
    };
    await first.append('models/ocr-standard/asset.json', bytesOf(JSON.stringify(sidecar)), 0);
    // MemoryFileStore stamps writes; pin lastModified to the current values so the
    // second manager trusts the sidecar exactly as it would after a folder copy.
    const stamped = JSON.parse(await inner.text('ocr-standard/asset.json'));
    stamped.files = stamped.files.map((file: { path: string }) => ({
      ...file,
      lastModified: inner.modified.get('ocr-standard/' + file.path) ?? 0,
    }));
    await first.append('models/ocr-standard/asset.json', bytesOf(JSON.stringify(stamped)), 0);

    const neverFetch = vi.fn(async () => {
      throw new Error('unexpected download');
    });
    const reuse = managerFor(SharedFolderAssetStore.fromStore(inner), neverFetch);
    expect(await reuse.status('standard')).toMatchObject({ state: 'ready', progress: 1 });
    await reuse.download('standard', { signal: new AbortController().signal });
    expect(neverFetch).not.toHaveBeenCalled();
    expect(await (await reuse.readFile('standard', 'tiny_det.onnx')).text()).toBe('tiny detector');
  });

  it('deletes only its tier subfolder and leaves PLaMo GGUF files alone', async () => {
    const inner = new MemoryFileStore();
    await inner.append('plamo-3-translate-0.8b-Q4_K_M.gguf', bytesOf('gguf'), 0);
    const store = SharedFolderAssetStore.fromStore(inner);
    const manager = managerFor(store, async (input) => {
      const name = String(input).split('/').at(-1);
      return new Response((name === 'tiny_det.onnx' ? DET : REC) as unknown as BodyInit, {
        status: 200,
      });
    });
    await manager.download('standard', { signal: new AbortController().signal });
    await manager.delete('standard');
    expect([...inner.files.keys()].sort()).toEqual(['plamo-3-translate-0.8b-Q4_K_M.gguf']);
  });

  it('uses OPFS only when no folder is linked', async () => {
    const browser = new MemoryFileStore();
    const openOpfs = vi
      .spyOn(OpfsModelFileStore, 'open')
      .mockResolvedValue(browser as unknown as OpfsModelFileStore);
    loadFolder.mockResolvedValue(null);

    expect(await resolveSharedOcrStore()).toEqual({ kind: 'browser' });
    expect(await openOcrAssetStore()).toBe(browser);
    expect(openOpfs).toHaveBeenCalledOnce();
    openOpfs.mockRestore();
  });

  it('raises a folder-permission error instead of silently falling back to OPFS', async () => {
    const handle = { name: 'e2e-shared' } as FileSystemDirectoryHandle;
    loadFolder.mockResolvedValue({ handle, name: handle.name, savedAt: 1 });
    const openOpfs = vi.spyOn(OpfsModelFileStore, 'open');

    for (const permission of ['prompt', 'denied'] as const) {
      queryPermission.mockResolvedValue(permission);
      expect(await resolveSharedOcrStore()).toEqual({ kind: 'blocked', reason: 'permission' });
      await expect(openOcrAssetStore()).rejects.toMatchObject({
        code: 'model-folder-permission',
      });
    }
    expect(openOpfs).not.toHaveBeenCalled();
    openOpfs.mockRestore();
  });

  it('opens the shared folder store for a granted folder', async () => {
    const handle = { name: 'e2e-shared' } as FileSystemDirectoryHandle;
    loadFolder.mockResolvedValue({ handle, name: handle.name, savedAt: 1 });
    queryPermission.mockResolvedValue('granted');

    const resolution = await resolveSharedOcrStore();
    expect(resolution.kind).toBe('folder');
    expect(await openOcrAssetStore()).toBeInstanceOf(SharedFolderAssetStore);
  });
});
