import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getURL: vi.fn((path: string) => `chrome-extension://test/${path.replace(/^\//u, '')}`),
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

import { openOrFocusExtensionTab } from '@/shared/extension-tabs';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ id: 9 });
  mocks.update.mockResolvedValue({});
  mocks.updateWindow.mockResolvedValue({});
});

describe('openOrFocusExtensionTab', () => {
  it('focuses an existing onboarding tab instead of piling another one', async () => {
    mocks.query.mockResolvedValue([{ id: 4, windowId: 2 }]);

    expect(await openOrFocusExtensionTab('/onboarding.html')).toBe(4);
    expect(mocks.query).toHaveBeenCalledWith({ url: 'chrome-extension://test/onboarding.html*' });
    expect(mocks.update).toHaveBeenCalledWith(4, { active: true });
    expect(mocks.updateWindow).toHaveBeenCalledWith(2, { focused: true });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('creates the onboarding tab once when none is open', async () => {
    expect(await openOrFocusExtensionTab('/onboarding.html')).toBe(9);
    expect(mocks.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test/onboarding.html',
    });
  });

  it('keeps query parameters and the hash out of the matching pattern', async () => {
    mocks.query.mockResolvedValue([{ id: 5 }]);
    const url = 'chrome-extension://test/options.html?folder=pick#model-folder';

    expect(await openOrFocusExtensionTab(url)).toBe(5);
    expect(mocks.query).toHaveBeenCalledWith({ url: 'chrome-extension://test/options.html*' });
  });

  it('focuses an existing tab on the requested section when the URL has a query or hash', async () => {
    mocks.query.mockResolvedValue([{ id: 5, windowId: 2 }]);
    const url = 'chrome-extension://test/options.html?folder=pick#model-folder';

    expect(await openOrFocusExtensionTab(url)).toBe(5);
    expect(mocks.update).toHaveBeenCalledWith(5, { active: true, url });
  });

  it('does not rewrite an existing tab URL when there is no section to focus', async () => {
    mocks.query.mockResolvedValue([{ id: 4, windowId: 2 }]);

    expect(await openOrFocusExtensionTab('/onboarding.html')).toBe(4);
    expect(mocks.update).toHaveBeenCalledWith(4, { active: true });
  });

  it('opens a replacement when focusing an existing tab fails', async () => {
    mocks.query.mockResolvedValue([{ id: 4, windowId: 2 }]);
    mocks.update.mockRejectedValue(new Error('No tab with id: 4'));

    expect(await openOrFocusExtensionTab('/folder-enable.html')).toBe(9);
    expect(mocks.update).toHaveBeenCalledWith(4, { active: true });
    expect(mocks.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test/folder-enable.html',
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent opens for the same page into one tab', async () => {
    let resolveQuery: ((tabs: Array<{ id: number; windowId: number }>) => void) | undefined;
    mocks.query.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        }),
    );

    const first = openOrFocusExtensionTab('/folder-enable.html');
    const second = openOrFocusExtensionTab('/folder-enable.html');
    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));

    resolveQuery?.([]);
    await expect(first).resolves.toBe(9);
    await expect(second).resolves.toBe(9);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
