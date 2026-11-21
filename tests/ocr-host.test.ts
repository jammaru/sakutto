import { describe, expect, it, vi } from 'vitest';
import { AssetManager } from '@/engine/model/asset-manager';
import { OcrHost, type OcrRuntimeLike } from '@/engine/ocr/host';
import type { OcrTier } from '@/engine/ocr/catalog';
import { MemoryFileStore } from './support/fakes';

const empty = {
  id: 'empty',
  size: 1,
  files: [
    {
      path: 'model.onnx',
      commit: 'pin',
      size: 1,
      sha256: '0'.repeat(64),
      url: 'https://example.test/model.onnx',
    },
  ],
} as const;
const bundles = { standard: { ...empty, id: 'standard' }, high: { ...empty, id: 'high' } } as const;

function assets(): AssetManager<OcrTier> {
  return new AssetManager<OcrTier>({ store: new MemoryFileStore(), bundles });
}

const image = { width: 1, height: 1, data: new Uint8ClampedArray(4) };

describe('OcrHost', () => {
  it('stays lazy until recognition and caches the selected runtime', async () => {
    const manager = assets();
    const createAssetManager = vi.fn(async () => manager);
    const result = { text: '認識', lines: [], regions: [] };
    const runtime: OcrRuntimeLike = {
      recognize: vi.fn(async () => result),
      release: vi.fn(),
    };
    const createRuntime = vi.fn(async () => runtime);
    const host = new OcrHost({ createAssetManager, createRuntime });
    expect(createAssetManager).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();

    await expect(host.recognize('one', 'standard', image)).resolves.toBe(result);
    await expect(host.recognize('two', 'standard', image)).resolves.toBe(result);
    expect(createAssetManager).toHaveBeenCalledOnce();
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(await host.status('standard')).toMatchObject({ state: 'loaded' });
  });

  it('maps cancellation to an engine abort and deletes only after inference settles', async () => {
    const manager = assets();
    let finished = false;
    const runtime: OcrRuntimeLike = {
      recognize: (_image, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            finished = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
      release: vi.fn(async () => {
        expect(finished).toBe(true);
      }),
    };
    const host = new OcrHost({
      createAssetManager: async () => manager,
      createRuntime: async () => runtime,
    });
    const pending = host.recognize('cancel-me', 'standard', image);
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.cancel('cancel-me');
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await host.delete('standard');
    expect(runtime.release).toHaveBeenCalledOnce();
    expect(await host.status('standard')).toMatchObject({ state: 'absent' });
  });

  it('serializes independent same-tier callers without aborting either request', async () => {
    const manager = assets();
    const signals: AbortSignal[] = [];
    const runtime: OcrRuntimeLike = {
      recognize: async (_image, signal) => {
        signals.push(signal);
        return { text: 'ok', lines: [], regions: [] };
      },
      release: vi.fn(),
    };
    const host = new OcrHost({
      createAssetManager: async () => manager,
      createRuntime: async () => runtime,
    });

    const first = host.recognize('reader-a', 'standard', image);
    const second = host.recognize('reader-b', 'standard', image);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });

  it('keeps a replacement registered when the aborted request cleans up late', async () => {
    const manager = assets();
    const signals: AbortSignal[] = [];
    const runtime: OcrRuntimeLike = {
      recognize: (_image, signal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
      release: vi.fn(),
    };
    const host = new OcrHost({
      createAssetManager: async () => manager,
      createRuntime: async () => runtime,
    });

    const first = host.recognize('same-id', 'standard', image);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const second = host.recognize('same-id', 'standard', image);
    await expect(first).rejects.toMatchObject({ code: 'aborted' });
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    host.cancel('same-id');
    await expect(second).rejects.toMatchObject({ code: 'aborted' });
  });
});
