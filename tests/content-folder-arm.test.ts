import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock('wxt/browser', () => ({
  browser: { runtime: { sendMessage: mocks.sendMessage } },
}));

import { armFolderCommand } from '@/content/folder-arm-gate';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('content folder arm gate', () => {
  it('sends only the command and lets the background derive the tab and frame', async () => {
    mocks.sendMessage.mockResolvedValue('ran');

    await expect(armFolderCommand('toggle')).resolves.toBe('continue');
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'folder:arm-command',
      command: 'toggle',
    });
  });

  it('defers the page command when the background asks for a grant', async () => {
    mocks.sendMessage.mockResolvedValue('deferred');

    await expect(armFolderCommand('restore')).resolves.toBe('deferred');
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'folder:arm-command',
      command: 'restore',
    });
  });

  it('continues translation when the arm message cannot be sent', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('background unavailable'));

    await expect(armFolderCommand('toggle')).resolves.toBe('continue');
  });
});
