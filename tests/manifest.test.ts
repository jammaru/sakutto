import { describe, expect, it } from 'vitest';
import { FIREFOX_EXTENSION_ID, FIREFOX_STRICT_MIN_VERSION } from '@/shared/browser';
import { CHROME_DEFAULT_SHORTCUTS, FIREFOX_DEFAULT_SHORTCUTS } from '@/shared/shortcuts';
import config from '../wxt.config';

function manifestFor(browser: 'chrome' | 'firefox'): Record<string, unknown> {
  const factory = config.manifest;
  if (typeof factory !== 'function') throw new Error('expected a manifest factory');
  return factory({
    browser,
    manifestVersion: 3,
    command: 'build',
    mode: 'production',
  } as never) as Record<string, unknown>;
}

const chromeManifest = manifestFor('chrome');
const firefoxManifest = manifestFor('firefox');

describe('extension manifest', () => {
  it('uses the localized name and description', () => {
    expect(chromeManifest.name).toBe('__MSG_extensionName__');
    expect(chromeManifest.short_name).toBe('__MSG_extensionShortName__');
    expect(chromeManifest.description).toBe('__MSG_extensionDescription__');
    expect(chromeManifest.default_locale).toBe('en');
    expect(config.manifestVersion).toBe(3);
  });

  it('requests only the permissions the Chrome extension uses', () => {
    expect(chromeManifest.permissions).toEqual([
      'offscreen',
      'storage',
      'unlimitedStorage',
      'activeTab',
      'scripting',
      'contextMenus',
    ]);
    expect(chromeManifest).not.toHaveProperty('host_permissions');
    expect(chromeManifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
  });

  it('sets a minimum Chrome version that supports offscreen documents', () => {
    expect(chromeManifest.minimum_chrome_version).toBe('116');
  });

  it('locks the Chrome extension pages down to bundled scripts and wasm', () => {
    expect(chromeManifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    });
    expect(chromeManifest.cross_origin_embedder_policy).toEqual({ value: 'require-corp' });
    expect(chromeManifest.cross_origin_opener_policy).toEqual({ value: 'same-origin' });
  });

  it('declares the Chrome translation shortcuts', () => {
    expect(chromeManifest.commands).toEqual({
      'translate-page': {
        suggested_key: { default: 'Alt+A' },
        description: '__MSG_commandTranslate__',
      },
      'toggle-bilingual': {
        suggested_key: { default: 'Alt+B' },
        description: '__MSG_commandBilingual__',
      },
      'translate-selection': {
        suggested_key: { default: 'Alt+S' },
        description: '__MSG_commandSelection__',
      },
      'translate-compose': {
        suggested_key: { default: 'Alt+T' },
        description: '__MSG_commandCompose__',
      },
    });
    expect(chromeManifest.permissions).toContain('contextMenus');
    const withSuggested = Object.values(
      chromeManifest.commands as Record<string, { suggested_key?: unknown }>,
    ).filter((command) => command.suggested_key !== undefined);
    expect(withSuggested).toHaveLength(4);
  });

  /**
   * Chrome starts every user on the manifest key, and the hints a page shows before the
   * background answers name that same key. A default that moved in one place only would make
   * the popup advertise a shortcut Chrome never bound.
   */
  it('suggests the same Chrome default the page falls back to', () => {
    const commands = chromeManifest.commands as Record<
      string,
      { suggested_key: { default: string } }
    >;
    for (const [name, shortcut] of Object.entries(CHROME_DEFAULT_SHORTCUTS)) {
      expect(commands[name]?.suggested_key.default, name).toBe(shortcut);
    }
  });

  it('points every icon size at a bundled PNG', () => {
    expect(chromeManifest.icons).toEqual({
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    });
  });
});

describe('Firefox manifest', () => {
  it('drops Chrome-only keys and pins a gecko id that cannot change after first upload', () => {
    expect(firefoxManifest.permissions).toEqual([
      'storage',
      'unlimitedStorage',
      'activeTab',
      'scripting',
      'contextMenus',
    ]);
    expect(firefoxManifest.permissions).not.toContain('offscreen');
    expect(firefoxManifest).not.toHaveProperty('minimum_chrome_version');
    expect(firefoxManifest).not.toHaveProperty('cross_origin_embedder_policy');
    expect(firefoxManifest).not.toHaveProperty('cross_origin_opener_policy');
    const gecko = (
      firefoxManifest.browser_specific_settings as {
        gecko: {
          id: string;
          strict_min_version: string;
          data_collection_permissions: { required: string[] };
        };
      }
    ).gecko;
    expect(gecko.id).toBe(FIREFOX_EXTENSION_ID);
    expect(gecko.strict_min_version).toBe(FIREFOX_STRICT_MIN_VERSION);
    expect(gecko.data_collection_permissions).toEqual({ required: ['none'] });
  });

  it('suggests Alt+Shift defaults that match the content-script fallback', () => {
    const commands = firefoxManifest.commands as Record<
      string,
      { suggested_key: { default: string } }
    >;
    for (const [name, shortcut] of Object.entries(FIREFOX_DEFAULT_SHORTCUTS)) {
      expect(commands[name]?.suggested_key.default, name).toBe(shortcut);
    }
  });

  it('keeps the same CSP as Chrome so wasm can compile', () => {
    expect(firefoxManifest.content_security_policy).toEqual(chromeManifest.content_security_policy);
  });
});
