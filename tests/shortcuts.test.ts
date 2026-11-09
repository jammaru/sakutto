import { describe, expect, it } from 'vitest';
import {
  CHROME_DEFAULT_SHORTCUTS,
  DEFAULT_COMPOSE_SHORTCUT,
  DEFAULT_SELECTION_SHORTCUT,
  DEFAULT_SHORTCUTS,
  FIREFOX_DEFAULT_SHORTCUTS,
  SHORTCUT_COMMANDS,
  ariaShortcut,
  boundShortcut,
  defaultShortcutsFor,
  displayShortcut,
  isPlainAltS,
  markCommandAssigned,
  matchesShortcut,
  parseShortcut,
  readShortcutSnapshot,
  rememberShortcutAssignments,
  shortcutAssignedRecord,
  usesInPageFallback,
  type ShortcutAssigned,
} from '@/shared/shortcuts';
import type { ShortcutSnapshot } from '@/shared/messages';

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
      'translate-compose': 'Alt+T',
    });
    expect(DEFAULT_SELECTION_SHORTCUT).toBe('Alt+S');
    expect(DEFAULT_COMPOSE_SHORTCUT).toBe('Alt+T');
    expect(CHROME_DEFAULT_SHORTCUTS).toEqual(DEFAULT_SHORTCUTS);
    expect(defaultShortcutsFor('firefox')).toEqual(FIREFOX_DEFAULT_SHORTCUTS);
    expect(FIREFOX_DEFAULT_SHORTCUTS).toEqual({
      'translate-page': 'Alt+Shift+A',
      'toggle-bilingual': 'Alt+Shift+B',
      'translate-selection': 'Alt+Shift+S',
      'translate-compose': 'Alt+Shift+T',
    });
    expect(
      matchesShortcut(
        key({ altKey: true, shiftKey: true }),
        FIREFOX_DEFAULT_SHORTCUTS['translate-selection'],
      ),
    ).toBe(true);
    expect(
      matchesShortcut(key({ altKey: true }), FIREFOX_DEFAULT_SHORTCUTS['translate-selection']),
    ).toBe(false);
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

  it('matches Alt+T from the physical key even when the layout reports a dagger', () => {
    const dagger = key({ altKey: true, code: 'KeyT', key: '†' });
    expect(matchesShortcut(dagger, 'Alt+T')).toBe(true);
    expect(matchesShortcut(dagger, DEFAULT_COMPOSE_SHORTCUT)).toBe(true);
    expect(matchesShortcut(key({ altKey: true, code: 'KeyY', key: '†' }), 'Alt+T')).toBe(false);
  });

  it('matches Firefox compose Alt+Shift+T and not Alt+T', () => {
    const shifted = key({ altKey: true, shiftKey: true, code: 'KeyT', key: 't' });
    expect(matchesShortcut(shifted, FIREFOX_DEFAULT_SHORTCUTS['translate-compose'])).toBe(true);
    expect(
      matchesShortcut(
        key({ altKey: true, code: 'KeyT', key: 't' }),
        FIREFOX_DEFAULT_SHORTCUTS['translate-compose'],
      ),
    ).toBe(false);
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

function snapshot(overrides: Partial<ShortcutSnapshot> = {}): ShortcutSnapshot {
  return {
    'translate-page': DEFAULT_SHORTCUTS['translate-page'],
    'toggle-bilingual': DEFAULT_SHORTCUTS['toggle-bilingual'],
    'translate-selection': DEFAULT_SHORTCUTS['translate-selection'],
    'translate-compose': DEFAULT_SHORTCUTS['translate-compose'],
    ...overrides,
  };
}

function assigned(overrides: Partial<ShortcutAssigned> = {}): ShortcutAssigned {
  return {
    'translate-page': true,
    'toggle-bilingual': true,
    'translate-selection': true,
    'translate-compose': true,
    ...overrides,
  };
}

function alt(code: string, letter: string): KeyboardEvent {
  return key({ altKey: true, code, key: letter });
}

describe('readShortcutSnapshot', () => {
  it('reports each command the way Chrome does, and an unbound one as empty', () => {
    expect(
      readShortcutSnapshot([
        { name: 'translate-page', shortcut: 'Alt+A' },
        { name: 'toggle-bilingual', shortcut: '' },
        { name: 'translate-selection', shortcut: '⌥⇧S' },
        { name: 'translate-compose', shortcut: 'Alt+T' },
      ]),
    ).toEqual({
      'translate-page': 'Alt+A',
      'toggle-bilingual': '',
      'translate-selection': '⌥⇧S',
      'translate-compose': 'Alt+T',
    });
  });

  it('keeps a command Chrome did not list apart from an unbound one', () => {
    expect(readShortcutSnapshot([{ name: 'translate-page' }])).toEqual({
      'translate-page': '',
      'toggle-bilingual': null,
      'translate-selection': null,
      'translate-compose': null,
    });
  });
});

describe('shortcut assignment and in-page fallback', () => {
  it('uses the fresh-install defaults and does not treat them as unset', () => {
    const live = snapshot();
    const ever = rememberShortcutAssignments({}, live);
    expect(shortcutAssignedRecord(ever)).toEqual(assigned());
    for (const command of SHORTCUT_COMMANDS) {
      const binding = boundShortcut(live, command, { assigned: ever[command] });
      expect(binding, command).toBe(DEFAULT_SHORTCUTS[command]);
      expect(usesInPageFallback(live, command, ever[command]), command).toBe(false);
      expect(binding.length, command).toBeGreaterThan(0);
    }
    expect(boundShortcut(null, 'translate-page')).toBe('Alt+A');
    expect(boundShortcut(null, 'translate-compose')).toBe(DEFAULT_COMPOSE_SHORTCUT);
  });

  it('stops handling a command the user cleared in Chrome', () => {
    const installed = rememberShortcutAssignments({}, snapshot());
    const cleared = snapshot({ 'translate-page': '' });
    const ever = rememberShortcutAssignments(installed, cleared);
    expect(ever['translate-page']).toBe(true);
    expect(boundShortcut(cleared, 'translate-page', { assigned: ever['translate-page'] })).toBe('');
    expect(usesInPageFallback(cleared, 'translate-page', ever['translate-page'])).toBe(false);
    expect(
      matchesShortcut(
        alt('KeyA', 'a'),
        boundShortcut(cleared, 'translate-page', { assigned: true }),
      ),
    ).toBe(false);
  });

  it('uses only the Chrome-rebound key, not the old default', () => {
    const rebound = snapshot({ 'translate-page': 'Alt+Q' });
    const ever = rememberShortcutAssignments({}, rebound);
    const binding = boundShortcut(rebound, 'translate-page', { assigned: ever['translate-page'] });
    expect(binding).toBe('Alt+Q');
    expect(matchesShortcut(alt('KeyQ', 'q'), binding)).toBe(true);
    expect(matchesShortcut(alt('KeyA', 'a'), binding)).toBe(false);
    expect(usesInPageFallback(rebound, 'translate-page', true)).toBe(false);
  });

  it('keeps a Sakutto-disabled command off even when Chrome still has a key', () => {
    const live = snapshot();
    expect(boundShortcut(live, 'toggle-bilingual', { enabled: false, assigned: true })).toBe('');
    expect(
      matchesShortcut(
        alt('KeyB', 'b'),
        boundShortcut(live, 'toggle-bilingual', { enabled: false, assigned: true }),
      ),
    ).toBe(false);
  });

  it('falls back to the default only when Chrome never assigned the key at install', () => {
    const conflict = snapshot({ 'translate-compose': '' });
    const ever = rememberShortcutAssignments({}, conflict);
    expect(ever['translate-compose']).toBe(false);
    expect(ever['translate-page']).toBe(true);
    const binding = boundShortcut(conflict, 'translate-compose', {
      assigned: ever['translate-compose'],
    });
    expect(binding).toBe(DEFAULT_COMPOSE_SHORTCUT);
    expect(usesInPageFallback(conflict, 'translate-compose', ever['translate-compose'])).toBe(true);
    expect(usesInPageFallback(conflict, 'translate-page', ever['translate-page'])).toBe(false);
    expect(matchesShortcut(alt('KeyT', 't'), binding)).toBe(true);
  });

  it('seeds a command added in an update without resetting the others', () => {
    const recorded = rememberShortcutAssignments(
      {
        'translate-page': true,
        'toggle-bilingual': true,
        'translate-selection': false,
      },
      snapshot({
        'translate-selection': '',
        'translate-compose': '',
      }),
    );
    expect(recorded['translate-page']).toBe(true);
    expect(recorded['translate-selection']).toBe(false);
    expect(recorded['translate-compose']).toBe(false);
  });

  it('promotes a later browser assignment, and never treats a clear as a fresh conflict', () => {
    const conflict = rememberShortcutAssignments({}, snapshot({ 'translate-page': '' }));
    expect(conflict['translate-page']).toBe(false);
    const rebound = rememberShortcutAssignments(conflict, snapshot({ 'translate-page': 'Alt+Q' }));
    expect(rebound['translate-page']).toBe(true);
    const cleared = rememberShortcutAssignments(rebound, snapshot({ 'translate-page': '' }));
    expect(cleared['translate-page']).toBe(true);
    expect(
      boundShortcut(snapshot({ 'translate-page': '' }), 'translate-page', { assigned: true }),
    ).toBe('');
  });

  it('treats a command the browser later delivers as assigned', () => {
    const conflict = rememberShortcutAssignments({}, snapshot({ 'toggle-bilingual': '' }));
    expect(conflict['toggle-bilingual']).toBe(false);
    expect(markCommandAssigned(conflict, 'toggle-bilingual')['toggle-bilingual']).toBe(true);
  });

  it('uses a rebound key even when that command was a conflict at install', () => {
    const live = snapshot({ 'translate-compose': 'Alt+Shift+L' });
    expect(boundShortcut(live, 'translate-compose', { assigned: false })).toBe('Alt+Shift+L');
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
