import { describe, expect, it, vi } from 'vitest';
import { EngineError } from '@/engine/errors';
import {
  MODEL_IMPORT_DIGEST_ERROR,
  MODEL_IMPORT_SIZE_ERROR,
  importModelFile,
  isModelImportIntegrityError,
} from '@/engine/model/import-export';
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
