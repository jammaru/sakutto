import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      getURL: (path: string) => `chrome-extension://test${path}`,
    },
    tabs: {
      create: state.create,
    },
  },
}));

import { openFolderEnableWindow } from '@/background/folder-grant';

beforeEach(() => {
  state.create.mockReset();
});

describe('openFolderEnableWindow', () => {
  it('opens the grant page as an active real tab', async () => {
    state.create.mockResolvedValue({ id: 7 });
    await expect(openFolderEnableWindow()).resolves.toBe(true);
    expect(state.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test/folder-enable.html',
      active: true,
    });
  });

  it('reports failure instead of trying popup windows', async () => {
    state.create.mockRejectedValue(new Error('no window'));
    await expect(openFolderEnableWindow()).resolves.toBe(false);
  });
});
