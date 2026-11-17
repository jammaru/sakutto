import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_ID,
  HIGH_QUALITY_MODEL_ID,
  SELECTABLE_MODEL_IDS,
  type ModelEntry,
  type ModelId,
} from '@/engine/model/catalog';
import { SharedFolderSession } from '@/engine/model/folder-session';
import { sharedFolderNeedsPermission } from '@/engine/model/folder-status';
import { ModelManager } from '@/engine/model/manager';
import { sha256Hex } from '@/engine/model/sha256';
import {
  loadStoredSharedFolder,
  MemorySharedFolderBucket,
  persistSharedFolderHandle,
  setSharedFolderBucketForTests,
  type FolderPermission,
} from '@/engine/model/shared-folder';
import { bytesOf, FakeRuntime, MemoryFileStore, makeEntry } from './support/fakes';

const PAYLOAD = bytesOf('hello world!');

function entry(id: ModelId): ModelEntry {
  return makeEntry({
    id,
    file: `${id}.gguf`,
    size: PAYLOAD.length,
    sha256: sha256Hex(PAYLOAD),
    url: `https://example.test/${id}.gguf`,
  });
}

const ENTRIES = Object.fromEntries(SELECTABLE_MODEL_IDS.map((id) => [id, entry(id)])) as Readonly<
  Record<ModelId, ModelEntry>
>;

interface MemoryFile {
  data: Uint8Array;
  lastModified: number;
}

/** Minimal shared-folder handle backed by memory files, with mutable permission. */
class MemoryFolder {
  kind = 'directory' as const;
  permission: FolderPermission = 'granted';
  private readonly dirs = new Map<string, MemoryFolder>();
  private readonly files = new Map<string, MemoryFile>();

  constructor(readonly name = 'Sakutto') {}

  handle(): FileSystemDirectoryHandle {
    return this.asHandle(this);
  }

  private asHandle(folder: MemoryFolder): FileSystemDirectoryHandle {
    return {
      kind: 'directory',
      name: folder.name,
      queryPermission: async () => folder.permission,
      requestPermission: async () => folder.permission,
      getDirectoryHandle: async (name: string, options?: { create?: boolean }) => {
        folder.requireGranted();
        let child = folder.dirs.get(name);
        if (!child) {
          if (!options?.create) {
            throw new DOMException(`Missing directory ${name}`, 'NotFoundError');
          }
          child = new MemoryFolder(name);
          child.permission = folder.permission;
          folder.dirs.set(name, child);
        }
        return child.handle();
      },
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        folder.requireGranted();
        let entry = folder.files.get(name);
        if (!entry) {
          if (!options?.create) {
            throw new DOMException(`Missing file ${name}`, 'NotFoundError');
          }
          entry = { data: new Uint8Array(0), lastModified: Date.now() };
          folder.files.set(name, entry);
        }
        const file = entry;
        return {
          kind: 'file',
          name,
          getFile: async () =>
            new File([new Uint8Array(file.data)], name, { lastModified: file.lastModified }),
          createWritable: async (writerOptions?: { keepExistingData?: boolean }) => {
            let buffer = writerOptions?.keepExistingData
              ? new Uint8Array(file.data)
              : new Uint8Array(0);
            let position = 0;
            return {
              write: async (
                chunk: Uint8Array | Blob | { type: 'write'; position?: number; data: Uint8Array },
              ) => {
                let bytes: Uint8Array;
                let offset = position;
                if (chunk instanceof Uint8Array) {
                  bytes = chunk;
                } else if (chunk instanceof Blob) {
                  bytes = new Uint8Array(await chunk.arrayBuffer());
                } else {
                  bytes = chunk.data;
                  offset = chunk.position ?? position;
                }
                if (offset + bytes.length > buffer.length) {
                  const grown = new Uint8Array(offset + bytes.length);
                  grown.set(buffer);
                  buffer = grown;
                }
                buffer.set(bytes, offset);
                position = offset + bytes.length;
              },
              close: async () => {
                file.data = buffer;
                file.lastModified = Date.now();
              },
            };
          },
        } as unknown as FileSystemFileHandle;
      },
      removeEntry: async (name: string, options?: { recursive?: boolean }) => {
        folder.requireGranted();
        if (folder.files.delete(name)) return;
        const child = folder.dirs.get(name);
        if (!child) throw new DOMException(`Missing entry ${name}`, 'NotFoundError');
        if (!options?.recursive) {
          throw new DOMException(`Directory ${name} is not empty`, 'InvalidModificationError');
        }
        folder.dirs.delete(name);
      },
      keys: async function* () {
        yield* folder.dirs.keys();
        yield* folder.files.keys();
      },
    } as unknown as FileSystemDirectoryHandle;
  }

  private requireGranted(): void {
    if (this.permission !== 'granted') {
      throw new DOMException('Permission denied.', 'NotAllowedError');
    }
  }
}

function unreadableHandle(): FileSystemDirectoryHandle {
  const denied = (): DOMException => new DOMException('Permission denied.', 'NotAllowedError');
  return {
    kind: 'directory',
    name: 'Sakutto',
    queryPermission: async () => 'prompt',
    requestPermission: async () => {
      throw denied();
    },
    getDirectoryHandle: async () => {
      throw denied();
    },
  } as unknown as FileSystemDirectoryHandle;
}

async function seededOpfs(): Promise<{ store: MemoryFileStore; manager: ModelManager }> {
  const store = new MemoryFileStore();
  const manager = new ModelManager({
    store,
    entries: ENTRIES,
    createRuntime: async () => new FakeRuntime(() => 'こんにちは'),
    fetchImpl: async () => new Response(new Uint8Array(PAYLOAD), { status: 200 }),
  });
  await manager.download(DEFAULT_MODEL_ID, { signal: new AbortController().signal });
  return { store, manager };
}

afterEach(() => {
  setSharedFolderBucketForTests(null);
});

describe('SharedFolderSession OPFS fallback', () => {
  it('publishes verified OPFS copies when the configured folder needs permission', async () => {
    const bucket = new MemorySharedFolderBucket();
    setSharedFolderBucketForTests(bucket);
    await persistSharedFolderHandle(unreadableHandle(), bucket);
    const { store, manager } = await seededOpfs();

    const session = new SharedFolderSession(store, manager);
    const status = await session.apply();

    expect(sharedFolderNeedsPermission(status)).toBe(true);
    expect(status.opfsCopies).toEqual([DEFAULT_MODEL_ID]);
    expect(status.recordedModels).toEqual([]);
    expect(await manager.status(DEFAULT_MODEL_ID)).toMatchObject({ state: 'ready' });
    expect(await manager.hasReadableCopy(DEFAULT_MODEL_ID)).toBe(true);
    expect(await manager.hasReadableCopy(HIGH_QUALITY_MODEL_ID)).toBe(false);
  });

  it('detects a grant lapse on the cheap status check while the snapshot said granted', async () => {
    const bucket = new MemorySharedFolderBucket();
    setSharedFolderBucketForTests(bucket);
    const folder = new MemoryFolder();
    await persistSharedFolderHandle(folder.handle(), bucket);
    const { store, manager } = await seededOpfs();

    const session = new SharedFolderSession(store, manager);
    const granted = await session.apply();
    expect(granted.permission).toBe('granted');
    expect(granted.opfsCopies).toEqual([DEFAULT_MODEL_ID]);
    expect(granted.recordedModels).toEqual([DEFAULT_MODEL_ID]);

    folder.permission = 'prompt';
    const lapsed = await session.refreshPermissionSnapshot({ force: true });

    expect(lapsed.permission).toBe('prompt');
    expect(sharedFolderNeedsPermission(lapsed)).toBe(true);
    expect(lapsed.opfsCopies).toEqual([DEFAULT_MODEL_ID]);
    expect(lapsed.recordedModels).toEqual([DEFAULT_MODEL_ID]);
    expect(await manager.status(DEFAULT_MODEL_ID)).toMatchObject({ state: 'ready' });
    expect(await manager.hasReadableCopy(DEFAULT_MODEL_ID)).toBe(true);
  });

  it('keeps the handle and recorded models when a granted folder becomes unreadable', async () => {
    const bucket = new MemorySharedFolderBucket();
    setSharedFolderBucketForTests(bucket);
    const folder = new MemoryFolder();
    await persistSharedFolderHandle(folder.handle(), bucket);
    const { store, manager } = await seededOpfs();

    const first = new SharedFolderSession(store, manager);
    const granted = await first.apply();
    expect(granted.permission).toBe('granted');
    expect(granted.recordedModels).toEqual([DEFAULT_MODEL_ID]);

    folder.permission = 'prompt';
    const restarted = new SharedFolderSession(store, manager);
    const lapsed = await restarted.apply();

    expect(lapsed).toMatchObject({
      configured: true,
      permission: 'prompt',
      name: 'Sakutto',
      recordedModels: [DEFAULT_MODEL_ID],
    });
    expect(sharedFolderNeedsPermission(lapsed)).toBe(true);
    expect(await loadStoredSharedFolder(bucket)).not.toBeNull();
    expect(await manager.hasReadableCopy(DEFAULT_MODEL_ID)).toBe(true);
  });

  it('deletes the browser copy when a missing grant made OPFS primary', async () => {
    const bucket = new MemorySharedFolderBucket();
    setSharedFolderBucketForTests(bucket);
    await persistSharedFolderHandle(unreadableHandle(), bucket);
    const { store, manager } = await seededOpfs();

    const session = new SharedFolderSession(store, manager);
    const status = await session.apply();
    expect(status.opfsCopies).toEqual([DEFAULT_MODEL_ID]);

    await manager.deleteFallbackCopy(DEFAULT_MODEL_ID);
    const next = await session.refresh();

    expect(store.files.has(`models/${DEFAULT_MODEL_ID}/model.gguf`)).toBe(false);
    expect(next.opfsCopies).toEqual([]);
    expect(sharedFolderNeedsPermission(next)).toBe(true);
    expect(next.recordedModels).toEqual([]);
  });
});
