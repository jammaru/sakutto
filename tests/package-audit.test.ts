import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UI_LOCALES } from '../src/shared/locales.ts';
import {
  REQUIRED_ENTRIES,
  REQUIRED_LOCALES,
  auditPackage,
  remoteCodeProblems,
  type PackagedManifest,
} from '../scripts/verify-package.ts';

const LOCALE_ENTRIES = UI_LOCALES.map((locale) => `_locales/${locale}/messages.json`);

/** Every entry a correct release package has. */
const COMPLETE = [...REQUIRED_ENTRIES, ...LOCALE_ENTRIES];

function manifest(overrides: PackagedManifest = {}): PackagedManifest {
  return {
    permissions: [
      'offscreen',
      'storage',
      'unlimitedStorage',
      'activeTab',
      'scripting',
      'contextMenus',
    ],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    ...overrides,
  };
}

describe('auditPackage', () => {
  it('accepts the required runtime, licenses, locales, and permissions', () => {
    expect(auditPackage(COMPLETE, manifest())).toEqual([]);
  });

  it('accepts a Firefox package without offscreen and with a pinned gecko id', () => {
    expect(
      auditPackage(
        COMPLETE,
        manifest({
          permissions: ['storage', 'unlimitedStorage', 'activeTab', 'scripting', 'contextMenus'],
          browser_specific_settings: {
            gecko: {
              id: 'sakutto@jammaru',
              strict_min_version: '153.0',
              data_collection_permissions: { required: ['none'] },
            },
          },
        }),
        'firefox',
      ),
    ).toEqual([]);
  });

  it('rejects a Firefox package that still asks for offscreen or Chrome isolation keys', () => {
    const problems = auditPackage(
      COMPLETE,
      manifest({
        minimum_chrome_version: '116',
        cross_origin_embedder_policy: { value: 'require-corp' },
        cross_origin_opener_policy: { value: 'same-origin' },
      }),
      'firefox',
    );
    expect(problems.some((problem) => problem.startsWith('permissions '))).toBe(true);
    expect(problems).toContain('firefox manifest has minimum_chrome_version');
    expect(problems).toContain('firefox manifest has cross_origin_embedder_policy');
    expect(problems).toContain('firefox manifest has cross_origin_opener_policy');
    expect(problems).toContain('gecko.id missing');
  });

  it('rejects a package that omits the wasm or includes weights', () => {
    const entries = COMPLETE.filter((entry) => entry !== 'vendor/wllama/wllama.wasm');
    const problems = auditPackage(
      [...entries, 'models/plamo.gguf', 'chunks/app.js.map'],
      manifest(),
    );
    expect(problems).toContain('missing vendor/wllama/wllama.wasm');
    expect(problems).toContain('unexpected models/plamo.gguf');
    expect(problems).toContain('unexpected chunks/app.js.map');
  });

  it('rejects the Wikipedia bench fixture', () => {
    const problems = auditPackage([...COMPLETE, 'scripts/bench/fixtures/kyoto.html'], manifest());
    expect(problems).toContain('unexpected scripts/bench/fixtures/kyoto.html');
  });

  it('rejects install-time host permissions', () => {
    const problems = auditPackage(COMPLETE, manifest({ host_permissions: ['https://*/*'] }));
    expect(problems).toContain('host_permissions must stay empty');
  });

  /**
   * `default_locale` is the catalog Chrome falls back to. A package without it installs and
   * then shows raw `__MSG_…__` keys, so it is a hard failure rather than a missing translation.
   */
  it('rejects a package missing a locale the manifest falls back to', () => {
    for (const locale of REQUIRED_LOCALES) {
      const entries = COMPLETE.filter((entry) => entry !== `_locales/${locale}/messages.json`);
      expect(auditPackage(entries, manifest())).toContain(
        `missing _locales/${locale}/messages.json`,
      );
    }
  });

  it('rejects a registered locale whose catalog is not in the package', () => {
    const optional = UI_LOCALES.find(
      (locale) => !(REQUIRED_LOCALES as readonly string[]).includes(locale),
    );
    expect(optional).toBeDefined();
    const entries = COMPLETE.filter((entry) => entry !== `_locales/${optional}/messages.json`);
    expect(auditPackage(entries, manifest())).toContain(
      `missing _locales/${optional}/messages.json`,
    );
  });

  it('rejects a catalog directory the source does not register', () => {
    const problems = auditPackage([...COMPLETE, '_locales/xx/messages.json'], manifest());
    expect(problems).toContain('unregistered locale _locales/xx');
  });

  it('rejects packaged scripts that still point at jsDelivr', () => {
    expect(
      remoteCodeProblems([
        ['vendor/wllama/wllama.js', 'const wasm = "/vendor/wllama/wllama.wasm";'],
        ['popup.html', '<script src="popup.js"></script>'],
      ]),
    ).toEqual([]);
    expect(
      remoteCodeProblems([
        [
          'vendor/wllama/wllama.js',
          'import { x } from "https://cdn.jsdelivr.net/npm/@wllama/wllama@3.12.0/wasm";',
        ],
      ]),
    ).toEqual(['vendor/wllama/wllama.js contains cdn.jsdelivr.net']);
  });

  it('lets node load the firefox package-audit import chain', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { FIREFOX_PERMISSIONS } from './src/shared/manifest.ts'; if (!FIREFOX_PERMISSIONS.includes('storage')) process.exit(2);",
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.stderr, result.stderr).toBe('');
    expect(result.status, result.stdout).toBe(0);
  });
});
