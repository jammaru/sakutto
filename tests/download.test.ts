import { describe, expect, it, vi } from 'vitest';
import { EngineError } from '@/engine/errors';
import { downloadModel, type DownloadProgress } from '@/engine/model/download';
import { sha256Hex } from '@/engine/model/sha256';
import { bytesOf, MemoryFileStore, streamOf } from './support/fakes';

const PAYLOAD = bytesOf('hello world!');
const PART = 'model.gguf.part';
const FINAL = 'model.gguf';

function sourceOf(bytes: Uint8Array, overrides: { size?: number; sha256?: string } = {}) {
  return {
    url: 'https://example.test/model.gguf',
    size: bytes.length,
    sha256: sha256Hex(bytes),
    ...overrides,
  };
}

function baseRequest(store: MemoryFileStore, signal: AbortSignal) {
  return {
    source: sourceOf(PAYLOAD),
    store,
    partPath: PART,
    finalPath: FINAL,
    signal,
    attempts: 1,
    retryDelayMs: 0,
  };
}

describe('resumable model download', () => {
  it('downloads, verifies and moves a fresh file', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(streamOf([PAYLOAD.slice(0, 5), PAYLOAD.slice(5)]), { status: 200 }),
    );
    const progress: DownloadProgress[] = [];

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      fetchImpl,
      onProgress: (event) => progress.push(event),
    });

    expect(result).toEqual({ bytes: PAYLOAD.length, sha256: sha256Hex(PAYLOAD), resumedFrom: 0 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Range).toBeUndefined();
    expect(store.files.has(PART)).toBe(false);
    expect(new TextDecoder().decode(store.files.get(FINAL))).toBe('hello world!');
    expect(progress[0]).toMatchObject({ received: 0, ratio: 0, resumedFrom: 0 });
    expect(progress.at(-1)).toMatchObject({ received: 12, ratio: 1, resumedFrom: 0 });
  });

  it('resumes from the partial file with an HTTP Range request', async () => {
    const store = new MemoryFileStore();
    await store.append(PART, PAYLOAD.slice(0, 4), 0);
    const controller = new AbortController();

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const headers = init?.headers as Record<string, string>;
      expect(headers.Range).toBe('bytes=4-');
      return new Response(streamOf([PAYLOAD.slice(4)]), { status: 206 });
    });

    const progress: DownloadProgress[] = [];
    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      fetchImpl,
      onProgress: (event) => progress.push(event),
    });

    expect(result.resumedFrom).toBe(4);
    expect(progress[0]).toMatchObject({ received: 4, ratio: 4 / 12, resumedFrom: 4 });
    expect(new TextDecoder().decode(store.files.get(FINAL))).toBe('hello world!');
  });

  it('restarts when the server ignores the range header', async () => {
    const store = new MemoryFileStore();
    await store.append(PART, bytesOf('XXXXXXXX'), 0);
    const controller = new AbortController();

    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(PAYLOAD), { status: 200 }));

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      fetchImpl,
    });

    expect(result.resumedFrom).toBe(8);
    expect(new TextDecoder().decode(store.files.get(FINAL))).toBe('hello world!');
  });

  it('drops the partial file when the server rejects the range', async () => {
    const store = new MemoryFileStore();
    await store.append(PART, PAYLOAD.slice(0, 4), 0);
    const controller = new AbortController();

    const fetchImpl = vi.fn(async () => new Response(null, { status: 416 }));

    await expect(
      downloadModel({ ...baseRequest(store, controller.signal), fetchImpl }),
    ).rejects.toMatchObject({ code: 'download-failed' });
    expect(store.files.has(PART)).toBe(false);
  });

  it('rejects a digest mismatch and removes the partial file', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const fetchImpl = async () => new Response(new Uint8Array(PAYLOAD), { status: 200 });

    await expect(
      downloadModel({
        ...baseRequest(store, controller.signal),
        source: sourceOf(PAYLOAD, { sha256: 'f'.repeat(64) }),
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'model-integrity' });
    expect(store.files.has(PART)).toBe(false);
    expect(store.files.has(FINAL)).toBe(false);
  });

  it('keeps the downloaded prefix when the caller aborts', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(PAYLOAD.slice(0, 4));
            init?.signal?.addEventListener('abort', () => {
              stream.error(new DOMException('Aborted', 'AbortError'));
            });
          },
        }),
        { status: 200 },
      );
    };

    const promise = downloadModel({
      ...baseRequest(store, controller.signal),
      fetchImpl,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(EngineError);
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(store.files.get(PART)?.length).toBe(4);
    expect(store.files.has(FINAL)).toBe(false);
  });

  it('rejects an oversized body without leaving a partial file', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const fetchImpl = async () =>
      new Response(new Uint8Array(bytesOf('0123456789ABCDEF')), { status: 200 });

    await expect(
      downloadModel({
        ...baseRequest(store, controller.signal),
        source: sourceOf(PAYLOAD, { size: 8 }),
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'download-failed' });
    expect(store.files.has(PART)).toBe(false);
  });

  it('retries transient failures and resumes the transfer', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();
    let attempt = 0;

    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('network down');
      return new Response(streamOf([PAYLOAD.slice(4)]), { status: 206 });
    });

    await store.append(PART, PAYLOAD.slice(0, 4), 0);
    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      fetchImpl,
      attempts: 2,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.resumedFrom).toBe(4);
    expect(new TextDecoder().decode(store.files.get(FINAL))).toBe('hello world!');
  });

  it('does not retry a missing model', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));

    await expect(
      downloadModel({
        ...baseRequest(store, controller.signal),
        fetchImpl,
        attempts: 3,
      }),
    ).rejects.toMatchObject({ code: 'download-failed' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('restarts from scratch after a digest mismatch', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(PAYLOAD), { status: 200 }));
    let hashes = 0;
    const hashBlob = vi.fn(async (blob: Blob) => {
      hashes += 1;
      if (hashes === 1) return 'f'.repeat(64);
      return sha256Hex(new Uint8Array(await blob.arrayBuffer()));
    });

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      fetchImpl,
      hashBlob,
      attempts: 2,
    });

    expect(result.sha256).toBe(sha256Hex(PAYLOAD));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.files.has(PART)).toBe(false);
  });

  it('reports verification progress separately from the download bytes', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const fetchImpl = async () => new Response(new Uint8Array(PAYLOAD), { status: 200 });
    const progress: DownloadProgress[] = [];

    await downloadModel({
      ...baseRequest(store, controller.signal),
      fetchImpl,
      onProgress: (event) => progress.push(event),
    });

    expect(progress.some((event) => event.phase === 'download' && event.received === 12)).toBe(
      true,
    );
    expect(progress.some((event) => event.phase === 'verify' && event.received === 12)).toBe(true);
  });
});
