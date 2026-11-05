import { describe, expect, it } from 'vitest';
import { isExtensionAssetUrl, resolveWllamaAssetUrls } from '../src/engine/wllama/assets';

const ORIGIN = 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef';

function extensionUrl(path: string): string {
  return `${ORIGIN}/${path}`;
}

describe('wllama asset urls', () => {
  it('points every asset at the packaged vendor directory', () => {
    expect(resolveWllamaAssetUrls(extensionUrl)).toEqual({
      library: `${ORIGIN}/vendor/wllama/wllama.js`,
      wasm: `${ORIGIN}/vendor/wllama/wllama.wasm`,
      worker: `${ORIGIN}/vendor/wllama/wllama-worker.js`,
      module: `${ORIGIN}/vendor/wllama/wllama-module.js`,
      pthread: `${ORIGIN}/vendor/wllama/wllama-pthread.js`,
      compatWasm: `${ORIGIN}/vendor/wllama/wllama-compat.wasm`,
      compatModule: `${ORIGIN}/vendor/wllama/wllama-compat-module.js`,
      compatPthread: `${ORIGIN}/vendor/wllama/wllama-compat-pthread.js`,
    });
  });

  it('leaves the origin and scheme to the runtime resolver', () => {
    const urls = resolveWllamaAssetUrls((path) => `moz-extension://unit-test/${path}`);

    expect(urls.library).toBe('moz-extension://unit-test/vendor/wllama/wllama.js');
    expect(
      Object.values(urls).every((url) => url.startsWith('moz-extension://unit-test/vendor/')),
    ).toBe(true);
  });

  it('accepts only paths under the extension origin', () => {
    const base = `${ORIGIN}/`;

    expect(isExtensionAssetUrl(`${ORIGIN}/vendor/wllama/wllama.js`, base)).toBe(true);
    expect(
      isExtensionAssetUrl('chrome-extension://otherotherotherotherotherother/a.js', base),
    ).toBe(false);
    expect(isExtensionAssetUrl('https://example.com/wllama.js', base)).toBe(false);
    expect(isExtensionAssetUrl('not a url', base)).toBe(false);
  });
});
