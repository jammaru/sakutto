import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_ID, getModel } from '@/engine/model/catalog';
import {
  MemorySharedFolderBucket,
  SHARED_APP_DIRECTORY,
  SHARED_FOLDER_PICKER_ID,
  SHARED_FOLDER_PICKER_START,
  SHARED_MODELS_DIRECTORY,
  isStoredSharedFolder,
  adoptPickedSharedFolder,
  isDocumentsFolderName,
  isRecommendedSharedFolderName,
  openSharedModelsDirectory,
  persistSharedFolderHandle,
  pickSharedModelFolder,
  queryFolderPermission,
  requestFolderPermission,
  restoreStoredFolderPermission,
  resolveSharedFolderRoot,
  setSharedFolderBucketForTests,
  sharedFolderPickerAvailable,
  sharedFolderSupported,
  type FolderPermission,
} from '@/engine/model/shared-folder';

afterEach(() => {
  setSharedFolderBucketForTests(null);
});

interface FakeDir {
  name: string;
  permission: FolderPermission;
  request?: FolderPermission;
  dirs: Map<string, FakeDir>;
  files: Set<string>;
}

function fakeDir(
  name: string,
  options: {
    permission?: FolderPermission;
    request?: FolderPermission;
    dirs?: Record<string, FakeDir>;
    files?: readonly string[];
  } = {},
): FakeDir {
  const dir: FakeDir = {
    name,
    permission: options.permission ?? 'granted',
    dirs: new Map(Object.entries(options.dirs ?? {})),
    files: new Set(options.files ?? []),
  };
  if (options.request !== undefined) dir.request = options.request;
  return dir;
}

function fakeHandleFrom(dir: FakeDir): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: dir.name,
    queryPermission: async () => dir.permission,
    requestPermission: async () => dir.request ?? dir.permission,
    getDirectoryHandle: async (name: string, options?: { create?: boolean }) => {
      let child = dir.dirs.get(name);
      if (!child) {
        if (!options?.create) {
          throw new DOMException(`Missing directory ${name}`, 'NotFoundError');
        }
        child = fakeDir(name, { permission: dir.permission });
        dir.dirs.set(name, child);
      }
      return fakeHandleFrom(child);
    },
    getFileHandle: async (name: string) => {
      if (!dir.files.has(name)) {
        throw new DOMException(`Missing file ${name}`, 'NotFoundError');
      }
      return { kind: 'file', name } as FileSystemFileHandle;
    },
  } as unknown as FileSystemDirectoryHandle;
}

function fakeHandle(options: {
  name?: string;
  permission?: FolderPermission;
  request?: FolderPermission;
  files?: readonly string[];
}): FileSystemDirectoryHandle {
  const nested: {
    permission?: FolderPermission;
    request?: FolderPermission;
    files?: readonly string[];
  } = {};
  if (options.permission !== undefined) nested.permission = options.permission;
  if (options.request !== undefined) nested.request = options.request;
  if (options.files !== undefined) nested.files = options.files;
  return fakeHandleFrom(fakeDir(options.name ?? 'Models', nested));
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

  it('restores a stored handle from a user gesture', async () => {
    const bucket = new MemorySharedFolderBucket();
    setSharedFolderBucketForTests(bucket);
    const handle = fakeHandle({ permission: 'prompt', request: 'granted' });
    await persistSharedFolderHandle(handle, bucket);
    expect(await restoreStoredFolderPermission()).toBe('granted');
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
      expect(options).toEqual({
        id: SHARED_FOLDER_PICKER_ID,
        mode: 'readwrite',
        startIn: SHARED_FOLDER_PICKER_START,
      });
      return fakeHandle({ name: 'Chosen' });
    };
    const handle = await pickSharedModelFolder(picker);
    expect(handle.name).toBe('Chosen');
  });

  it('throws when this page has no picker', async () => {
    await expect(pickSharedModelFolder(null)).rejects.toThrow(/cannot choose a folder/i);
  });
});

describe('recommended Documents/Sakutto location', () => {
  it('recognizes Documents and Sakutto names', () => {
    expect(isDocumentsFolderName('Documents')).toBe(true);
    expect(isDocumentsFolderName('ドキュメント')).toBe(true);
    expect(isDocumentsFolderName('書類')).toBe(true);
    expect(isDocumentsFolderName('Downloads')).toBe(false);
    expect(isRecommendedSharedFolderName('Sakutto')).toBe(true);
    expect(isRecommendedSharedFolderName('sakutto')).toBe(true);
  });

  it('creates a Sakutto folder when the user picks Documents', async () => {
    const documents = fakeDir('Documents');
    const resolved = await resolveSharedFolderRoot(fakeHandleFrom(documents));
    expect(resolved.name).toBe(SHARED_APP_DIRECTORY);
    expect(documents.dirs.has(SHARED_APP_DIRECTORY)).toBe(true);
  });

  it('does not nest Sakutto under an ordinary allowed folder', async () => {
    const projects = fakeDir('Projects');
    const resolved = await resolveSharedFolderRoot(fakeHandleFrom(projects));
    expect(resolved.name).toBe('Projects');
    expect(projects.dirs.has(SHARED_APP_DIRECTORY)).toBe(false);
  });

  it('keeps a Sakutto folder, a sakutto-models folder, or a folder with an official GGUF', async () => {
    const sakutto = fakeDir(SHARED_APP_DIRECTORY);
    expect((await resolveSharedFolderRoot(fakeHandleFrom(sakutto))).name).toBe(
      SHARED_APP_DIRECTORY,
    );

    const withModels = fakeDir('PLaMo', {
      dirs: { [SHARED_MODELS_DIRECTORY]: fakeDir(SHARED_MODELS_DIRECTORY) },
    });
    expect((await resolveSharedFolderRoot(fakeHandleFrom(withModels))).name).toBe('PLaMo');

    const models = fakeDir(SHARED_MODELS_DIRECTORY, { files: [getModel(DEFAULT_MODEL_ID).file] });
    expect((await resolveSharedFolderRoot(fakeHandleFrom(models))).name).toBe(
      SHARED_MODELS_DIRECTORY,
    );
  });

  it('opens sakutto-models inside Sakutto, or the folder itself when a GGUF is already there', async () => {
    const sakutto = fakeDir(SHARED_APP_DIRECTORY);
    const models = await openSharedModelsDirectory(fakeHandleFrom(sakutto));
    expect(models.name).toBe(SHARED_MODELS_DIRECTORY);

    const direct = fakeDir(SHARED_MODELS_DIRECTORY, { files: [getModel(DEFAULT_MODEL_ID).file] });
    expect((await openSharedModelsDirectory(fakeHandleFrom(direct))).name).toBe(
      SHARED_MODELS_DIRECTORY,
    );
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
    ).toEqual({ status: 'granted', name: 'Models' });
    expect(persist).toHaveBeenCalledOnce();
  });

  it('persists the Sakutto subfolder when Documents is picked', async () => {
    const documents = fakeDir('Documents');
    const persist = vi.fn(async (handle: FileSystemDirectoryHandle) => ({
      handle,
      name: handle.name,
      savedAt: 1,
    }));
    expect(
      await adoptPickedSharedFolder({
        pick: async () => fakeHandleFrom(documents),
        persist,
      }),
    ).toEqual({ status: 'granted', name: SHARED_APP_DIRECTORY });
    expect(persist.mock.calls[0]?.[0]?.name).toBe(SHARED_APP_DIRECTORY);
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
    ).toEqual({ status: 'cancelled' });
    expect(
      await adoptPickedSharedFolder({
        pick: async () => fakeHandle({ permission: 'denied', request: 'denied' }),
        persist,
      }),
    ).toEqual({ status: 'denied' });
    expect(persist).not.toHaveBeenCalled();
  });
});
