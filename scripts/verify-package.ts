import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIREFOX_EXTENSION_ID, FIREFOX_STRICT_MIN_VERSION } from '../src/shared/browser.ts';
import { CHROME_PERMISSIONS, FIREFOX_PERMISSIONS } from '../src/shared/manifest.ts';
import { UI_LOCALES } from '../src/shared/locales.ts';
import { readZip } from './zip-archive.ts';

export type PackageBrowser = 'chrome' | 'firefox';

export interface PackagedManifest {
  permissions?: readonly string[];
  optional_permissions?: readonly string[];
  host_permissions?: readonly string[];
  optional_host_permissions?: readonly string[];
  minimum_chrome_version?: string;
  offscreen?: unknown;
  cross_origin_embedder_policy?: unknown;
  cross_origin_opener_policy?: unknown;
  browser_specific_settings?: {
    gecko?: {
      id?: string;
      strict_min_version?: string;
      data_collection_permissions?: { required?: readonly string[] };
    };
  };
}

export const REQUIRED_PERMISSIONS = [...CHROME_PERMISSIONS];
export const FIREFOX_REQUIRED_PERMISSIONS = [...FIREFOX_PERMISSIONS];

export const REQUIRED_HOST_PATTERNS = ['http://*/*', 'https://*/*'] as const;

export const REQUIRED_ENTRIES = [
  'manifest.json',
  'background.js',
  'popup.html',
  'options.html',
  'onboarding.html',
  'sample.html',
  'typed.html',
  'gpu-probe.js',
  'grant.html',
  'offscreen.html',
  'content-scripts/content.js',
  'icon/16.png',
  'icon/32.png',
  'icon/48.png',
  'icon/128.png',
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

/**
 * Catalogs every package has to carry. The rest of `UI_LOCALES` is optional: a build that has
 * not translated a locale yet must not fail the audit, because the source tree is the place a
 * translation lands and the zip is built from it.
 *
 * `default_locale` is the one Chrome falls back to, so its absence is a broken install rather
 * than a missing translation. `ja` is here because the store listing is primarily Japanese.
 */
export const REQUIRED_LOCALES = ['en', 'ja'] as const;

const LOCALE_ENTRY = /^_locales\/([^/]+)\/messages\.json$/;

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

export function auditPackage(
  entries: readonly string[],
  manifest: PackagedManifest,
  browser: PackageBrowser = 'chrome',
): string[] {
  const problems: string[] = [];
  const names = new Set(entries);
  for (const entry of REQUIRED_ENTRIES) {
    if (!names.has(entry)) problems.push(`missing ${entry}`);
  }
  for (const locale of REQUIRED_LOCALES) {
    const entry = `_locales/${locale}/messages.json`;
    if (!names.has(entry)) problems.push(`missing ${entry}`);
  }
  // A catalog directory the source tree does not register is a locale Chrome will never pick,
  // and a registered locale with no catalog is a promise the build cannot keep. Both are
  // reported here so a translation PR cannot land half-wired.
  const shipped = new Set<string>();
  for (const entry of entries) {
    const match = LOCALE_ENTRY.exec(entry);
    if (match?.[1] === undefined) continue;
    shipped.add(match[1]);
    if (!(UI_LOCALES as readonly string[]).includes(match[1])) {
      problems.push(`unregistered locale _locales/${match[1]}`);
    }
  }
  for (const locale of UI_LOCALES) {
    if (!shipped.has(locale)) problems.push(`missing _locales/${locale}/messages.json`);
  }
  for (const entry of entries) {
    if (FORBIDDEN.some((pattern) => pattern.test(entry))) problems.push(`unexpected ${entry}`);
  }
  const permissions = manifest.permissions ?? [];
  const expectedPermissions =
    browser === 'firefox' ? FIREFOX_REQUIRED_PERMISSIONS : REQUIRED_PERMISSIONS;
  if (!sameMembers(permissions, expectedPermissions)) {
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
  if (browser === 'firefox') {
    if (permissions.includes('offscreen')) problems.push('firefox manifest has offscreen');
    if (manifest.minimum_chrome_version)
      problems.push('firefox manifest has minimum_chrome_version');
    if (manifest.cross_origin_embedder_policy) {
      problems.push('firefox manifest has cross_origin_embedder_policy');
    }
    if (manifest.cross_origin_opener_policy) {
      problems.push('firefox manifest has cross_origin_opener_policy');
    }
    const gecko = manifest.browser_specific_settings?.gecko;
    if (gecko?.id !== FIREFOX_EXTENSION_ID) {
      problems.push(`gecko.id ${gecko?.id ?? 'missing'}`);
    }
    if (gecko?.strict_min_version !== FIREFOX_STRICT_MIN_VERSION) {
      problems.push(`gecko.strict_min_version ${gecko?.strict_min_version ?? 'missing'}`);
    }
    const collection = gecko?.data_collection_permissions?.required ?? [];
    if (!sameMembers(collection, ['none'])) {
      problems.push(`data_collection_permissions ${collection.join(',')}`);
    }
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

function findZip(outputDirectory: string, browser: PackageBrowser): string {
  const zips = readdirSync(outputDirectory)
    .filter((name) => name.endsWith('.zip'))
    .filter((name) => !name.includes('sources'))
    .map((name) => join(outputDirectory, name))
    .filter((path) => statSync(path).isFile())
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  const named = zips.find((path) => path.includes(browser));
  const zip = named ?? zips[0];
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

function parseBrowser(argv: readonly string[]): PackageBrowser {
  const flag = argv.find((arg) => arg.startsWith('--browser='));
  const index = argv.indexOf('--browser');
  const value = flag?.slice('--browser='.length) ?? (index >= 0 ? argv[index + 1] : undefined);
  return value === 'firefox' ? 'firefox' : 'chrome';
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const browser = parseBrowser(process.argv.slice(2));
  const zip = findZip(join(root, '.output'), browser);
  const inspected = inspectZip(zip);
  const problems = [
    ...auditPackage(inspected.entries, inspected.manifest, browser),
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
