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
  preparePickedSharedFolder,
  ensureStoredFolderPermission,
  isDocumentsFolderName,
  isRecommendedSharedFolderName,
  isSharedModelsDirectoryName,
  openSharedModelsDirectory,
  persistSharedFolderHandle,
  pickSharedModelFolder,
  probeStoredFolderReadable,
  queryFolderPermission,
  queryStoredFolderPermission,
  rememberSharedFolderPresentModels,
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
    keys: async function* () {
      yield* dir.dirs.keys();
      yield* dir.files.keys();
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

async function fileNamesIn(handle: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const name of handle.keys()) {
    try {
      await handle.getFileHandle(name);
      names.push(name);
    } catch {
      // Child is a directory, not a file.
    }
  }
  return names.sort();
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
      await requestFolderPermission(
        fakeHandle({ permission: 'prompt', request: 'granted' }),
        'readwrite',
        'chrome-extension://id/folder-enable.html',
      ),
    ).toBe('granted');
    expect(
      await requestFolderPermission(
        fakeHandle({ permission: 'prompt', request: 'denied' }),
        'readwrite',
        'chrome-extension://id/folder-enable.html',
      ),
    ).toBe('denied');
  });

  it('restores a stored handle from a user gesture', async () => {
    const bucket = new MemorySharedFolderBucket();
    setSharedFolderBucketForTests(bucket);
    const handle = fakeHandle({ permission: 'prompt', request: 'granted' });
    await persistSharedFolderHandle(handle, bucket);
    expect(
      await restoreStoredFolderPermission({
        href: 'chrome-extension://id/folder-enable.html',
      }),
    ).toBe('granted');
  });

  it('probes a leftover readable handle without calling requestPermission', async () => {
    const bucket = new MemorySharedFolderBucket();
    setSharedFolderBucketForTests(bucket);
    const handle = fakeHandle({ permission: 'prompt', request: 'denied' });
    await persistSharedFolderHandle(handle, bucket);
    expect(await probeStoredFolderReadable()).toBe(true);
  });

  it('probes an inner sakutto-models handle without looking for a nested child', async () => {
    const bucket = new MemorySharedFolderBucket();
    setSharedFolderBucketForTests(bucket);
    const handle = fakeHandleFrom(fakeDir(SHARED_MODELS_DIRECTORY, { permission: 'prompt' }));
    const getDirectoryHandle = vi.spyOn(handle, 'getDirectoryHandle');
    await persistSharedFolderHandle(handle, bucket);
    expect(await probeStoredFolderReadable()).toBe(true);
    expect(getDirectoryHandle).not.toHaveBeenCalled();
  });

  it('remembers which official models were last verified in the folder', async () => {
    const bucket = new MemorySharedFolderBucket();
    setSharedFolderBucketForTests(bucket);
    const handle = fakeHandle({ name: 'Sakutto' });
    await persistSharedFolderHandle(handle, bucket);
    await rememberSharedFolderPresentModels([DEFAULT_MODEL_ID], bucket);
    const stored = await bucket.get();
    expect(stored?.presentModels).toEqual([DEFAULT_MODEL_ID]);
    expect(isStoredSharedFolder(stored)).toBe(true);
  });
});

describe('activation re-grant', () => {
  const handle = fakeHandle({});
  const stored = { handle, name: handle.name, savedAt: 1 };

  it('queries a stored handle without requesting when it is already granted', async () => {
    const requestPermission = vi.fn(async () => 'granted' as const);
    const result = await ensureStoredFolderPermission('readwrite', {
      load: async () => stored,
      queryPermission: async () => 'granted',
      requestPermission,
    });
    expect(result).toEqual({ status: 'granted', handle, changed: false });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(await queryStoredFolderPermission('read', async () => stored)).toBe('granted');
  });

  it('silently turns a prompt into a grant on a click-driven surface', async () => {
    const requestPermission = vi.fn(async () => 'granted' as const);
    const result = await ensureStoredFolderPermission('readwrite', {
      load: async () => stored,
      queryPermission: async () => 'prompt',
      requestPermission,
      href: 'chrome-extension://id/folder-enable.html',
    });
    expect(result).toEqual({ status: 'granted', handle, changed: true });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(requestPermission).toHaveBeenCalledWith(handle, 'readwrite');
  });

  it('does not request permission from a popup surface', async () => {
    const requestPermission = vi.fn(async () => 'granted' as const);
    const result = await ensureStoredFolderPermission('readwrite', {
      load: async () => stored,
      queryPermission: async () => 'prompt',
      requestPermission,
      href: 'chrome-extension://id/popup.html',
    });
    expect(result).toEqual({ status: 'prompt', handle, changed: false });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('does not ask again after a denial, and does nothing without a stored folder', async () => {
    const requestPermission = vi.fn(async () => 'granted' as const);
    expect(
      await ensureStoredFolderPermission('readwrite', {
        load: async () => stored,
        queryPermission: async () => 'denied',
        requestPermission,
      }),
    ).toEqual({ status: 'denied', handle, changed: false });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(await ensureStoredFolderPermission()).toEqual({ status: 'none', changed: false });
    expect(await queryStoredFolderPermission()).toBeNull();
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
  it('recognizes Documents, Sakutto, and models directory names', () => {
    expect(isDocumentsFolderName('Documents')).toBe(true);
    expect(isDocumentsFolderName('ドキュメント')).toBe(true);
    expect(isDocumentsFolderName('書類')).toBe(true);
    expect(isDocumentsFolderName('Downloads')).toBe(false);
    expect(isRecommendedSharedFolderName('Sakutto')).toBe(true);
    expect(isRecommendedSharedFolderName('sakutto')).toBe(true);
    expect(isSharedModelsDirectoryName(SHARED_MODELS_DIRECTORY)).toBe(true);
    expect(isSharedModelsDirectoryName('Sakutto-Models')).toBe(true);
    expect(isSharedModelsDirectoryName(SHARED_APP_DIRECTORY)).toBe(false);
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

  it('keeps an inner sakutto-models pick even with no complete GGUF', async () => {
    const empty = fakeDir(SHARED_MODELS_DIRECTORY);
    const emptyHandle = fakeHandleFrom(empty);
    expect(await resolveSharedFolderRoot(emptyHandle)).toBe(emptyHandle);
    expect(empty.dirs.has(SHARED_MODELS_DIRECTORY)).toBe(false);

    const partial = fakeDir(SHARED_MODELS_DIRECTORY, {
      files: [`${getModel(DEFAULT_MODEL_ID).file}.part`],
    });
    const partialHandle = fakeHandleFrom(partial);
    expect(await resolveSharedFolderRoot(partialHandle)).toBe(partialHandle);
    expect(partial.dirs.has(SHARED_MODELS_DIRECTORY)).toBe(false);
  });

  it('opens an empty sakutto-models pick directly without creating a nested child', async () => {
    const picked = fakeDir(SHARED_MODELS_DIRECTORY);
    const handle = fakeHandleFrom(picked);
    expect(await openSharedModelsDirectory(handle)).toBe(handle);
    expect(picked.dirs.has(SHARED_MODELS_DIRECTORY)).toBe(false);
  });

  it('opens a partially downloaded sakutto-models pick directly without nesting', async () => {
    const picked = fakeDir(SHARED_MODELS_DIRECTORY, {
      files: [`${getModel(DEFAULT_MODEL_ID).file}.part`],
    });
    const handle = fakeHandleFrom(picked);
    expect(await openSharedModelsDirectory(handle)).toBe(handle);
    expect(picked.dirs.has(SHARED_MODELS_DIRECTORY)).toBe(false);
  });

  it('still opens sakutto-models as a child of a picked parent Sakutto folder', async () => {
    const sakutto = fakeDir(SHARED_APP_DIRECTORY);
    const root = await resolveSharedFolderRoot(fakeHandleFrom(sakutto));
    expect(root.name).toBe(SHARED_APP_DIRECTORY);
    expect(sakutto.dirs.has(SHARED_MODELS_DIRECTORY)).toBe(false);

    const models = await openSharedModelsDirectory(root);
    expect(models.name).toBe(SHARED_MODELS_DIRECTORY);
    expect(sakutto.dirs.has(SHARED_MODELS_DIRECTORY)).toBe(true);
  });

  it('keeps a folder that already holds an official GGUF as-is', async () => {
    const file = getModel(DEFAULT_MODEL_ID).file;
    const picked = fakeDir('Downloaded', { files: [file] });
    const handle = fakeHandleFrom(picked);
    const root = await resolveSharedFolderRoot(handle);
    expect(root).toBe(handle);
    expect(await openSharedModelsDirectory(root)).toBe(handle);
    expect(picked.dirs.has(SHARED_MODELS_DIRECTORY)).toBe(false);
  });

  it('opens the same logical models files for a parent pick and an inner pick', async () => {
    const file = getModel(DEFAULT_MODEL_ID).file;
    const inner = fakeDir(SHARED_MODELS_DIRECTORY, { files: [file] });
    const sakutto = fakeDir(SHARED_APP_DIRECTORY, {
      dirs: { [SHARED_MODELS_DIRECTORY]: inner },
    });

    const fromParent = await openSharedModelsDirectory(
      await resolveSharedFolderRoot(fakeHandleFrom(sakutto)),
    );
    const fromInner = await openSharedModelsDirectory(
      await resolveSharedFolderRoot(fakeHandleFrom(inner)),
    );

    expect(await fileNamesIn(fromParent)).toEqual([file]);
    expect(await fileNamesIn(fromInner)).toEqual([file]);
    expect(inner.dirs.has(SHARED_MODELS_DIRECTORY)).toBe(false);
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
    ).toEqual({ status: 'granted', handle, name: 'Models' });
    expect(persist).toHaveBeenCalledOnce();
  });

  it('persists the Sakutto subfolder when Documents is picked', async () => {
    const documents = fakeDir('Documents');
    const persist = vi.fn(async (handle: FileSystemDirectoryHandle) => ({
      handle,
      name: handle.name,
      savedAt: 1,
    }));
    const granted = await adoptPickedSharedFolder({
      pick: async () => fakeHandleFrom(documents),
      persist,
    });
    expect(granted.status).toBe('granted');
    if (granted.status === 'granted') {
      expect(granted.name).toBe(SHARED_APP_DIRECTORY);
      expect(granted.handle.name).toBe(SHARED_APP_DIRECTORY);
    }
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

describe('preparePickedSharedFolder', () => {
  it('returns the handle without persisting', async () => {
    const handle = fakeHandle({ permission: 'granted' });
    const persist = vi.fn();
    expect(
      await preparePickedSharedFolder({
        pick: async () => handle,
      }),
    ).toEqual({ status: 'granted', handle, name: handle.name });
    expect(persist).not.toHaveBeenCalled();
  });
});
