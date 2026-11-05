import { describe, expect, it } from 'vitest';
import {
  REQUIRED_ENTRIES,
  auditPackage,
  remoteCodeProblems,
  type PackagedManifest,
} from '../scripts/verify-package.ts';

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
  it('accepts the required runtime, licenses, and permissions', () => {
    expect(auditPackage(REQUIRED_ENTRIES, manifest())).toEqual([]);
  });

  it('rejects a package that omits the wasm or includes weights', () => {
    const entries = REQUIRED_ENTRIES.filter((entry) => entry !== 'vendor/wllama/wllama.wasm');
    const problems = auditPackage(
      [...entries, 'models/plamo.gguf', 'chunks/app.js.map'],
      manifest(),
    );
    expect(problems).toContain('missing vendor/wllama/wllama.wasm');
    expect(problems).toContain('unexpected models/plamo.gguf');
    expect(problems).toContain('unexpected chunks/app.js.map');
  });

  it('rejects the Wikipedia bench fixture', () => {
    const problems = auditPackage(
      [...REQUIRED_ENTRIES, 'scripts/bench/fixtures/kyoto.html'],
      manifest(),
    );
    expect(problems).toContain('unexpected scripts/bench/fixtures/kyoto.html');
  });

  it('rejects install-time host permissions', () => {
    const problems = auditPackage(
      REQUIRED_ENTRIES,
      manifest({ host_permissions: ['https://*/*'] }),
    );
    expect(problems).toContain('host_permissions must stay empty');
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
});
