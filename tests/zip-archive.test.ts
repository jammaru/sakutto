import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readZip } from '../scripts/zip-archive';

function zip(files: readonly { name: string; data: Buffer; method?: 0 | 8 }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const method = file.method ?? 8;
    const name = Buffer.from(file.name);
    const payload = method === 8 ? deflateRawSync(file.data) : file.data;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('readZip', () => {
  it('lists files and inflates manifest.json without the unzip program', () => {
    const manifest = Buffer.from('{"name":"Sakutto for PLaMo"}');
    const archive = readZip(
      zip([
        { name: 'vendor/', data: Buffer.alloc(0), method: 0 },
        { name: 'manifest.json', data: manifest },
        { name: 'vendor\\wllama\\wllama.wasm', data: Buffer.from('wasm'), method: 0 },
      ]),
    );

    expect(archive.entries).toEqual(['manifest.json', 'vendor/wllama/wllama.wasm']);
    expect(archive.read('manifest.json').toString('utf8')).toBe(manifest.toString('utf8'));
    expect(archive.read('vendor/wllama/wllama.wasm').toString('utf8')).toBe('wasm');
  });
});
