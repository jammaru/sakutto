import { describe, expect, it } from 'vitest';
import {
  FIREFOX_EXTENSION_ID,
  FIREFOX_STRICT_MIN_VERSION,
  extensionBrowser,
  hasBuiltInTranslatorUi,
  isBraveBrowser,
  isFirefoxBuild,
  isMicrosoftEdge,
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

  it('detects Brave only from navigator.brave for explanatory copy', () => {
    expect(isBraveBrowser({ brave: true })).toBe(true);
    expect(isBraveBrowser({ brave: {} })).toBe(true);
    expect(isBraveBrowser({ brave: false })).toBe(false);
    expect(isBraveBrowser({})).toBe(false);
    expect(isBraveBrowser(undefined)).toBe(false);
  });

  it('detects Chromium Edge from the UA brand or Edg/ token, not legacy EdgeHTML', () => {
    expect(isMicrosoftEdge({ userAgent: 'Chrome/144.0.0.0' })).toBe(false);
    expect(isMicrosoftEdge({ userAgent: 'Edg/144.0.0.0' })).toBe(true);
    expect(isMicrosoftEdge({ brands: [{ brand: 'Microsoft Edge', version: '144' }] })).toBe(true);
    expect(isMicrosoftEdge({ userAgent: 'Edge/18.18363' })).toBe(false);
  });
});
