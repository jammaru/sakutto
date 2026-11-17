import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  lastErrorReads: 0,
  lastErrorValue: undefined as { message?: string } | undefined,
  removeAll: vi.fn(),
  create: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      get lastError() {
        state.lastErrorReads += 1;
        return state.lastErrorValue;
      },
    },
    contextMenus: {
      removeAll: (callback: () => void) => {
        state.removeAll();
        callback();
      },
      create: (_props: unknown, callback: () => void) => {
        state.create(_props);
        callback();
      },
    },
    i18n: { getMessage: (key: string) => key },
  },
}));

import { flushContextMenuInstall, resetContextMenusForTests } from '@/background/context-menus';

beforeEach(() => {
  resetContextMenusForTests();
  state.lastErrorReads = 0;
  state.lastErrorValue = undefined;
  state.removeAll.mockReset();
  state.create.mockReset();
});

describe('context menu install', () => {
  it('serializes concurrent installs into one removeAll and four creates', async () => {
    await Promise.all([flushContextMenuInstall(), flushContextMenuInstall()]);

    expect(state.removeAll).toHaveBeenCalledTimes(1);
    expect(state.create).toHaveBeenCalledTimes(4);
    expect(state.create.mock.calls.map((call) => (call[0] as { id: string }).id)).toEqual([
      'translate-page',
      'translate-selection',
      'translate-compose',
      'translate-pdf',
    ]);
  });

  it('clears lastError through create callbacks', async () => {
    state.lastErrorValue = { message: 'Cannot create item with duplicate id translate-page' };
    await flushContextMenuInstall();
    expect(state.lastErrorReads).toBeGreaterThan(0);
  });
});
