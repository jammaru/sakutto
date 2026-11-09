import { describe, expect, it } from 'vitest';
import {
  FIREFOX_EXTENSION_ID,
  FIREFOX_STRICT_MIN_VERSION,
  extensionBrowser,
  hasBuiltInTranslatorUi,
  isFirefoxBuild,
} from '@/shared/browser';

describe('browser build flags', () => {
  it('treats unit tests as a Chrome bundle', () => {
    expect(extensionBrowser()).toBe('chrome');
    expect(isFirefoxBuild()).toBe(false);
    expect(hasBuiltInTranslatorUi()).toBe(true);
  });

  it('pins a gecko id and a JSPI-era minimum Firefox', () => {
    expect(FIREFOX_EXTENSION_ID).toBe('sakutto@jammaru');
    expect(FIREFOX_STRICT_MIN_VERSION).toBe('153.0');
  });
});
