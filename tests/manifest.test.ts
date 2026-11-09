import { describe, expect, it } from 'vitest';
import { DEFAULT_SHORTCUTS } from '@/shared/shortcuts';
import config from '../wxt.config';

const manifest = config.manifest as unknown as Record<string, unknown>;

describe('extension manifest', () => {
  it('uses the localized name and description', () => {
    expect(manifest.name).toBe('__MSG_extensionName__');
    expect(manifest.short_name).toBe('__MSG_extensionShortName__');
    expect(manifest.description).toBe('__MSG_extensionDescription__');
    expect(manifest.default_locale).toBe('en');
    expect(config.manifestVersion).toBe(3);
  });

  it('requests only the permissions the extension uses', () => {
    expect(manifest.permissions).toEqual([
      'offscreen',
      'storage',
      'unlimitedStorage',
      'activeTab',
      'scripting',
      'contextMenus',
    ]);
    expect(manifest).not.toHaveProperty('host_permissions');
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
  });

  it('sets a minimum Chrome version that supports offscreen documents', () => {
    expect(manifest.minimum_chrome_version).toBe('116');
  });

  it('locks the extension pages down to bundled scripts and wasm', () => {
    expect(manifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    });
    expect(manifest.cross_origin_embedder_policy).toEqual({ value: 'require-corp' });
    expect(manifest.cross_origin_opener_policy).toEqual({ value: 'same-origin' });
  });

  it('declares the translation shortcuts', () => {
    expect(manifest.commands).toEqual({
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
    });
    expect(manifest.permissions).toContain('contextMenus');
  });

  /**
   * Chrome starts every user on the manifest key, and the hints a page shows before the
   * background answers name that same key. A default that moved in one place only would make
   * the popup advertise a shortcut Chrome never bound.
   */
  it('suggests the same default the page falls back to', () => {
    const commands = manifest.commands as Record<string, { suggested_key: { default: string } }>;
    for (const [name, shortcut] of Object.entries(DEFAULT_SHORTCUTS)) {
      expect(commands[name]?.suggested_key.default, name).toBe(shortcut);
    }
  });

  it('points every icon size at a bundled PNG', () => {
    expect(manifest.icons).toEqual({
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    });
  });
});
