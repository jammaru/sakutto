#!/usr/bin/env node
/**
 * Compare the old sequential GGUF transfer with the parallel ranged download.
 *
 * The local server supports HTTP Range and can cap each connection's bandwidth. With a
 * per-connection cap, the old path is limited to roughly one cap while the parallel path can
 * aggregate several connections. Run it with:
 *
 *   pnpm bench:download --size-mb 32 --rate-mb 8 --concurrency 6 --runs 2 --hash=wasm
 *
 * `--no-range` makes the server ignore Range so the fallback path can be measured too.
 * `--no-redirect` serves the model directly instead of through a redirect endpoint.
 * `--hash=wasm|js|none` selects the parallel downloader's hashing path.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';

import {
  DEFAULT_CONCURRENCY,
  DEFAULT_SEGMENT_BYTES,
  downloadModel,
  type DownloadSource,
} from '../../src/engine/model/download.ts';
import type {
  ModelFileStat,
  ModelFileStore,
  ModelFileWriter,
  StorageEstimate,
} from '../../src/engine/model/file-store.ts';
import { installWorkerShim } from './node-worker.ts';

const PART = 'model.gguf.part';
const FINAL = 'model.gguf';
const CHUNK_BYTES = 64 * 1024;

type HashChoice = 'wasm' | 'js' | 'none';

interface BenchOptions {
  sizeMb: number;
  rateMb: number;
  concurrency: number;
  segmentMb: number;
  runs: number;
  range: boolean;
  redirect: boolean;
  hash: HashChoice;
}

interface Sample {
  mode: 'legacy' | 'parallel';
  seconds: number;
  mibPerSecond: number;
}

class BenchFileStore implements ModelFileStore {
  private readonly data: Uint8Array;
  private readonly lengths = new Map<string, number>();

  constructor(size: number) {
    this.data = new Uint8Array(size);
  }

  async size(path: string): Promise<number> {
    return this.lengths.get(path) ?? 0;
  }

  async stat(path: string): Promise<ModelFileStat | null> {
    const size = this.lengths.get(path);
    return size === undefined ? null : { size, lastModified: 0 };
  }

  async append(path: string, chunk: Uint8Array, offset: number): Promise<void> {
    this.data.set(chunk, offset);
    this.lengths.set(path, Math.max(this.lengths.get(path) ?? 0, offset + chunk.length));
  }

  async createWriter(path: string, offset: number): Promise<ModelFileWriter> {
    let position = offset;
    this.lengths.set(path, Math.max(this.lengths.get(path) ?? 0, offset));

    return {
      write: async (chunk: Uint8Array) => {
        if (position + chunk.length > this.data.length) {
          throw new Error('The benchmark file store overflowed.');
        }
        this.data.set(chunk, position);
        position += chunk.length;
        this.lengths.set(path, position);
      },
      close: async () => undefined,
    };
  }

  async read(path: string): Promise<Blob> {
    const length = this.lengths.get(path);
    if (length === undefined) throw new DOMException(`Missing ${path}`, 'NotFoundError');
    return new Blob([this.data.slice(0, length)]);
  }

  async move(from: string, to: string): Promise<void> {
    const length = this.lengths.get(from);
    if (length === undefined) throw new DOMException(`Missing ${from}`, 'NotFoundError');
    this.lengths.set(to, length);
    this.lengths.delete(from);
  }

  async remove(path: string): Promise<void> {
    this.lengths.delete(path);
  }

  async removeDirectory(path: string): Promise<void> {
    for (const key of [...this.lengths.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.lengths.delete(key);
    }
  }

  async estimate(): Promise<StorageEstimate> {
    return { usage: this.data.length, quota: this.data.length * 2 };
  }
}

interface Range {
  start: number;
  end: number;
}

function parseRange(value: string | undefined, size: number): Range | null {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value.trim());
  if (!match) return null;

  const start = Number(match[1] ?? '');
  const requestedEnd = match[2] ? Number(match[2]) + 1 : size;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) return null;
  if (start < 0 || start >= size || requestedEnd <= start) return null;
  return { start, end: Math.min(requestedEnd, size) };
}

function sendBody(
  response: ServerResponse,
  payload: Uint8Array,
  range: Range,
  rateMb: number,
): void {
  const length = range.end - range.start;
  const bytesPerSecond = rateMb > 0 ? rateMb * 1024 * 1024 : Infinity;
  const startedAt = Date.now();
  let sent = 0;
  let closed = false;

  response.on('close', () => {
    closed = true;
  });

  const schedule = (): void => {
    if (closed) return;
    if (sent >= length) {
      response.end();
      return;
    }

    if (Number.isFinite(bytesPerSecond)) {
      const target = startedAt + (sent / bytesPerSecond) * 1000;
      const wait = target - Date.now();
      if (wait > 0) {
        setTimeout(pump, wait);
        return;
      }
    }
    setImmediate(pump);
  };

  const pump = (): void => {
    if (closed) return;
    if (sent >= length) {
      response.end();
      return;
    }

    const take = Math.min(CHUNK_BYTES, length - sent);
    const start = range.start + sent;
    const writable = response.write(payload.subarray(start, start + take));
    sent += take;

    if (writable) schedule();
    else response.once('drain', schedule);
  };

  pump();
}

function startServer(
  payload: Uint8Array,
  options: { range: boolean; redirect: boolean; rateMb: number },
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (options.redirect && url.pathname === '/resolve') {
      response.writeHead(302, { Location: '/model' });
      response.end();
      return;
    }

    if (url.pathname !== '/model') {
      response.writeHead(404);
      response.end();
      return;
    }

    const requested = options.range ? parseRange(request.headers.range, payload.length) : null;
    if (requested) {
      response.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(requested.end - requested.start),
        'Content-Range': `bytes ${String(requested.start)}-${String(requested.end - 1)}/${String(payload.length)}`,
        'Accept-Ranges': 'bytes',
      });
      sendBody(response, payload, requested, options.rateMb);
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(payload.length),
      'Accept-Ranges': options.range ? 'bytes' : 'none',
    });
    sendBody(response, payload, { start: 0, end: payload.length }, options.rateMb);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('The benchmark server did not bind a port.'));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${String(address.port)}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function arg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function numberArg(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function readOptions(): BenchOptions {
  const hash = arg('--hash') ?? 'wasm';
  if (hash !== 'wasm' && hash !== 'js' && hash !== 'none') {
    throw new Error('--hash must be wasm, js, or none.');
  }
  return {
    sizeMb: numberArg('--size-mb', 32),
    rateMb: numberArg('--rate-mb', 8),
    concurrency: numberArg('--concurrency', DEFAULT_CONCURRENCY),
    segmentMb: numberArg('--segment-mb', DEFAULT_SEGMENT_BYTES / (1024 * 1024)),
    runs: numberArg('--runs', 1),
    range: !has('--no-range'),
    redirect: !has('--no-redirect'),
    hash,
  };
}

async function nodeHash(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return createHash('sha256').update(bytes).digest('hex');
}

async function legacyDownload(
  source: DownloadSource,
  store: BenchFileStore,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(source.url, {
    signal,
    cache: 'no-store',
    redirect: 'follow',
  });
  if (response.status !== 200 && response.status !== 206) {
    throw new Error(`The benchmark request failed with HTTP ${String(response.status)}.`);
  }
  if (!response.body) throw new Error('The benchmark response has no body.');

  const reader = response.body.getReader();
  const writer = await store.createWriter(PART, 0);
  let received = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      await writer.write(value);
      received += value.byteLength;
    }
  } finally {
    reader.releaseLock();
    await writer.close();
  }

  if (received !== source.size) {
    throw new Error(`The legacy transfer stopped at ${String(received)} bytes.`);
  }

  const digest = await nodeHash(await store.read(PART));
  if (digest !== source.sha256) {
    await store.remove(PART);
    throw new Error('The legacy download failed its digest check.');
  }
  await store.move(PART, FINAL);
}

async function runLegacy(source: DownloadSource, signal: AbortSignal): Promise<Sample> {
  const store = new BenchFileStore(source.size);
  const startedAt = performance.now();
  await legacyDownload(source, store, signal);
  const seconds = (performance.now() - startedAt) / 1000;
  return {
    mode: 'legacy',
    seconds,
    mibPerSecond: source.size / (1024 * 1024) / seconds,
  };
}

async function runParallel(
  source: DownloadSource,
  options: BenchOptions,
  signal: AbortSignal,
): Promise<Sample> {
  const store = new BenchFileStore(source.size);
  const startedAt = performance.now();
  await downloadModel({
    source,
    store,
    partPath: PART,
    finalPath: FINAL,
    signal,
    attempts: 3,
    retryDelayMs: 100,
    segmentBytes: Math.floor(options.segmentMb * 1024 * 1024),
    concurrency: options.concurrency,
    hash: options.hash,
  });
  const seconds = (performance.now() - startedAt) / 1000;
  return {
    mode: 'parallel',
    seconds,
    mibPerSecond: source.size / (1024 * 1024) / seconds,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

async function main(): Promise<void> {
  const options = readOptions();
  installWorkerShim();
  const size = Math.round(options.sizeMb * 1024 * 1024);
  const payload = new Uint8Array(size);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (index * 31 + 17) % 251;
  }

  const sha256 = createHash('sha256').update(payload).digest('hex');
  const server = await startServer(payload, {
    range: options.range,
    redirect: options.redirect,
    rateMb: options.rateMb,
  });
  const source: DownloadSource = {
    url: `${server.origin}${options.redirect ? '/resolve' : '/model'}`,
    size,
    sha256,
  };
  const controller = new AbortController();

  console.log(
    `payload ${options.sizeMb.toFixed(2)} MiB, per-connection cap ${options.rateMb.toFixed(2)} MiB/s, ` +
      `range ${options.range ? 'on' : 'off'}, redirect ${options.redirect ? 'on' : 'off'}, ` +
      `concurrency ${String(options.concurrency)}, segment ${options.segmentMb.toFixed(2)} MiB, ` +
      `hash ${options.hash}`,
  );

  const samples: Sample[] = [];
  try {
    for (let run = 1; run <= options.runs; run += 1) {
      const legacy = await runLegacy(source, controller.signal);
      const parallel = await runParallel(source, options, controller.signal);
      samples.push(legacy, parallel);
      console.log(
        `run ${String(run)}: legacy ${legacy.mibPerSecond.toFixed(2)} MiB/s ` +
          `(${legacy.seconds.toFixed(2)} s), parallel ${parallel.mibPerSecond.toFixed(2)} MiB/s ` +
          `(${parallel.seconds.toFixed(2)} s)`,
      );
    }
  } finally {
    await server.close();
  }

  const legacy = median(
    samples.filter((sample) => sample.mode === 'legacy').map((sample) => sample.mibPerSecond),
  );
  const parallel = median(
    samples.filter((sample) => sample.mode === 'parallel').map((sample) => sample.mibPerSecond),
  );
  console.log('');
  console.log(`legacy sequential: ${legacy.toFixed(2)} MiB/s`);
  console.log(`parallel ranged:   ${parallel.toFixed(2)} MiB/s`);
  console.log(`speedup:           ${(parallel / legacy).toFixed(2)}x`);
}

await main();
