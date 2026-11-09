import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHORTCUTS } from '@/shared/shortcuts';

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: state.values.get(key) }),
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) state.values.set(key, value);
        },
      },
    },
  },
}));

const {
  loadShortcutAssignment,
  noteShortcutCommandAssigned,
  observeShortcutSnapshot,
  resolveShortcutQuery,
} = await import('@/shared/shortcut-assignment');

beforeEach(() => {
  state.values.clear();
});

describe('shortcut assignment persistence', () => {
  it('records a fresh install snapshot so assigned defaults stay assigned', async () => {
    const result = await resolveShortcutQuery([
      { name: 'translate-page', shortcut: 'Alt+A' },
      { name: 'toggle-bilingual', shortcut: 'Alt+B' },
      { name: 'translate-selection', shortcut: 'Alt+S' },
      { name: 'translate-compose', shortcut: 'Alt+T' },
    ]);
    expect(result.snapshot).toEqual(DEFAULT_SHORTCUTS);
    expect(result.assigned).toEqual({
      'translate-page': true,
      'toggle-bilingual': true,
      'translate-selection': true,
      'translate-compose': true,
    });
    expect(await loadShortcutAssignment()).toEqual(result.assigned);
  });

  it('keeps an install-time conflict as unassigned across later empty reads', async () => {
    await resolveShortcutQuery([
      { name: 'translate-page', shortcut: 'Alt+A' },
      { name: 'toggle-bilingual', shortcut: '' },
      { name: 'translate-selection', shortcut: 'Alt+S' },
      { name: 'translate-compose', shortcut: 'Alt+T' },
    ]);
    const later = await resolveShortcutQuery([
      { name: 'translate-page', shortcut: 'Alt+A' },
      { name: 'toggle-bilingual', shortcut: '' },
      { name: 'translate-selection', shortcut: 'Alt+S' },
      { name: 'translate-compose', shortcut: 'Alt+T' },
    ]);
    expect(later.assigned['toggle-bilingual']).toBe(false);
    expect(later.assigned['translate-page']).toBe(true);
  });

  it('does not forget a command that was assigned and then cleared', async () => {
    await resolveShortcutQuery([
      { name: 'translate-page', shortcut: 'Alt+A' },
      { name: 'toggle-bilingual', shortcut: 'Alt+B' },
      { name: 'translate-selection', shortcut: 'Alt+S' },
      { name: 'translate-compose', shortcut: 'Alt+T' },
    ]);
    const cleared = await resolveShortcutQuery([
      { name: 'translate-page', shortcut: '' },
      { name: 'toggle-bilingual', shortcut: 'Alt+B' },
      { name: 'translate-selection', shortcut: 'Alt+S' },
      { name: 'translate-compose', shortcut: 'Alt+T' },
    ]);
    expect(cleared.snapshot['translate-page']).toBe('');
    expect(cleared.assigned['translate-page']).toBe(true);
  });

  it('promotes a command when the browser later delivers it', async () => {
    await observeShortcutSnapshot({
      'translate-page': '',
      'toggle-bilingual': 'Alt+B',
      'translate-selection': 'Alt+S',
      'translate-compose': 'Alt+T',
    });
    expect((await loadShortcutAssignment())['translate-page']).toBe(false);
    await noteShortcutCommandAssigned('translate-page');
    expect((await loadShortcutAssignment())['translate-page']).toBe(true);
  });

  it('serializes concurrent writes so neither observation is lost', async () => {
    const [first, second] = await Promise.all([
      resolveShortcutQuery([{ name: 'translate-page', shortcut: 'Alt+A' }]),
      noteShortcutCommandAssigned('toggle-bilingual'),
    ]);
    expect(first.assigned['translate-page']).toBe(true);
    expect(second['toggle-bilingual']).toBe(true);
    const stored = await loadShortcutAssignment();
    expect(stored['translate-page']).toBe(true);
    expect(stored['toggle-bilingual']).toBe(true);
  });
});
