import { describe, expect, it } from 'vitest';
import { resolveFolderArmCommandTarget } from '@/background/folder-arm-command';

describe('folder arm command target', () => {
  it('derives the tab and frame from the content sender', () => {
    expect(
      resolveFolderArmCommandTarget(
        { type: 'folder:arm-command', command: 'toggle' },
        { tab: { id: 7 }, frameId: 3 },
      ),
    ).toEqual({ tabId: 7, command: 'toggle', frameId: 3 });
  });

  it('ignores spoofed tab and frame ids from a content sender', () => {
    expect(
      resolveFolderArmCommandTarget(
        { type: 'folder:arm-command', command: 'selection', tabId: 9, frameId: 4 },
        { tab: { id: 7 }, frameId: 3 },
      ),
    ).toEqual({ tabId: 7, command: 'selection', frameId: 3 });
  });

  it('keeps explicit tab and frame values from privileged callers', () => {
    expect(
      resolveFolderArmCommandTarget(
        { type: 'folder:arm-command', command: 'selection', tabId: 9, frameId: 4 },
        {},
      ),
    ).toEqual({ tabId: 9, command: 'selection', frameId: 4 });
  });

  it('rejects a message with no sender tab', () => {
    expect(
      resolveFolderArmCommandTarget(
        { type: 'folder:arm-command', command: 'toggle' },
        { frameId: 3 },
      ),
    ).toBeNull();
  });
});
