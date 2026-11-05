import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from './zip-archive.ts';

export interface PackagedManifest {
  permissions?: readonly string[];
  optional_permissions?: readonly string[];
  host_permissions?: readonly string[];
  optional_host_permissions?: readonly string[];
}

export const REQUIRED_PERMISSIONS = [
  'activeTab',
  'contextMenus',
  'offscreen',
  'scripting',
  'storage',
  'unlimitedStorage',
] as const;

export const REQUIRED_HOST_PATTERNS = ['http://*/*', 'https://*/*'] as const;

export const REQUIRED_ENTRIES = [
  'manifest.json',
  'background.js',
  'popup.html',
  'options.html',
  'onboarding.html',
  'sample.html',
  'gpu-probe.js',
  'grant.html',
  'offscreen.html',
  'content-scripts/content.js',
  'icon/16.png',
  'icon/32.png',
  'icon/48.png',
  'icon/128.png',
  '_locales/en/messages.json',
  '_locales/ja/messages.json',
  'licenses/LICENSE.txt',
  'licenses/NOTICE.txt',
  'licenses/PLaMo-Community-License-en.txt',
  'licenses/PLaMo-Community-License-ja.txt',
  'licenses/llama.cpp-LICENSE.txt',
  'licenses/wllama-LICENSE.txt',
  'licenses/emscripten-LICENSE.txt',
  'licenses/dawn-LICENSE.txt',
  'licenses/svelte-LICENSE.txt',
  'vendor/wllama/wllama.js',
  'vendor/wllama/wllama.wasm',
  'vendor/wllama/wllama-worker.js',
  'vendor/wllama/wllama-module.js',
  'vendor/wllama/wllama-pthread.js',
  'vendor/wllama/wllama-compat.wasm',
  'vendor/wllama/wllama-compat-module.js',
  'vendor/wllama/wllama-compat-pthread.js',
  'vendor/wllama/wllama-build.json',
] as const;

const FORBIDDEN = [
  /\.gguf$/i,
  /\.map$/i,
  /(^|\/)\.env($|\.)/,
  /(^|\/)node_modules\//,
  /(^|\/)(tests|e2e|src)\//,
  /(^|\/)scripts\/bench\//,
  /kyoto\.html$/i,
  /\.md$/i,
  /\.tsx?$/i,
];

const REMOTE_CODE_MARKERS = ['cdn.jsdelivr.net'] as const;
const REMOTE_CODE_TEXT_FILES = /\.(js|mjs|html)$/i;

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const seen = new Set(actual);
  return expected.every((item) => seen.has(item));
}

export function auditPackage(entries: readonly string[], manifest: PackagedManifest): string[] {
  const problems: string[] = [];
  const names = new Set(entries);
  for (const entry of REQUIRED_ENTRIES) {
    if (!names.has(entry)) problems.push(`missing ${entry}`);
  }
  for (const entry of entries) {
    if (FORBIDDEN.some((pattern) => pattern.test(entry))) problems.push(`unexpected ${entry}`);
  }
  const permissions = manifest.permissions ?? [];
  if (!sameMembers(permissions, REQUIRED_PERMISSIONS)) {
    problems.push(`permissions ${permissions.join(',')}`);
  }
  if ((manifest.host_permissions ?? []).length > 0) {
    problems.push('host_permissions must stay empty');
  }
  const optionalHosts = manifest.optional_host_permissions ?? [];
  if (!sameMembers(optionalHosts, REQUIRED_HOST_PATTERNS)) {
    problems.push(`optional_host_permissions ${optionalHosts.join(',')}`);
  }
  if ((manifest.optional_permissions ?? []).length > 0) {
    problems.push('optional_permissions must stay empty');
  }
  return problems;
}

export function remoteCodeProblems(files: Iterable<readonly [string, string]>): string[] {
  const problems: string[] = [];
  for (const [name, text] of files) {
    if (!REMOTE_CODE_TEXT_FILES.test(name)) continue;
    for (const marker of REMOTE_CODE_MARKERS) {
      if (text.includes(marker)) problems.push(`${name} contains ${marker}`);
    }
  }
  return problems;
}

function findZip(outputDirectory: string): string {
  const zips = readdirSync(outputDirectory)
    .filter((name) => name.endsWith('.zip'))
    .map((name) => join(outputDirectory, name))
    .filter((path) => statSync(path).isFile())
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  const zip = zips[0];
  if (zip === undefined) throw new Error(`no zip in ${outputDirectory}`);
  return zip;
}

function inspectZip(zip: string): {
  entries: string[];
  manifest: PackagedManifest;
  texts: Array<readonly [string, string]>;
} {
  const archive = readZip(readFileSync(zip));
  const entries = [...archive.entries];
  const texts: Array<readonly [string, string]> = [];
  for (const name of entries) {
    if (!REMOTE_CODE_TEXT_FILES.test(name)) continue;
    texts.push([name, archive.read(name).toString('utf8')]);
  }
  return {
    entries,
    manifest: JSON.parse(archive.read('manifest.json').toString('utf8')) as PackagedManifest,
    texts,
  };
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const zip = findZip(join(root, '.output'));
  const inspected = inspectZip(zip);
  const problems = [
    ...auditPackage(inspected.entries, inspected.manifest),
    ...remoteCodeProblems(inspected.texts),
  ];
  if (problems.length > 0) {
    console.error(`${zip} failed the package check:`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${zip} matches the release package`);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) main();
