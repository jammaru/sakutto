import { describe, expect, it } from 'vitest';
import { EngineError } from '@/engine/errors';
import { copyModelFile, uniquePartPath, type CopyModelRequest } from '@/engine/model/copy';
import { sha256Hex } from '@/engine/model/sha256';
import { bytesOf, MemoryFileStore } from './support/fakes';

const PAYLOAD = bytesOf('hello world!');
const PART = 'model.gguf.part';
const FINAL = 'model.gguf';
const DIGEST = sha256Hex(PAYLOAD);

function baseRequest(store: MemoryFileStore, signal: AbortSignal): CopyModelRequest {
  return {
    blob: new Blob([new Uint8Array(PAYLOAD)]),
    store,
    partPath: PART,
    finalPath: FINAL,
    size: PAYLOAD.length,
    sha256: DIGEST,
    signal,
    chunkBytes: 4,
  };
}

describe('copyModelFile', () => {
  it('streams into a temp name, verifies size and SHA-256, then renames', async () => {
    const store = new MemoryFileStore();
    const progress: { received: number; phase: string }[] = [];

    const result = await copyModelFile({
      ...baseRequest(store, new AbortController().signal),
      onProgress: (event) => progress.push({ received: event.received, phase: event.phase }),
    });

    expect(result).toEqual({ bytes: PAYLOAD.length, sha256: DIGEST });
    expect(store.files.has(PART)).toBe(false);
    expect(new TextDecoder().decode(store.files.get(FINAL))).toBe('hello world!');
    expect(progress.some((event) => event.phase === 'download' && event.received > 0)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ received: PAYLOAD.length, phase: 'verify' });
  });

  it('leaves no valid file when the copy is interrupted', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();

    await expect(
      copyModelFile({
        ...baseRequest(store, controller.signal),
        onProgress: (event) => {
          if (event.phase === 'download' && event.received > 0) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'aborted' });

    expect(store.files.has(FINAL)).toBe(false);
    expect(store.files.has(PART)).toBe(false);
  });

  it('reuses an existing verified final file without rewriting it', async () => {
    const store = new MemoryFileStore();
    store.files.set(FINAL, PAYLOAD);
    let progressCalls = 0;

    const result = await copyModelFile({
      ...baseRequest(store, new AbortController().signal),
      onProgress: () => {
        progressCalls += 1;
      },
    });

    expect(result).toEqual({ bytes: PAYLOAD.length, sha256: DIGEST });
    expect(store.files.has(PART)).toBe(false);
    expect(progressCalls).toBe(0);
  });

  it('does not delete another operation temp part while copying', async () => {
    const store = new MemoryFileStore();
    const foreignPart = uniquePartPath(PART);
    const ownPart = uniquePartPath(PART);
    store.files.set(foreignPart, bytesOf('foreign partial'));

    await copyModelFile({
      ...baseRequest(store, new AbortController().signal),
      partPath: ownPart,
    });

    expect(store.files.has(foreignPart)).toBe(true);
    expect(store.files.has(ownPart)).toBe(false);
    expect(store.files.has(FINAL)).toBe(true);
  });

  it('parallel copies keep separate part files until each finishes', async () => {
    const store = new MemoryFileStore();
    const partA = uniquePartPath(PART);
    const partB = uniquePartPath(PART);

    const [a, b] = await Promise.all([
      copyModelFile({ ...baseRequest(store, new AbortController().signal), partPath: partA }),
      copyModelFile({ ...baseRequest(store, new AbortController().signal), partPath: partB }),
    ]);

    expect(a.bytes).toBe(PAYLOAD.length);
    expect(b.bytes).toBe(PAYLOAD.length);
    expect(store.files.has(partA)).toBe(false);
    expect(store.files.has(partB)).toBe(false);
    expect(store.files.has(FINAL)).toBe(true);
  });

  it('removes the temp file when the digest does not match', async () => {
    const store = new MemoryFileStore();

    await expect(
      copyModelFile({
        ...baseRequest(store, new AbortController().signal),
        sha256: 'f'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(EngineError);

    expect(store.files.has(FINAL)).toBe(false);
    expect(store.files.has(PART)).toBe(false);
  });
});

const SECOND_PAYLOAD = bytesOf('another official model');
const SECOND_DIGEST = sha256Hex(SECOND_PAYLOAD);
const REVISIONS = [
  { commit: 'c1', size: PAYLOAD.length, sha256: DIGEST },
  { commit: 'c2', size: SECOND_PAYLOAD.length, sha256: SECOND_DIGEST },
];

describe('copyModelFile with multiple official revisions', () => {
  it('accepts any known revision and rejects an unknown digest', async () => {
    const store = new MemoryFileStore();
    await copyModelFile({
      ...baseRequest(store, new AbortController().signal),
      blob: new Blob([new Uint8Array(SECOND_PAYLOAD)]),
      revisions: REVISIONS,
    });
    expect(new TextDecoder().decode(store.files.get(FINAL))).toBe('another official model');

    const other = new MemoryFileStore();
    await expect(
      copyModelFile({
        ...baseRequest(other, new AbortController().signal),
        blob: new Blob([new Uint8Array(bytesOf('!'.repeat(SECOND_PAYLOAD.length)))]),
        revisions: REVISIONS,
      }),
    ).rejects.toMatchObject({ code: 'model-integrity' });
    expect(other.files.has(FINAL)).toBe(false);
  });

  it('reuses a final file from a non-default known revision', async () => {
    const store = new MemoryFileStore();
    await store.append(FINAL, SECOND_PAYLOAD, 0);
    const result = await copyModelFile({
      ...baseRequest(store, new AbortController().signal),
      blob: new Blob([new Uint8Array(PAYLOAD)]),
      revisions: REVISIONS,
    });

    expect(result).toEqual({ bytes: SECOND_PAYLOAD.length, sha256: SECOND_DIGEST });
    expect(store.files.get(FINAL)).toEqual(SECOND_PAYLOAD);
  });
});
