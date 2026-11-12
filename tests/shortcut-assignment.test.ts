import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHORTCUTS } from '@/shared/shortcuts';

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  update: undefined as ((details: { name: string; shortcut: string }) => Promise<void>) | undefined,
  live: [] as Array<{ name?: string; shortcut?: string }>,
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
    commands: {
      get update() {
        return state.update;
      },
      getAll: async () => state.live,
    },
  },
}));

const {
  loadShortcutAssignment,
  noteShortcutCommandAssigned,
  observeShortcutSnapshot,
  resolveShortcutQuery,
  restoreEmptyCommandShortcuts,
} = await import('@/shared/shortcut-assignment');

beforeEach(() => {
  state.values.clear();
  state.update = undefined;
  state.live = [];
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

describe('restoreEmptyCommandShortcuts', () => {
  it('is a no-op when the browser cannot write shortcuts (Chrome)', async () => {
    const commands = [
      { name: 'translate-page', shortcut: '' },
      { name: 'toggle-bilingual', shortcut: 'Alt+B' },
    ];
    await expect(restoreEmptyCommandShortcuts(commands)).resolves.toBe(commands);
  });

  it('restores only empty commands and leaves a customized key alone', async () => {
    const updated: Array<{ name: string; shortcut: string }> = [];
    state.update = async (details) => {
      updated.push(details);
    };
    state.live = [
      { name: 'translate-page', shortcut: 'Alt+A' },
      { name: 'toggle-bilingual', shortcut: 'Alt+Q' },
      { name: 'translate-selection', shortcut: 'Alt+S' },
      { name: 'translate-compose', shortcut: 'Alt+T' },
    ];
    const next = await restoreEmptyCommandShortcuts([
      { name: 'translate-page', shortcut: '' },
      { name: 'toggle-bilingual', shortcut: 'Alt+Q' },
      { name: 'translate-selection', shortcut: '' },
      { name: 'translate-compose', shortcut: 'Alt+T' },
    ]);
    expect(updated).toEqual([
      { name: 'translate-page', shortcut: 'Alt+A' },
      { name: 'translate-selection', shortcut: 'Alt+S' },
    ]);
    expect(next).toEqual(state.live);
  });

  it('keeps the empty binding when the browser refuses the default', async () => {
    state.update = async () => {
      throw new Error('already in use');
    };
    const commands = [{ name: 'translate-page', shortcut: '' }];
    await expect(restoreEmptyCommandShortcuts(commands)).resolves.toBe(commands);
  });
});
