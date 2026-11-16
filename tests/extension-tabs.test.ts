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
});
