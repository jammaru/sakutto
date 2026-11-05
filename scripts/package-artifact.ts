import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_STORE_ZIP_BYTES = 1_048_576;

export interface ZipEntry {
  name: string;
  bytes: number;
}

export function storeZipProblems(entries: readonly ZipEntry[]): string[] {
  const zips = entries.filter((entry) => entry.name.endsWith('.zip'));
  if (zips.length === 0) return ['the store zip is missing'];
  return zips.flatMap((zip) =>
    zip.bytes < MIN_STORE_ZIP_BYTES
      ? [`${zip.name} is ${String(zip.bytes)} bytes, below ${String(MIN_STORE_ZIP_BYTES)}`]
      : [],
  );
}

function publish(root: string): void {
  const output = join(root, '.output');
  const names = existsSync(output)
    ? readdirSync(output).filter((name) => name.endsWith('.zip'))
    : [];
  const entries = names.map((name) => ({
    name,
    bytes: statSync(join(output, name)).size,
  }));
  const problems = storeZipProblems(entries);

  const unpacked = join(output, 'chrome-mv3');
  const manifest = join(unpacked, 'manifest.json');
  const wasm = join(unpacked, 'vendor', 'wllama', 'wllama.wasm');
  if (!existsSync(manifest)) problems.push('the unpacked extension is missing manifest.json');
  const wasmBytes = existsSync(wasm) ? statSync(wasm).size : 0;
  if (wasmBytes < MIN_STORE_ZIP_BYTES) {
    problems.push(
      `wllama.wasm is ${String(wasmBytes)} bytes, below ${String(MIN_STORE_ZIP_BYTES)}`,
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
    return;
  }

  const destination = join(root, 'artifacts');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(join(destination, 'store'), { recursive: true });
  for (const entry of entries) {
    cpSync(join(output, entry.name), join(destination, 'store', entry.name));
    console.log(`${entry.name} ${String(entry.bytes)}`);
  }
  cpSync(unpacked, join(destination, 'chrome-mv3'), { recursive: true });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(realpathSync(entry)).href;
}

if (isDirectRun()) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  publish(root);
}
