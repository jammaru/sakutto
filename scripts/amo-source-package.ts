import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeZip, type ZipInput } from './zip-archive.ts';

const SKIP_DIRECTORY = new Set([
  'node_modules',
  '.git',
  '.output',
  'artifacts',
  'build',
  'build-compat',
  'esm',
  '.npm-cache',
  '.dist-staging',
]);

const SKIP_FILE = /\.(gguf|map|log)$/i;

export const AMO_SOURCE_LIMIT_BYTES = 200 * 1024 * 1024;

export function listGitFiles(root: string): string[] {
  const result = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'buffer' });
  if (result.status !== 0) {
    throw new Error('git ls-files failed; the AMO source zip needs a git checkout');
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function walk(directory: string, root: string, files: ZipInput[]): void {
  for (const name of readdirSync(directory)) {
    if (SKIP_DIRECTORY.has(name)) continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, root, files);
      continue;
    }
    if (SKIP_FILE.test(name)) continue;
    const relativeName = relative(root, path).replaceAll('\\', '/');
    files.push({ name: relativeName, data: readFileSync(path) });
  }
}

export function collectSourceFiles(root: string): ZipInput[] {
  const files: ZipInput[] = listGitFiles(root).map((name) => ({
    name,
    data: readFileSync(join(root, name)),
  }));

  const checkout = join(root, 'vendor', 'wllama', '.checkout');
  if (existsSync(checkout)) {
    walk(checkout, root, files);
  }

  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.name)) return false;
    seen.add(file.name);
    return true;
  });
}

export function sourceZipProblems(
  files: readonly ZipInput[],
  limit = AMO_SOURCE_LIMIT_BYTES,
): string[] {
  const problems: string[] = [];
  const names = new Set(files.map((file) => file.name));
  for (const required of [
    'SOURCE_CODE_REVIEW.md',
    'scripts/wllama/Dockerfile',
    'scripts/wllama/pins.ts',
    'package.json',
    'pnpm-lock.yaml',
  ]) {
    if (!names.has(required)) problems.push(`missing ${required}`);
  }
  const bytes = files.reduce((sum, file) => sum + file.data.length, 0);
  if (bytes > limit) {
    problems.push(`source package is ${String(bytes)} bytes, above ${String(limit)}`);
  }
  return problems;
}

function publish(root: string): void {
  const files = collectSourceFiles(root);
  const problems = sourceZipProblems(files);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
    return;
  }

  const output = join(root, '.output');
  mkdirSync(output, { recursive: true });
  const destination = join(output, 'sakutto-firefox-sources.zip');
  writeFileSync(destination, writeZip(files));
  console.log(
    `${destination} ${String(statSync(destination).size)} (${String(files.length)} files)`,
  );
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  publish(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
