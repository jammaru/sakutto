/**
 * Compare the hashing paths used by the model downloader.
 *
 *   pnpm bench:sha256 --size-mb 64 --chunk-kb 4096 --runs 3
 *
 * `pure-JS` is the old `Sha256` fallback used by the full-file pass. The reported browser run
 * measured about 46 MiB/s (~38 s after a 1.7 GiB transfer), including Blob reads and yields;
 * raw hashing on a desktop CPU can be several times that, which is why the script prints the
 * actual number instead of assuming one. `streaming WASM` is the hasher the downloader now
 * updates as ordered blocks land. `webcrypto` is the whole-buffer `crypto.subtle.digest`
 * baseline; it is fast but needs the entire file in memory and has no streaming API.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { createSha256, Sha256 } from '../../src/engine/model/sha256.ts';

interface BenchOptions {
  sizeMb: number;
  chunkKb: number;
  runs: number;
}

interface Sample {
  label: string;
  mibPerSecond: number;
  seconds: number;
}

function readOptions(): BenchOptions {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith('--')) continue;
    const value = args[index + 1];
    if (value !== undefined && !value.startsWith('--')) {
      values.set(key.slice(2), value);
      index += 1;
    }
  }

  const number = (name: string, fallback: number): number => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    sizeMb: number('size-mb', 64),
    chunkKb: number('chunk-kb', 4096),
    runs: Math.max(1, Math.floor(number('runs', 3))),
  };
}

function deterministicBytes(length: number): Uint8Array {
  const data = new Uint8Array(length);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = (index * 31 + 17) % 251;
  }
  return data;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

async function measure(
  label: string,
  size: number,
  expected: string,
  runs: number,
  hash: () => Promise<string> | string,
): Promise<Sample> {
  const seconds: number[] = [];
  let digest = '';

  for (let run = 0; run < runs; run += 1) {
    const startedAt = performance.now();
    digest = await hash();
    seconds.push((performance.now() - startedAt) / 1000);
  }

  if (digest !== expected) {
    throw new Error(`${label} produced ${digest}; expected ${expected}`);
  }

  const middle = median(seconds);
  const mibPerSecond = middle > 0 ? size / (1024 * 1024) / middle : 0;
  return { label, seconds: middle, mibPerSecond };
}

async function main(): Promise<void> {
  const options = readOptions();
  const size = Math.round(options.sizeMb * 1024 * 1024);
  const chunkSize = Math.max(1, Math.round(options.chunkKb * 1024));
  const data = deterministicBytes(size);
  const expected = createHash('sha256').update(data).digest('hex');

  const hashWithJs = (): string => {
    const hasher = new Sha256();
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      hasher.update(data.subarray(offset, offset + chunkSize));
    }
    return hasher.hex();
  };

  const hashWithWasm = async (): Promise<string> => {
    const hasher = await createSha256();
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      hasher.update(data.subarray(offset, offset + chunkSize));
    }
    return hasher.hex();
  };

  const hashWithWebCrypto = async (): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer);
    return Buffer.from(digest).toString('hex');
  };

  console.log(
    `payload ${options.sizeMb.toFixed(2)} MiB, chunk ${(chunkSize / 1024).toFixed(0)} KiB, ` +
      `${String(options.runs)} run(s)`,
  );

  const samples = [
    await measure('pure-JS Sha256 (before)', size, expected, options.runs, hashWithJs),
    await measure('streaming WASM (after)', size, expected, options.runs, hashWithWasm),
    await measure('crypto.subtle whole buffer', size, expected, options.runs, hashWithWebCrypto),
  ];

  for (const sample of samples) {
    console.log(
      `${sample.label.padEnd(30)} ${sample.mibPerSecond.toFixed(2).padStart(8)} MiB/s ` +
        `(${sample.seconds.toFixed(3)} s)`,
    );
  }

  const js = samples[0];
  const wasm = samples[1];
  if (js && wasm) {
    console.log(
      `streaming WASM is ${(wasm.mibPerSecond / js.mibPerSecond).toFixed(2)}x the JS fallback`,
    );
  }
  console.log(
    'Production difference: the WASM hasher runs during the transfer, so the end-of-download ' +
      'pass disappears; only a resumed .part prefix is hashed again.',
  );
}

await main();
