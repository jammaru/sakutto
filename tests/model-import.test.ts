import { describe, expect, it, vi } from 'vitest';
import { EngineError } from '@/engine/errors';
import {
  MODEL_IMPORT_DIGEST_ERROR,
  MODEL_IMPORT_SIZE_ERROR,
  importModelFile,
  isModelImportIntegrityError,
} from '@/engine/model/import-export';
import { getModel } from '@/engine/model/catalog';
import type { ModelFileStore } from '@/engine/model/file-store';
import { sha256Hex } from '@/engine/model/sha256';
import { bytesOf, MemoryFileStore, makeEntry } from './support/fakes';

const PAYLOAD = bytesOf('official model bytes');
const ENTRY = makeEntry({
  size: PAYLOAD.length,
  sha256: sha256Hex(PAYLOAD),
  file: 'plamo-test.gguf',
});
const FINAL_PATH = `models/${ENTRY.id}/model.gguf`;
const PART_PATH = `models/${ENTRY.id}/model.gguf.part`;

function fileOf(bytes: Uint8Array, name = ENTRY.file): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' });
}

function request(file: File, overrides: Partial<Parameters<typeof importModelFile>[0]> = {}) {
  return {
    file,
    modelId: ENTRY.id,
    store: new MemoryFileStore(),
    signal: new AbortController().signal,
    entry: ENTRY,
    ...overrides,
  };
}

describe('importModelFile', () => {
  it('streams a good file into OPFS and writes a verified manifest', async () => {
    const store = new MemoryFileStore();
    const progress: number[] = [];
    const result = await importModelFile(
      request(fileOf(PAYLOAD), {
        store,
        onProgress: (item) => {
          if (item.phase === 'copy') progress.push(item.received);
        },
      }),
    );

    expect(result).toEqual({ bytes: PAYLOAD.length, sha256: ENTRY.sha256 });
    expect(store.files.get(FINAL_PATH)).toEqual(PAYLOAD);
    expect(store.files.has(PART_PATH)).toBe(false);
    expect(progress.at(-1)).toBe(PAYLOAD.length);
    expect(JSON.parse(store.text(`models/${ENTRY.id}/model.json`))).toMatchObject({
      id: ENTRY.id,
      sha256: ENTRY.sha256,
      size: ENTRY.size,
      commit: ENTRY.commit,
    });
  });

  it('rejects a file whose size is not the pin before writing it', async () => {
    const store = new MemoryFileStore();
    const error = await importModelFile(request(fileOf(bytesOf('short')), { store })).catch(
      (value: unknown) => value,
    );

    expect(error).toBeInstanceOf(EngineError);
    expect(isModelImportIntegrityError(error)).toBe(true);
    expect((error as EngineError).detail).toBe(MODEL_IMPORT_SIZE_ERROR);
    expect(store.files.size).toBe(0);
  });

  it('rejects a pinned-size file with the wrong digest and removes the part', async () => {
    const store = new MemoryFileStore();
    const wrong = bytesOf('x'.repeat(PAYLOAD.length));
    expect(wrong.length).toBe(PAYLOAD.length);
    const error = await importModelFile(request(fileOf(wrong), { store })).catch(
      (value: unknown) => value,
    );

    expect(error).toBeInstanceOf(EngineError);
    expect(isModelImportIntegrityError(error)).toBe(true);
    expect((error as EngineError).detail).toBe(MODEL_IMPORT_DIGEST_ERROR);
    expect(store.files.has(FINAL_PATH)).toBe(false);
    expect(store.files.has(PART_PATH)).toBe(false);
  });

  it('supports an injected digest for tests and untrusted host adapters', async () => {
    const store = new MemoryFileStore();
    const hashBlob = vi.fn(async () => ENTRY.sha256);
    await importModelFile(request(fileOf(PAYLOAD), { store, hashBlob }));
    expect(hashBlob).toHaveBeenCalledOnce();
    expect(store.files.get(FINAL_PATH)).toEqual(PAYLOAD);
  });

  it('cancels mid-stream, removes the part, and leaves no usable model', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const error = await importModelFile(
      request(fileOf(PAYLOAD), {
        store,
        signal: controller.signal,
        onProgress: (item) => {
          if (item.phase === 'copy' && item.received > 0) controller.abort();
        },
      }),
    ).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: 'aborted' });
    expect(store.files.has(FINAL_PATH)).toBe(false);
    expect(store.files.has(PART_PATH)).toBe(false);
  });

  it('does not replace an installed model when a new import fails', async () => {
    const store = new MemoryFileStore();
    await importModelFile(request(fileOf(PAYLOAD), { store }));
    const before = store.files.get(FINAL_PATH);

    await expect(
      importModelFile(request(fileOf(bytesOf('x'.repeat(PAYLOAD.length))), { store })),
    ).rejects.toMatchObject({ code: 'model-integrity' });

    expect(store.files.get(FINAL_PATH)).toBe(before);
    expect(store.text(`models/${ENTRY.id}/model.json`)).toContain(ENTRY.sha256);
  });
});

const PAYLOAD_TWO = bytesOf('official model bytes!!');
const PAYLOAD_THREE = bytesOf('official model bytes!!!!');
const REVISIONS = [
  { commit: 'c1', size: PAYLOAD.length, sha256: sha256Hex(PAYLOAD) },
  { commit: 'c2', size: PAYLOAD_TWO.length, sha256: sha256Hex(PAYLOAD_TWO) },
  { commit: 'c3', size: PAYLOAD_THREE.length, sha256: sha256Hex(PAYLOAD_THREE) },
];
const MULTI_ENTRY = makeEntry({
  file: ENTRY.file,
  size: REVISIONS[0]?.size ?? 0,
  sha256: REVISIONS[0]?.sha256 ?? '',
  revisions: REVISIONS,
});

describe('importModelFile with multiple official revisions', () => {
  it('imports and records a manifest for every known revision', async () => {
    const files = [PAYLOAD, PAYLOAD_TWO, PAYLOAD_THREE];
    for (const [index, revision] of REVISIONS.entries()) {
      const store = new MemoryFileStore();
      const bytes = files[index];
      if (!bytes) throw new Error('missing fixture');
      const result = await importModelFile(request(fileOf(bytes), { store, entry: MULTI_ENTRY }));

      expect(result).toEqual({ bytes: revision.size, sha256: revision.sha256 });
      expect(store.files.get(FINAL_PATH)).toEqual(bytes);
      expect(JSON.parse(store.text(`models/${ENTRY.id}/model.json`))).toMatchObject({
        id: ENTRY.id,
        sha256: revision.sha256,
        size: revision.size,
        commit: revision.commit,
      });
    }
  });

  it('still rejects an unknown hash of a known size', async () => {
    const store = new MemoryFileStore();
    const wrong = bytesOf('!'.repeat(PAYLOAD_TWO.length));
    const error = await importModelFile(
      request(fileOf(wrong), { store, entry: MULTI_ENTRY }),
    ).catch((value: unknown) => value);

    expect(isModelImportIntegrityError(error)).toBe(true);
    expect((error as EngineError).detail).toBe(MODEL_IMPORT_DIGEST_ERROR);
    expect(store.files.has(FINAL_PATH)).toBe(false);
  });

  it('rejects a size outside every known revision before writing', async () => {
    const store = new MemoryFileStore();
    const error = await importModelFile(
      request(fileOf(bytesOf('short')), { store, entry: MULTI_ENTRY }),
    ).catch((value: unknown) => value);

    expect((error as EngineError).detail).toBe(MODEL_IMPORT_SIZE_ERROR);
    expect(store.files.size).toBe(0);
  });
});

const LARGE_ENTRY = getModel('plamo-3-translate-0.8b-q4_k_m');

/** A small blob with the catalog's reported GGUF size, so tests stay sparse. */
const SPARSE_CHUNK = new Uint8Array(1024 * 1024);

/** A multi-hundred-MB file whose stream reuses one chunk instead of allocating the bytes. */
function sizedFile(size: number, name: string): File {
  return {
    name,
    size,
    stream: () =>
      new ReadableStream({
        start(controller) {
          let left = size;
          while (left >= SPARSE_CHUNK.length) {
            controller.enqueue(SPARSE_CHUNK);
            left -= SPARSE_CHUNK.length;
          }
          if (left > 0) controller.enqueue(SPARSE_CHUNK.subarray(0, left));
          controller.close();
        },
      }),
    slice: () => new Blob([]),
  } as unknown as File;
}

/** Store that tracks sizes only, so the sparse fixtures above stay cheap. */
class SparseStore implements ModelFileStore {
  readonly files = new Map<string, { size: number; lastModified: number }>();
  readonly texts = new Map<string, string>();
  private clock = 1;

  async size(path: string): Promise<number> {
    return this.files.get(path)?.size ?? 0;
  }

  async stat(path: string): Promise<{ size: number; lastModified: number } | null> {
    return this.files.get(path) ?? null;
  }

  async append(path: string, chunk: Uint8Array, offset: number): Promise<void> {
    const entry = this.files.get(path) ?? { size: 0, lastModified: this.clock++ };
    entry.size = Math.max(entry.size, offset + chunk.length);
    this.files.set(path, entry);
  }

  async createWriter(
    path: string,
    offset: number,
  ): Promise<{ write(chunk: Uint8Array): Promise<void>; close(): Promise<void> }> {
    const entry = this.files.get(path) ?? { size: 0, lastModified: this.clock++ };
    let position = offset;
    this.files.set(path, entry);
    return {
      write: async (chunk: Uint8Array) => {
        position += chunk.length;
        entry.size = Math.max(entry.size, position);
        this.texts.set(path, new TextDecoder().decode(chunk));
      },
      close: async () => undefined,
    };
  }

  async read(path: string): Promise<Blob> {
    const entry = this.files.get(path);
    if (!entry) throw new DOMException(`Missing ${path}`, 'NotFoundError');
    return { size: entry.size } as Blob;
  }

  async move(from: string, to: string): Promise<void> {
    const entry = this.files.get(from);
    if (entry) {
      this.files.set(to, entry);
      this.files.delete(from);
    }
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async removeDirectory(path: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    }
  }

  async estimate(): Promise<{ usage: number; quota: number }> {
    return { usage: 0, quota: 0 };
  }

  text(path: string): string {
    return this.texts.get(path) ?? '';
  }
}

describe('shared-folder import of the older official 0.8B revisions', () => {
  const CASES = [
    '03891e907db8a43c97d3a7c75add125cc6d1f96a',
    '0c4af2b003fdd94b6868aa955414c1c86ee96997',
  ];

  for (const commit of CASES) {
    it(`adopts the ${commit.slice(0, 8)} size with its official digest`, async () => {
      const revision = LARGE_ENTRY.revisions.find((item) => item.commit === commit);
      if (!revision) throw new Error(`missing ${commit}`);
      const store = new SparseStore();
      const file = sizedFile(revision.size, LARGE_ENTRY.file);

      const result = await importModelFile({
        file,
        modelId: LARGE_ENTRY.id,
        store,
        signal: new AbortController().signal,
        hashBlob: async () => revision.sha256,
      });

      expect(result).toEqual({ bytes: revision.size, sha256: revision.sha256 });
      expect(JSON.parse(store.text(`models/${LARGE_ENTRY.id}/model.json`))).toMatchObject({
        sha256: revision.sha256,
        size: revision.size,
        commit: revision.commit,
      });
    });
  }

  it('still rejects an unknown hash of an older official size', async () => {
    const revision = LARGE_ENTRY.revisions.find((item) => item.commit.startsWith('03891e90'));
    if (!revision) throw new Error('missing 03891e90');
    const store = new SparseStore();
    const file = sizedFile(revision.size, LARGE_ENTRY.file);
    const error = await importModelFile({
      file,
      modelId: LARGE_ENTRY.id,
      store,
      signal: new AbortController().signal,
      hashBlob: async () => '0'.repeat(64),
    }).catch((value: unknown) => value);

    expect((error as EngineError).detail).toBe(MODEL_IMPORT_DIGEST_ERROR);
    expect(store.files.has(FINAL_PATH)).toBe(false);
  });
});

describe('shared-folder import of the initial 2B official release', () => {
  it('adopts the f2b4599d size with its official digest', async () => {
    const entry = getModel('plamo-3-translate-2b-q4_k_m');
    const revision = entry.revisions.find((item) => item.commit.startsWith('f2b4599d'));
    if (!revision) throw new Error('missing f2b4599d');
    const store = new SparseStore();

    const result = await importModelFile({
      file: sizedFile(revision.size, entry.file),
      modelId: entry.id,
      store,
      signal: new AbortController().signal,
      hashBlob: async () => revision.sha256,
    });

    expect(result).toEqual({ bytes: revision.size, sha256: revision.sha256 });
    expect(JSON.parse(store.text(`models/${entry.id}/model.json`))).toMatchObject({
      sha256: revision.sha256,
      size: revision.size,
      commit: revision.commit,
    });
  });

  it('rejects an unknown hash of that 2B size', async () => {
    const entry = getModel('plamo-3-translate-2b-q4_k_m');
    const revision = entry.revisions.find((item) => item.commit.startsWith('f2b4599d'));
    if (!revision) throw new Error('missing f2b4599d');
    const store = new SparseStore();

    const error = await importModelFile({
      file: sizedFile(revision.size, entry.file),
      modelId: entry.id,
      store,
      signal: new AbortController().signal,
      hashBlob: async () => '0'.repeat(64),
    }).catch((value: unknown) => value);

    expect((error as EngineError).detail).toBe(MODEL_IMPORT_DIGEST_ERROR);
    expect(store.files.has(`models/${entry.id}/model.gguf`)).toBe(false);
  });
});
