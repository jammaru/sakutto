import { describe, expect, it, vi } from 'vitest';
import { AssetManager, parseAssetManifest } from '@/engine/model/asset-manager';
import type { AssetBundle } from '@/engine/model/asset';
import { sha256Hex } from '@/engine/model/sha256';
import { MemoryFileStore, bytesOf } from './support/fakes';
import { flushTasks } from './support/ports';

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

  it('cancels and awaits automatic verification before deleting a bundle', async () => {
    const store = new MemoryFileStore();
    await store.append('models/ocr-standard/det.onnx', DET, 0);
    await store.append('models/ocr-standard/rec.onnx', REC, 0);

    let notifyHashStarted!: (signal: AbortSignal | undefined) => void;
    const hashStarted = new Promise<AbortSignal | undefined>((resolve) => {
      notifyHashStarted = resolve;
    });
    let releaseHash!: () => void;
    const hashGate = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    let hashCalls = 0;
    const states: string[] = [];
    const manager = new AssetManager({
      store,
      bundles: { standard: bundle() },
      onStatus: (status) => states.push(status.state),
      hashBlob: async (blob, options) => {
        hashCalls += 1;
        if (hashCalls === 1) {
          notifyHashStarted(options?.signal);
          // Deliberately ignore abort to exercise the generation guard as well as cancellation.
          await hashGate;
        }
        return hashBlob(blob);
      },
    });

    const status = manager.status('standard');
    const signal = await hashStarted;
    await expect(status).resolves.toMatchObject({ state: 'verifying' });
    const removeDirectory = vi.spyOn(store, 'removeDirectory');
    const deletion = manager.delete('standard');
    await Promise.resolve();
    const removalsBeforeHashSettled = removeDirectory.mock.calls.length;
    releaseHash();
    await deletion;

    expect(signal?.aborted).toBe(true);
    expect(removalsBeforeHashSettled).toBe(0);
    expect(store.files.has('models/ocr-standard/asset.json')).toBe(false);
    expect(
      [...store.files.keys()].filter((path) => path.startsWith('models/ocr-standard/')),
    ).toEqual([]);
    expect(states).not.toContain('ready');
    expect(states).not.toContain('error');
    expect(states.at(-1)).toBe('absent');
    await expect(manager.status('standard')).resolves.toMatchObject({ state: 'absent' });
  });

  it('cancel aborts automatic verification without publishing ready or error', async () => {
    const store = new MemoryFileStore();
    await store.append('models/ocr-standard/det.onnx', DET, 0);
    await store.append('models/ocr-standard/rec.onnx', REC, 0);

    let notifyHashStarted!: (signal: AbortSignal | undefined) => void;
    const hashStarted = new Promise<AbortSignal | undefined>((resolve) => {
      notifyHashStarted = resolve;
    });
    const states: string[] = [];
    const manager = new AssetManager({
      store,
      bundles: { standard: bundle() },
      onStatus: (status) => states.push(status.state),
      hashBlob: (_blob, options) =>
        new Promise<string>((_resolve, reject) => {
          notifyHashStarted(options?.signal);
          options?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    });

    const status = manager.status('standard');
    const signal = await hashStarted;
    await expect(status).resolves.toMatchObject({ state: 'verifying' });
    manager.cancel('standard');
    // delete() also awaits the cancelled operation, making this assertion deterministic.
    await manager.delete('standard');

    expect(signal?.aborted).toBe(true);
    expect(states).not.toContain('ready');
    expect(states).not.toContain('error');
    expect(store.files.has('models/ocr-standard/asset.json')).toBe(false);
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

  it('never reports full .part files as a ready bundle', async () => {
    const store = new MemoryFileStore();
    await store.append('models/ocr-standard/det.onnx.part', DET, 0);
    await store.append('models/ocr-standard/rec.onnx.part', REC, 0);
    const hash = vi.fn(hashBlob);
    const manager = new AssetManager({
      store,
      bundles: { standard: bundle() },
      hashBlob: hash,
    });

    expect(await manager.status('standard')).toMatchObject({
      state: 'partial',
      received: DET.length + REC.length,
    });
    await flushTasks();
    expect(await manager.status('standard')).toMatchObject({ state: 'partial' });
    expect(hash).not.toHaveBeenCalled();
  });

  it('keeps the source when a target has only parts and when copying into the same store', async () => {
    const source = new MemoryFileStore();
    const manager = new AssetManager({
      store: source,
      bundles: { standard: bundle() },
      fetchImpl: async (input) => fullResponse(input),
      hashBlob,
    });
    await manager.download('standard', { signal: new AbortController().signal });

    const target = new MemoryFileStore();
    await target.append('models/ocr-standard/det.onnx.part', DET, 0);
    await target.append('models/ocr-standard/rec.onnx.part', REC, 0);
    expect(await manager.copyToStore('standard', target, { removeSource: true })).toBe(true);

    // The parts were replaced by verified finals; the original store is still intact.
    expect([...target.files.keys()]).toContain('models/ocr-standard/det.onnx');
    expect([...target.files.keys()]).toContain('models/ocr-standard/rec.onnx');
    expect([...target.files.keys()]).toContain('models/ocr-standard/asset.json');
    expect([...source.files.keys()]).toContain('models/ocr-standard/det.onnx');
    await expect(
      new AssetManager({ store: target, bundles: { standard: bundle() }, hashBlob }).status(
        'standard',
      ),
    ).resolves.toMatchObject({ state: 'ready', progress: 1 });

    // A same-store "move" has nothing to transfer and must never delete its own finals.
    expect(await manager.copyToStore('standard', source, { removeSource: true })).toBe(true);
    expect([...source.files.keys()]).toContain('models/ocr-standard/det.onnx');
  });

  it('keeps an incomplete bundle partial without starting verification or caching an error', async () => {
    const store = new MemoryFileStore();
    await store.append('models/ocr-standard/det.onnx', DET, 0);
    await store.append('models/ocr-standard/rec.onnx.part', REC.slice(0, 4), 0);
    const hash = vi.fn(hashBlob);
    const states: string[] = [];
    let notifyReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      notifyReady = resolve;
    });
    const manager = new AssetManager({
      store,
      bundles: { standard: bundle() },
      hashBlob: hash,
      onStatus: (status) => {
        states.push(status.state);
        if (status.state === 'ready') notifyReady();
      },
    });

    expect(await manager.status('standard')).toMatchObject({
      state: 'partial',
      received: DET.length + 4,
    });
    await flushTasks();
    expect(await manager.status('standard')).toMatchObject({ state: 'partial' });
    // Even an explicit read of the existing final cannot turn a missing sibling into a
    // permanently cached verification error.
    await expect(manager.readFile('standard', 'det.onnx')).rejects.toMatchObject({
      code: 'model-missing',
    });
    expect(await manager.status('standard')).toMatchObject({ state: 'partial' });
    expect(hash).not.toHaveBeenCalled();
    expect(states).not.toContain('verifying');
    expect(states).not.toContain('error');

    await store.append('models/ocr-standard/rec.onnx', REC, 0);
    await expect(manager.status('standard')).resolves.toMatchObject({ state: 'verifying' });
    await ready;
    await expect(manager.status('standard')).resolves.toMatchObject({
      state: 'ready',
      progress: 1,
    });
    expect(hash).toHaveBeenCalledTimes(2);
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
