import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), capture: vi.fn() }));
vi.mock('wxt/browser', () => ({
  browser: {
    tabs: {
      query: mocks.query,
      captureVisibleTab: mocks.capture,
    },
  },
}));

import { captureActiveSenderTab } from '@/background/image-capture';

beforeEach(() => {
  mocks.query.mockReset();
  mocks.capture.mockReset();
  mocks.capture.mockResolvedValue('data:image/png;base64,cG5n');
});

describe('captureActiveSenderTab', () => {
  it('captures the sender window while its tab is active', async () => {
    mocks.query.mockResolvedValue([{ id: 7, windowId: 3 }]);
    await expect(captureActiveSenderTab({ tab: { id: 7, windowId: 3 } })).resolves.toBe(
      'data:image/png;base64,cG5n',
    );
    expect(mocks.query).toHaveBeenCalledWith({ active: true, windowId: 3 });
    expect(mocks.capture).toHaveBeenCalledWith(3, { format: 'png' });
  });

  it('refuses capture after the user switches tabs', async () => {
    mocks.query.mockResolvedValue([{ id: 8, windowId: 3 }]);
    await expect(captureActiveSenderTab({ tab: { id: 7, windowId: 3 } })).resolves.toBeNull();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('returns null rather than capturing without a complete sender identity', async () => {
    await expect(captureActiveSenderTab({ tab: { id: 7 } })).resolves.toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
