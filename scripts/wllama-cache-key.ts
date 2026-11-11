import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EMSDK_TAG } from './wllama/pins.ts';

export const WLLAMA_CACHE_PREFIX = 'wllama-v2';

const OPTIONAL_PATCH_DIR = 'scripts/wllama/patches/optional';
const KICK_FILE = 'src/engine/wllama/firefox-webgpu-kick.ts';

export function repoRootFrom(moduleUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..');
}

function isOptionalPatch(relativePath: string): boolean {
  return relativePath === OPTIONAL_PATCH_DIR || relativePath.startsWith(`${OPTIONAL_PATCH_DIR}/`);
}

function walkFiles(root: string, directory: string, files: string[]): void {
  for (const entry of readdirSync(directory).sort()) {
    const absolute = join(directory, entry);
    const relativePath = relative(root, absolute).replaceAll('\\', '/');
    if (isOptionalPatch(relativePath)) continue;
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      walkFiles(root, absolute, files);
      continue;
    }
    if (stats.isFile()) files.push(relativePath);
  }
}

/** Paths whose contents change the compiled wasm or the generated worker. */
export function wllamaCacheInputPaths(root: string): string[] {
  const files: string[] = [];
  walkFiles(root, join(root, 'scripts', 'wllama'), files);
  files.push(KICK_FILE);
  return [...new Set(files)].sort();
}

export function hashWllamaCacheInputs(root: string): string {
  const hash = createHash('sha256');
  for (const relativePath of wllamaCacheInputPaths(root)) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(readFileSync(join(root, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function wllamaCacheKey(root: string, prefix = WLLAMA_CACHE_PREFIX): string {
  return `${prefix}-${hashWllamaCacheInputs(root)}`;
}

export function wllamaCacheOutputs(
  root: string,
  prefix = WLLAMA_CACHE_PREFIX,
): {
  hash: string;
  tag: string;
  key: string;
  files: string[];
} {
  const files = wllamaCacheInputPaths(root);
  const hash = hashWllamaCacheInputs(root);
  return { hash, tag: EMSDK_TAG, key: `${prefix}-${hash}`, files };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(realpathSync(entry)).href;
}

if (isDirectRun()) {
  const root = repoRootFrom();
  const { hash, tag, key, files } = wllamaCacheOutputs(root);
  const github = process.argv.includes('--github');
  if (github) {
    process.stdout.write(`hash=${hash}\n`);
    process.stdout.write(`tag=${tag}\n`);
    process.stdout.write(`key=${key}\n`);
    process.stdout.write(`files=${files.length}\n`);
  } else {
    process.stdout.write(`${key}\n`);
  }
}
