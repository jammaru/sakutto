import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID, HIGH_QUALITY_MODEL_ID, getModel } from '@/engine/model/catalog';
import {
  mapManagerPathToSharedName,
  pinnedSharedNames,
  SharedFolderModelFileStore,
} from '@/engine/model/shared-store';
import { bytesOf, MemoryFileStore } from './support/fakes';

describe('shared folder path mapping', () => {
  it('maps manager paths onto the official PFN filenames', () => {
    const file = getModel(DEFAULT_MODEL_ID).file;
    expect(mapManagerPathToSharedName(`models/${DEFAULT_MODEL_ID}/model.gguf`)).toBe(file);
    expect(mapManagerPathToSharedName(`models/${DEFAULT_MODEL_ID}/model.gguf.part`)).toBe(
      `${file}.part`,
    );
    expect(mapManagerPathToSharedName(`models/${DEFAULT_MODEL_ID}/model.json`)).toBe(
      `${file}.verified.json`,
    );
    expect(mapManagerPathToSharedName(`models/${HIGH_QUALITY_MODEL_ID}/model.gguf`)).toBe(
      getModel(HIGH_QUALITY_MODEL_ID).file,
    );
  });

  it('refuses paths that are not a pinned catalog model', () => {
    expect(mapManagerPathToSharedName('models/not-a-model/model.gguf')).toBeNull();
    expect(mapManagerPathToSharedName('other/model.gguf')).toBeNull();
    expect(mapManagerPathToSharedName(`models/${DEFAULT_MODEL_ID}/extra.bin`)).toBeNull();
  });

  it('lists only the three pinned names a UI delete may remove', () => {
    const file = getModel(DEFAULT_MODEL_ID).file;
    expect(pinnedSharedNames(DEFAULT_MODEL_ID)).toEqual([
      file,
      `${file}.part`,
      `${file}.verified.json`,
    ]);
  });
});

describe('SharedFolderModelFileStore', () => {
  it('writes, reads and deletes only the official names', async () => {
    const inner = new MemoryFileStore();
    const store = new SharedFolderModelFileStore(inner);
    const payload = bytesOf('gguf-bytes');
    const path = `models/${DEFAULT_MODEL_ID}/model.gguf`;

    await store.append(path, payload, 0);
    expect(inner.files.has(getModel(DEFAULT_MODEL_ID).file)).toBe(true);
    expect(inner.files.has(path)).toBe(false);
    expect(new Uint8Array(await (await store.read(path)).arrayBuffer())).toEqual(payload);

    await store.append(`models/${DEFAULT_MODEL_ID}/model.json`, bytesOf('{}'), 0);
    inner.files.set('user-notes.txt', bytesOf('keep me'));
    await store.removeDirectory(`models/${DEFAULT_MODEL_ID}`);
    expect(inner.files.has(getModel(DEFAULT_MODEL_ID).file)).toBe(false);
    expect(inner.files.has(`${getModel(DEFAULT_MODEL_ID).file}.verified.json`)).toBe(false);
    expect(inner.files.has('user-notes.txt')).toBe(true);
  });

  it('does not report an origin quota for the user volume', async () => {
    const store = new SharedFolderModelFileStore(new MemoryFileStore());
    expect(await store.estimate()).toEqual({ usage: 0, quota: 0 });
  });
});
