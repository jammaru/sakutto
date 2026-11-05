import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const SIZES = [16, 32, 48, 128] as const;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngChunk {
  type: string;
  data: Buffer;
  checksum: number;
}

function readChunks(buffer: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  let offset = SIGNATURE.length;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const checksum = buffer.readUInt32BE(offset + 8 + length);
    chunks.push({ type, data, checksum });
    offset += length + 12;
  }

  return chunks;
}

describe('generated icons', () => {
  it.each(SIZES)('writes a valid %ipx PNG', (size) => {
    const file = readFileSync(new URL(`../public/icon/${size}.png`, import.meta.url));
    expect(file.subarray(0, SIGNATURE.length)).toEqual(SIGNATURE);

    const chunks = readChunks(file);
    expect(chunks[0]?.type).toBe('IHDR');

    for (const chunk of chunks) {
      const expected = crc32(Buffer.concat([Buffer.from(chunk.type, 'ascii'), chunk.data]));
      expect(chunk.checksum, chunk.type).toBe(expected);
    }

    expect(chunks[0]?.data.readUInt32BE(0)).toBe(size);
    expect(chunks[0]?.data.readUInt32BE(4)).toBe(size);
  });
});
