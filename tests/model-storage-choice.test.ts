import { describe, expect, it } from 'vitest';
import {
  emptySharedFolderStatus,
  sharedFolderNeedsPermission,
  sharedFolderStorageChoice,
  type SharedFolderPermission,
} from '@/engine/model/folder-status';

function configuredFolder(permission: SharedFolderPermission) {
  return {
    ...emptySharedFolderStatus(true),
    configured: true,
    permission,
    name: 'Sakutto',
  };
}

describe('model storage choice', () => {
  it('selects the shared folder when a prompt status arrives after the empty mount status', () => {
    const atMount = emptySharedFolderStatus(true);
    expect(sharedFolderStorageChoice(atMount)).toBe('browser');

    const persistedFolder = configuredFolder('prompt');
    expect(sharedFolderStorageChoice(persistedFolder)).toBe('folder');
    expect(sharedFolderNeedsPermission(persistedFolder)).toBe(true);
  });

  it.each<SharedFolderPermission>(['prompt', 'denied', 'unknown'])(
    'keeps the persisted folder selected while permission is %s',
    (permission) => {
      expect(sharedFolderStorageChoice(configuredFolder(permission))).toBe('folder');
    },
  );

  it('selects browser storage only when no shared folder is configured', () => {
    expect(sharedFolderStorageChoice(emptySharedFolderStatus(true))).toBe('browser');
    expect(sharedFolderStorageChoice(null)).toBe('browser');
  });
});
