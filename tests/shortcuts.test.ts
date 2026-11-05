import { describe, expect, it } from 'vitest';
import { isDefaultAltSShortcut, isPlainAltS } from '@/shared/shortcuts';

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

  it('recognises only the manifest default', () => {
    expect(isDefaultAltSShortcut('Alt+S')).toBe(true);
    expect(isDefaultAltSShortcut('Alt+Shift+S')).toBe(false);
    expect(isDefaultAltSShortcut('')).toBe(false);
    expect(isDefaultAltSShortcut('Ctrl+S')).toBe(false);
  });
});
