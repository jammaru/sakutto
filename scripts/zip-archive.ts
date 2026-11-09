import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

interface ZipRecord {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

export interface ZipArchive {
  entries: readonly string[];
  read(name: string): Buffer;
}

export function readZip(bytes: Buffer): ZipArchive {
  const records = readCentralDirectory(bytes);
  const byName = new Map(records.map((record) => [record.name, record]));

  return {
    entries: records.map((record) => record.name).filter((name) => !name.endsWith('/')),
    read(name: string): Buffer {
      const record = byName.get(name);
      if (!record) throw new Error(`zip entry ${name} was not found`);
      return readRecord(bytes, record);
    },
  };
}

function readCentralDirectory(bytes: Buffer): ZipRecord[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const count = bytes.readUInt16LE(eocd + 10);
  const offset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }

  const records: ZipRecord[] = [];
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_HEADER) {
      throw new Error('the zip central directory is truncated');
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    if ((flags & 0x1) !== 0) throw new Error('encrypted zip entries are not supported');
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) throw new Error('the zip central directory is truncated');
    const name = bytes.subarray(nameStart, nameEnd).toString('utf8').replaceAll('\\', '/');
    records.push({ name, method, compressedSize, localOffset });
    cursor = nameEnd + extraLength + commentLength;
  }
  return records;
}

function readRecord(bytes: Buffer, record: ZipRecord): Buffer {
  const { localOffset } = record;
  if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL_HEADER) {
    throw new Error(`zip entry ${record.name} has no local header`);
  }
  const nameLength = bytes.readUInt16LE(localOffset + 26);
  const extraLength = bytes.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + record.compressedSize;
  if (end > bytes.length) throw new Error(`zip entry ${record.name} is truncated`);
  const data = bytes.subarray(start, end);
  if (record.method === 0) return Buffer.from(data);
  if (record.method === 8) return inflateRawSync(data);
  throw new Error(`zip entry ${record.name} uses compression method ${String(record.method)}`);
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  throw new Error('the zip end of central directory was not found');
}

export interface ZipInput {
  name: string;
  data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP32 archive of stored or deflated entries. Names must use `/`. */
export function writeZip(files: readonly ZipInput[], compress = true): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name.replaceAll('\\', '/'), 'utf8');
    const data = file.data;
    const checksum = crc32(data);
    const compressed = compress ? deflateRawSync(data) : data;
    const method = compress ? 8 : 0;
    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralStart = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
