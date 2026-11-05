import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256, sha256Hex, sha256OfBlob } from '@/engine/model/sha256';

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
