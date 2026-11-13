import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Sha256, createSha256, sha256Hex, sha256OfBlob } from '@/engine/model/sha256';

const encoder = new TextEncoder();

function nodeDigest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('SHA-256', () => {
  it('matches the published test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches Node across block boundaries', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1000, 100_000]) {
      const data = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) data[index] = (index * 31 + 7) % 256;
      expect(sha256Hex(data)).toBe(nodeDigest(data));
    }
  });

  it('hashes incrementally with arbitrary update sizes', () => {
    const data = encoder.encode('The quick brown fox jumps over the lazy dog. '.repeat(500));
    const hasher = new Sha256();

    for (let offset = 0; offset < data.length; offset += 37) {
      hasher.update(data.subarray(offset, offset + 37));
    }

    expect(hasher.hex()).toBe(nodeDigest(data));
  });

  it('hashes UTF-8 text and blobs in chunks', async () => {
    const text = 'ブラウザ内で完結する翻訳エンジン。'.repeat(100);
    expect(sha256Hex(text)).toBe(nodeDigest(encoder.encode(text)));

    const blob = new Blob([encoder.encode(text)]);
    expect(await sha256OfBlob(blob, { chunkSize: 7 })).toBe(nodeDigest(encoder.encode(text)));
  });

  it('streams the WASM core and the pure-JS fallback across arbitrary chunks', async () => {
    const data = new Uint8Array(2 * 1024 * 1024 + 17);
    for (let index = 0; index < data.length; index += 1) data[index] = (index * 31 + 11) % 256;
    const expected = nodeDigest(data);

    for (const preferWasm of [true, false]) {
      const hasher = await createSha256({ preferWasm });
      for (let offset = 0, step = 1; offset < data.length; step = (step * 7) % 65_537) {
        const end = Math.min(offset + Math.max(1, step), data.length);
        hasher.update(data.subarray(offset, end));
        offset = end;
      }
      expect(hasher.hex(), `preferWasm=${String(preferWasm)}`).toBe(expected);
    }
  });

  it('resets a streaming hasher without recreating it', async () => {
    const first = encoder.encode('first message');
    const second = encoder.encode('second message');
    const hasher = await createSha256();

    hasher.update(first);
    hasher.reset();
    hasher.update(second);

    expect(hasher.hex()).toBe(nodeDigest(second));
  });

  it('hashes much larger chunked input with sha256OfBlob', async () => {
    const data = new Uint8Array(1024 * 1024);
    for (let index = 0; index < data.length; index += 1) data[index] = (index * 7 + 3) % 256;
    const blob = new Blob([data]);

    await expect(sha256OfBlob(blob, { chunkSize: 8 * 1024 })).resolves.toBe(nodeDigest(data));
  });

  it('falls back to pure JS when WebAssembly is unavailable', async () => {
    const data = encoder.encode('fallback without wasm');
    vi.stubGlobal('WebAssembly', undefined);
    try {
      const blob = new Blob([data]);
      await expect(sha256OfBlob(blob, { chunkSize: 5 })).resolves.toBe(nodeDigest(data));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports hash progress and stops when the signal aborts', async () => {
    const data = encoder.encode('x'.repeat(100));
    const blob = new Blob([data]);
    const progress: number[] = [];

    await expect(
      sha256OfBlob(blob, {
        chunkSize: 4,
        onProgress: (hashed) => progress.push(hashed),
      }),
    ).resolves.toBe(nodeDigest(data));
    expect(progress.at(-1)).toBe(data.length);

    const controller = new AbortController();
    controller.abort();
    await expect(
      sha256OfBlob(blob, { chunkSize: 4, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('refuses to update after the digest is finalized', () => {
    const hasher = new Sha256();
    hasher.update(encoder.encode('a'));
    hasher.digest();
    expect(() => hasher.update(encoder.encode('b'))).toThrow();
    expect(() => hasher.digest()).toThrow();
  });
});
