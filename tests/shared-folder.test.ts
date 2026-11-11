import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemorySharedFolderBucket,
  isStoredSharedFolder,
  adoptPickedSharedFolder,
  persistSharedFolderHandle,
  pickSharedModelFolder,
  queryFolderPermission,
  requestFolderPermission,
  setSharedFolderBucketForTests,
  sharedFolderPickerAvailable,
  sharedFolderSupported,
  type FolderPermission,
} from '@/engine/model/shared-folder';

afterEach(() => {
  setSharedFolderBucketForTests(null);
});

function fakeHandle(options: {
  name?: string;
  permission?: FolderPermission;
  request?: FolderPermission;
}): FileSystemDirectoryHandle {
  const permission = options.permission ?? 'granted';
  return {
    kind: 'directory',
    name: options.name ?? 'Models',
    queryPermission: async () => permission,
    requestPermission: async () => options.request ?? permission,
    getDirectoryHandle: async () => {
      throw new Error('unused');
    },
  } as unknown as FileSystemDirectoryHandle;
}

describe('shared folder capability', () => {
  it('is available on Chromium unit tests only when a picker exists', () => {
    expect(sharedFolderSupported()).toBe(true);
    expect(sharedFolderPickerAvailable(undefined)).toBe(false);
    expect(sharedFolderPickerAvailable(async () => fakeHandle({}))).toBe(true);
  });
});

describe('folder permission', () => {
  it('treats a handle without queryPermission as granted', async () => {
    const handle = {
      kind: 'directory',
      name: 'Models',
      getDirectoryHandle: async () => {
        throw new Error('unused');
      },
    } as unknown as FileSystemDirectoryHandle;
    expect(await queryFolderPermission(handle)).toBe('granted');
  });

  it('returns the queried state and only requests when needed', async () => {
    expect(await queryFolderPermission(fakeHandle({ permission: 'prompt' }))).toBe('prompt');
    expect(await requestFolderPermission(fakeHandle({ permission: 'granted' }))).toBe('granted');
    expect(
      await requestFolderPermission(fakeHandle({ permission: 'prompt', request: 'granted' })),
    ).toBe('granted');
    expect(
      await requestFolderPermission(fakeHandle({ permission: 'prompt', request: 'denied' })),
    ).toBe('denied');
  });
});

describe('shared folder handle persistence', () => {
  it('stores and round-trips a directory handle', async () => {
    const bucket = new MemorySharedFolderBucket();
    setSharedFolderBucketForTests(bucket);
    const handle = fakeHandle({ name: 'PLaMo' });
    const stored = await persistSharedFolderHandle(handle, bucket);
    expect(stored.name).toBe('PLaMo');
    expect(isStoredSharedFolder(stored)).toBe(true);
    expect(await bucket.get()).toEqual(stored);
  });

  it('rejects a record that is not a directory handle', () => {
    expect(
      isStoredSharedFolder({
        handle: { kind: 'file' },
        name: 'x',
        savedAt: 1,
      }),
    ).toBe(false);
  });
});

describe('pickSharedModelFolder', () => {
  it('calls the picker with a stable id and readwrite mode', async () => {
    const picker = async (options?: { id?: string; mode?: string; startIn?: string }) => {
      expect(options).toEqual({ id: 'sakutto-models', mode: 'readwrite', startIn: 'documents' });
      return fakeHandle({ name: 'Chosen' });
    };
    const handle = await pickSharedModelFolder(picker);
    expect(handle.name).toBe('Chosen');
  });

  it('throws when this page has no picker', async () => {
    await expect(pickSharedModelFolder(null)).rejects.toThrow(/cannot choose a folder/i);
  });
});

describe('adoptPickedSharedFolder', () => {
  it('persists the handle only when permission is granted', async () => {
    const handle = fakeHandle({ permission: 'granted' });
    const persist = vi.fn(async () => ({ handle, name: 'Models', savedAt: 1 }));
    expect(
      await adoptPickedSharedFolder({
        pick: async () => handle,
        persist,
      }),
    ).toBe('granted');
    expect(persist).toHaveBeenCalledOnce();
  });

  it('does not persist when the picker is cancelled or permission is denied', async () => {
    const persist = vi.fn();
    const cancelled = new DOMException('The user aborted a request.', 'AbortError');
    expect(
      await adoptPickedSharedFolder({
        pick: async () => {
          throw cancelled;
        },
        persist,
      }),
    ).toBe('cancelled');
    expect(
      await adoptPickedSharedFolder({
        pick: async () => fakeHandle({ permission: 'denied', request: 'denied' }),
        persist,
      }),
    ).toBe('denied');
    expect(persist).not.toHaveBeenCalled();
  });
});
