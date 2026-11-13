import { describe, expect, it } from 'vitest';
import { EngineError } from '@/engine/errors';
import { copyModelFile, type CopyModelRequest } from '@/engine/model/copy';
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
