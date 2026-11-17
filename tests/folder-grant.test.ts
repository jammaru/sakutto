import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getURL: vi.fn((path: string) => `chrome-extension://test${path}`),
  query: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWindow: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { getURL: mocks.getURL },
    tabs: { query: mocks.query, create: mocks.create, update: mocks.update },
    windows: { update: mocks.updateWindow },
  },
}));

import { openFolderEnableWindow } from '@/background/folder-grant';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ id: 7 });
  mocks.update.mockResolvedValue({});
  mocks.updateWindow.mockResolvedValue({});
});

describe('openFolderEnableWindow', () => {
  it('opens the grant page when none is open', async () => {
    await expect(openFolderEnableWindow()).resolves.toBe(true);
    expect(mocks.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test/folder-enable.html',
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('focuses an existing folder-enable tab instead of creating another', async () => {
    mocks.create.mockResolvedValueOnce({ id: 7 });
    mocks.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 7, windowId: 1 }]);

    await openFolderEnableWindow();
    await openFolderEnableWindow();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(7, { active: true });
    expect(mocks.updateWindow).toHaveBeenCalledWith(1, { focused: true });
  });

  it('reports failure when the tab cannot be opened', async () => {
    mocks.create.mockRejectedValue(new Error('no window'));
    await expect(openFolderEnableWindow()).resolves.toBe(false);
  });
});
