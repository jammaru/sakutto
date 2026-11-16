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
    mocks.requestPageInfo.mockResolvedValue({ lang: 'en', translatableBlocks: 1 });

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
      .mockResolvedValueOnce({ lang: 'en', translatableBlocks: 1 });

    expect(await ensureContentScript(7)).toBe(true);
    expect(mocks.executeScript).toHaveBeenCalledTimes(3);
  });

  it('retries when the script ran before its listener answered', async () => {
    mocks.requestPageInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ lang: 'ja', translatableBlocks: 2 });

    expect(await ensureContentScript(7)).toBe(true);
    expect(mocks.executeScript).toHaveBeenCalledTimes(2);
  });

  it('reports false only after every attempt fails', async () => {
    mocks.executeScript.mockRejectedValue(new Error('No host access.'));

    expect(await ensureContentScript(7)).toBe(false);
    expect(mocks.executeScript).toHaveBeenCalledTimes(4);
  });
});
