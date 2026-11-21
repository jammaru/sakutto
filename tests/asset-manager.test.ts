import { describe, expect, it, vi } from 'vitest';
import { AssetManager, parseAssetManifest } from '@/engine/model/asset-manager';
import type { AssetBundle } from '@/engine/model/asset';
import { sha256Hex } from '@/engine/model/sha256';
import { MemoryFileStore, bytesOf } from './support/fakes';

const DET = bytesOf('det weights');
const REC = bytesOf('recognition weights');

function file(path: string, payload: Uint8Array) {
  return {
    path,
    url: `https://example.test/${path}`,
    commit: 'pinned-commit',
    size: payload.length,
    sha256: sha256Hex(payload),
  };
}

function bundle(): AssetBundle<'standard'> {
  const files = [file('det.onnx', DET), file('rec.onnx', REC)];
  return { id: 'standard', files, size: DET.length + REC.length };
}

function hashBlob(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => sha256Hex(new Uint8Array(buffer)));
}

function fullResponse(input: RequestInfo | URL): Response {
  const path = String(input).split('/').at(-1);
  return new Response(new Uint8Array(path === 'det.onnx' ? DET : REC), { status: 200 });
}

describe('AssetManager', () => {
  it('downloads, verifies, reads and deletes a multi-file bundle', async () => {
    const store = new MemoryFileStore();
    const manager = new AssetManager({
      store,
      bundles: { standard: bundle() },
      fetchImpl: async (input) => fullResponse(input),
      hashBlob,
    });

    expect(await manager.status('standard')).toMatchObject({ state: 'absent', received: 0 });
    await manager.download('standard', { signal: new AbortController().signal });
    expect(await manager.status('standard')).toMatchObject({
      state: 'ready',
      received: DET.length + REC.length,
      progress: 1,
    });
    expect(await (await manager.readFile('standard', 'det.onnx')).text()).toBe('det weights');
    expect(store.text('models/ocr-standard/asset.json')).toContain('pinned-commit');

    await manager.delete('standard');
    expect(await manager.status('standard')).toMatchObject({ state: 'absent', received: 0 });
    expect(
      [...store.files.keys()].filter((path) => path.startsWith('models/ocr-standard/')),
    ).toEqual([]);
  });

  it('keeps a cancelled prefix and resumes it through the same downloader', async () => {
    const store = new MemoryFileStore();
    const first = new AssetManager({
      store,
      bundles: { standard: bundle() },
      hashBlob,
      fetchImpl: async (_input, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(DET.slice(0, 4));
              init?.signal?.addEventListener('abort', () => {
                stream.error(new DOMException('Aborted', 'AbortError'));
              });
            },
          }),
          { status: 200 },
        ),
    });
    const controller = new AbortController();
    const pending = first.download('standard', { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(store.files.get('models/ocr-standard/det.onnx.part')).toHaveLength(4);
    expect(await first.status('standard')).toMatchObject({ state: 'partial', received: 4 });

    const resumed = new AssetManager({
      store,
      bundles: { standard: bundle() },
      hashBlob,
      fetchImpl: async (input, init) => {
        const payload = String(input).endsWith('det.onnx') ? DET : REC;
        const range = new Headers(init?.headers).get('range');
        const start = Number(/^bytes=(\d+)-/.exec(range ?? '')?.[1] ?? 0);
        const end = Number(/^bytes=\d+-(\d+)$/.exec(range ?? '')?.[1] ?? payload.length - 1);
        return new Response(new Uint8Array(payload.slice(start, end + 1)), {
          status: 206,
          headers: {
            'content-range': `bytes ${start}-${end}/${payload.length}`,
            'content-length': String(end - start + 1),
          },
        });
      },
    });
    await resumed.download('standard', { signal: new AbortController().signal });
    expect(await resumed.status('standard')).toMatchObject({ state: 'ready', progress: 1 });
    expect(store.files.has('models/ocr-standard/det.onnx.part')).toBe(false);
  });

  it('enforces the shared consent gate before any network request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const manager = new AssetManager({
      store: new MemoryFileStore(),
      bundles: { standard: bundle() },
      hasConsent: () => false,
      fetchImpl,
    });
    await expect(
      manager.download('standard', { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('asset manifest parsing', () => {
  it('accepts complete metadata and rejects malformed or cross-bundle sidecars', () => {
    const manifest = {
      id: 'standard',
      verifiedAt: 123,
      files: [{ path: 'det.onnx', sha256: 'a'.repeat(64), size: 10, commit: 'abc' }],
    };
    expect(parseAssetManifest(manifest, 'standard')).toEqual(manifest);
    expect(parseAssetManifest(manifest, 'high')).toBeNull();
    expect(parseAssetManifest({ ...manifest, files: [{ path: 'det.onnx' }] })).toBeNull();
    expect(parseAssetManifest('not json')).toBeNull();
  });
});
