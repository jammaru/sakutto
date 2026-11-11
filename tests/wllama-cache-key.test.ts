import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  WLLAMA_CACHE_PREFIX,
  hashWllamaCacheInputs,
  repoRootFrom,
  wllamaCacheInputPaths,
  wllamaCacheKey,
} from '../scripts/wllama-cache-key.ts';

const root = repoRootFrom(new URL('../scripts/wllama-cache-key.ts', import.meta.url).href);

describe('wllama cache key', () => {
  it('hashes the applied patches and the Firefox kick helper, not optional patches', () => {
    const files = wllamaCacheInputPaths(root);
    expect(files).toContain('scripts/wllama/pins.ts');
    expect(files).toContain('scripts/wllama/patches/0001-static-worker-script.patch');
    expect(files).toContain('src/engine/wllama/firefox-webgpu-kick.ts');
    expect(files.some((file) => file.includes('patches/optional'))).toBe(false);
    expect(files).not.toContain('scripts/wllama-cache-key.ts');
  });

  it('is deterministic', () => {
    expect(hashWllamaCacheInputs(root)).toBe(hashWllamaCacheInputs(root));
    expect(wllamaCacheKey(root).startsWith(`${WLLAMA_CACHE_PREFIX}-`)).toBe(true);
    expect(wllamaCacheKey(root).length).toBeGreaterThan(20);
  });

  it('keeps the prefix in the build action so a bust is one string change', () => {
    const action = readFileSync(
      new URL('../.github/actions/build-wllama/action.yml', import.meta.url),
      'utf8',
    );
    expect(action).toContain('node scripts/wllama-cache-key.ts --github');
    expect(action).toContain('from-source');
    expect(action).toContain('node scripts/verify-wllama.mjs');
    expect(action).toContain('node scripts/wllama/build.ts');
    expect(action).not.toContain('restore-keys:');
  });
});
