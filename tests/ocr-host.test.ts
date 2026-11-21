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
});
