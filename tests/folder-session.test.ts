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
  MemorySharedFolderBucket,
  persistSharedFolderHandle,
  setSharedFolderBucketForTests,
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
});
