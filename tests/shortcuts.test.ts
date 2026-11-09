import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SELECTION_SHORTCUT,
  DEFAULT_SHORTCUTS,
  ariaShortcut,
  displayShortcut,
  isPlainAltS,
  matchesShortcut,
  parseShortcut,
  readShortcutSnapshot,
} from '@/shared/shortcuts';

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    code: 'KeyS',
    key: 's',
    ...overrides,
  } as KeyboardEvent;
}

describe('selection shortcut', () => {
  it('matches Alt+S and nothing with another modifier', () => {
    expect(isPlainAltS(key({ altKey: true }))).toBe(true);
    expect(isPlainAltS(key({ altKey: true, shiftKey: true }))).toBe(false);
    expect(isPlainAltS(key({ altKey: true, code: 'KeyA', key: 'a' }))).toBe(false);
  });

  it('reads the key from a keyboard layout that reports another letter', () => {
    // A Japanese IME reports `ｓ` for the same physical key, so `code` decides.
    expect(isPlainAltS(key({ altKey: true, key: 'ｓ' }))).toBe(true);
  });

  it('ships the manifest default for every command', () => {
    expect(DEFAULT_SHORTCUTS).toEqual({
      'translate-page': 'Alt+A',
      'toggle-bilingual': 'Alt+B',
      'translate-selection': 'Alt+S',
    });
    expect(DEFAULT_SELECTION_SHORTCUT).toBe('Alt+S');
  });
});

describe('matchesShortcut', () => {
  it('accepts the key a user bound in place of the default', () => {
    const rebound = key({ altKey: true, shiftKey: true, code: 'KeyL', key: 'l' });
    expect(matchesShortcut(rebound, 'Alt+Shift+L')).toBe(true);
    expect(matchesShortcut(rebound, 'Alt+S')).toBe(false);
  });

  it('treats Ctrl as Command on a Mac, as the manifest does', () => {
    const command = key({ metaKey: true, code: 'KeyA', key: 'a' });
    expect(matchesShortcut(command, 'Ctrl+A', { mac: true })).toBe(true);
    expect(matchesShortcut(command, 'Ctrl+A', { mac: false })).toBe(false);
    // MacCtrl is the Control key itself.
    const control = key({ ctrlKey: true, code: 'KeyA', key: 'a' });
    expect(matchesShortcut(control, 'MacCtrl+A', { mac: true })).toBe(true);
  });

  it('reads the glyph spelling a Mac reports', () => {
    const option = key({ altKey: true });
    expect(matchesShortcut(option, '⌥S', { mac: true })).toBe(true);
    const both = key({ altKey: true, shiftKey: true, code: 'KeyP', key: 'p' });
    expect(matchesShortcut(both, '⌥⇧P', { mac: true })).toBe(true);
  });

  it('rejects a key that has no other modifier', () => {
    expect(matchesShortcut(key(), 'S')).toBe(false);
    expect(matchesShortcut(key({ altKey: true }), '')).toBe(false);
  });
});

describe('parseShortcut', () => {
  it('reads letters, digits and named keys', () => {
    expect(parseShortcut('Alt+A')).toEqual({
      modifiers: ['alt'],
      key: { code: 'KeyA', keys: ['a'] },
    });
    expect(parseShortcut('Ctrl+Shift+5')?.key.code).toBe('Digit5');
    expect(parseShortcut('Alt+Comma')?.key.code).toBe('Comma');
    expect(parseShortcut('Alt+PageDown')?.key.code).toBe('PageDown');
  });

  it('returns nothing for a binding it cannot read', () => {
    expect(parseShortcut('')).toBeNull();
    expect(parseShortcut('Alt+')).toBeNull();
    expect(parseShortcut('Alt+F13')).toBeNull();
    expect(parseShortcut('Alt+A+B')).toBeNull();
    expect(parseShortcut('Hyper+A')).toBeNull();
  });
});

describe('readShortcutSnapshot', () => {
  it('reports each command the way Chrome does, and an unbound one as empty', () => {
    expect(
      readShortcutSnapshot([
        { name: 'translate-page', shortcut: 'Alt+A' },
        { name: 'toggle-bilingual', shortcut: '' },
        { name: 'translate-selection', shortcut: '⌥⇧S' },
      ]),
    ).toEqual({
      'translate-page': 'Alt+A',
      'toggle-bilingual': '',
      'translate-selection': '⌥⇧S',
    });
  });

  it('keeps a command Chrome did not list apart from an unbound one', () => {
    expect(readShortcutSnapshot([{ name: 'translate-page' }])).toEqual({
      'translate-page': '',
      'toggle-bilingual': null,
      'translate-selection': null,
    });
  });
});

describe('ariaShortcut', () => {
  it('spells a platform binding for assistive technology', () => {
    expect(ariaShortcut('Alt+A', { mac: false })).toBe('Alt+A');
    expect(ariaShortcut('Ctrl+Shift+5', { mac: false })).toBe('Control+Shift+5');
    expect(ariaShortcut('Alt+A', { mac: true })).toBe('Alt+A');
    expect(ariaShortcut('⌥⇧P', { mac: true })).toBe('Alt+Shift+P');
    expect(ariaShortcut('Command+S', { mac: true })).toBe('Meta+S');
    expect(ariaShortcut('Ctrl+S', { mac: true })).toBe('Meta+S');
    expect(ariaShortcut('MacCtrl+S', { mac: true })).toBe('Control+S');
  });

  it('has nothing to announce for a binding it cannot read', () => {
    expect(ariaShortcut('')).toBeNull();
  });
});

describe('displayShortcut', () => {
  it('names the keys a Mac reports with glyphs', () => {
    expect(displayShortcut('⌥⇧P')).toBe('Option+Shift+P');
    expect(displayShortcut('⌘A')).toBe('Cmd+A');
  });

  it('leaves the spelling a Windows or Linux Chrome reports alone', () => {
    expect(displayShortcut('Alt+A')).toBe('Alt+A');
    expect(displayShortcut('Ctrl+Shift+5')).toBe('Ctrl+Shift+5');
    expect(displayShortcut('')).toBe('');
  });
});
