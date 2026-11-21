import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeScript: vi.fn(),
  requestPageInfo: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: { scripting: { executeScript: mocks.executeScript } },
}));

vi.mock('@/shared/messages', () => ({
  requestPageInfo: mocks.requestPageInfo,
}));

import { ensureContentScript } from '@/shared/page-bridge';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeScript.mockResolvedValue([{ result: null }]);
  mocks.requestPageInfo.mockResolvedValue(null);
});

describe('ensureContentScript', () => {
  it('does not inject when the page already answers', async () => {
    mocks.requestPageInfo.mockResolvedValue({ lang: 'en' });

    expect(await ensureContentScript(7)).toBe(true);
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it('retries a refused Firefox injection instead of reporting an untranslatable page', async () => {
    mocks.executeScript
      .mockRejectedValueOnce(new Error('The tab is not ready.'))
      .mockResolvedValue([{ result: null }]);
    mocks.requestPageInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ lang: 'en' });

    expect(await ensureContentScript(7)).toBe(true);
    expect(mocks.executeScript).toHaveBeenCalledTimes(3);
  });

  it('retries when the script ran before its listener answered', async () => {
    mocks.requestPageInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ lang: 'ja' });

    expect(await ensureContentScript(7)).toBe(true);
    expect(mocks.executeScript).toHaveBeenCalledTimes(2);
  });

  it('injects and pings only the requested subframe', async () => {
    mocks.requestPageInfo.mockResolvedValueOnce(null).mockResolvedValueOnce({ lang: 'en' });

    expect(await ensureContentScript(7, { frameId: 4 })).toBe(true);
    expect(mocks.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [4] },
      files: ['/content-scripts/content.js'],
    });
    expect(mocks.requestPageInfo).toHaveBeenNthCalledWith(1, 7, 4);
    expect(mocks.requestPageInfo).toHaveBeenNthCalledWith(2, 7, 4);
  });

  it('reports false only after every attempt fails', async () => {
    mocks.executeScript.mockRejectedValue(new Error('No host access.'));

    expect(await ensureContentScript(7)).toBe(false);
    expect(mocks.executeScript).toHaveBeenCalledTimes(4);
  });
});
