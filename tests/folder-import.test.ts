import { describe, expect, it } from 'vitest';
import {
  copySharedFolderFilesToOpfs,
  discoverSharedModelFiles,
  importedDefaultModel,
} from '@/engine/model/folder-import';
import { sha256Hex } from '@/engine/model/sha256';
import { bytesOf, makeEntry, MemoryFileStore } from './support/fakes';

const PAYLOAD = bytesOf('official folder model bytes');
const ENTRY = makeEntry({
  size: PAYLOAD.length,
  sha256: sha256Hex(PAYLOAD),
  file: 'plamo-test.gguf',
});

function fileAt(relativePath: string, bytes: Uint8Array = PAYLOAD): File {
  const name = relativePath.split('/').pop() ?? relativePath;
  const file = new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

function options(overrides: Partial<Parameters<typeof copySharedFolderFilesToOpfs>[0]> = {}) {
  return {
    files: [fileAt(`Sakutto/sakutto-models/${ENTRY.file}`)],
    store: new MemoryFileStore(),
    signal: new AbortController().signal,
    modelIds: [ENTRY.id] as const,
    entries: { [ENTRY.id]: ENTRY },
    ...overrides,
  };
}

describe('discoverSharedModelFiles', () => {
  it('accepts a parent folder or the inner sakutto-models folder', () => {
    for (const path of [
      `Sakutto/sakutto-models/${ENTRY.file}`,
      `sakutto/sakutto-models/${ENTRY.file}`,
      `sakutto-models/${ENTRY.file}`,
    ]) {
      const matches = discoverSharedModelFiles([fileAt(path)], {
        modelIds: [ENTRY.id],
        entries: { [ENTRY.id]: ENTRY },
      });
      expect(matches).toHaveLength(1);
      expect(matches[0]?.modelId).toBe(ENTRY.id);
      expect(matches[0]?.relativePath).toBe(path);
    }
  });

  it('prefers the copy inside sakutto-models when both are selected', () => {
    const parent = fileAt(`Sakutto/${ENTRY.file}`, bytesOf('outside'));
    const inner = fileAt(`Sakutto/sakutto-models/${ENTRY.file}`);
    const matches = discoverSharedModelFiles([parent, inner], {
      modelIds: [ENTRY.id],
      entries: { [ENTRY.id]: ENTRY },
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.relativePath).toBe(`Sakutto/sakutto-models/${ENTRY.file}`);
  });

  it('ignores unrelated GGUF files', () => {
    expect(
      discoverSharedModelFiles([fileAt('Documents/other.gguf')], {
        modelIds: [ENTRY.id],
        entries: { [ENTRY.id]: ENTRY },
      }),
    ).toEqual([]);
  });
});

describe('copySharedFolderFilesToOpfs', () => {
  it('verifies and installs a matching official file without a network request', async () => {
    const store = new MemoryFileStore();
    const phases: string[] = [];
    const result = await copySharedFolderFilesToOpfs(
      options({
        store,
        onProgress: (progress) => {
          if (!phases.includes(progress.transfer.phase)) {
            phases.push(progress.transfer.phase);
          }
        },
        chunkBytes: 4,
      }),
    );

    expect(result).toMatchObject({
      discovered: [ENTRY.id],
      imported: [ENTRY.id],
      failed: [],
    });
    expect(importedDefaultModel(result)).toBe(true);
    expect(phases).toEqual(['copy', 'verify']);
    expect(store.files.get(`models/${ENTRY.id}/model.gguf`)).toEqual(PAYLOAD);
    expect(store.text(`models/${ENTRY.id}/model.json`)).toContain(ENTRY.sha256);
  });

  it('rejects a matching filename with the wrong size and writes nothing', async () => {
    const store = new MemoryFileStore();
    const result = await copySharedFolderFilesToOpfs(
      options({
        store,
        files: [fileAt(`Sakutto/sakutto-models/${ENTRY.file}`, bytesOf('short'))],
      }),
    );

    expect(result.imported).toEqual([]);
    expect(result.failed.map((failure) => failure.modelId)).toEqual([ENTRY.id]);
    expect(store.files.size).toBe(0);
  });

  it('returns no matches when the folder has no official model', async () => {
    const result = await copySharedFolderFilesToOpfs(
      options({ files: [fileAt('Sakutto/sakutto-models/other.gguf')] }),
    );

    expect(result).toMatchObject({ discovered: [], imported: [], failed: [] });
  });

  it('propagates cancellation and removes the temporary file', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();

    await expect(
      copySharedFolderFilesToOpfs(
        options({
          store,
          signal: controller.signal,
          chunkBytes: 4,
          onProgress: (progress) => {
            if (progress.transfer.phase === 'copy' && progress.transfer.received > 0) {
              controller.abort();
            }
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'aborted' });

    expect([...store.files.keys()].some((path) => path.endsWith('.part'))).toBe(false);
    expect(store.files.has(`models/${ENTRY.id}/model.gguf`)).toBe(false);
  });
});
