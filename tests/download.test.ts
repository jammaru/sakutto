import { describe, expect, it, vi } from 'vitest';
import { EngineError } from '@/engine/errors';
import { downloadModel, type DownloadProgress } from '@/engine/model/download';
import { sha256Hex } from '@/engine/model/sha256';
import { bytesOf, MemoryFileStore, streamOf } from './support/fakes';

const PAYLOAD = bytesOf('hello world!');
const PART = 'model.gguf.part';
const FINAL = 'model.gguf';

interface Range {
  start: number;
  /** Exclusive. */
  end: number;
}

function rangeOf(headers: unknown): Range {
  const record = headers as Record<string, string> | undefined;
  const match = /^bytes=(\d+)-(\d+)$/u.exec(record?.Range ?? '');
  if (!match) throw new Error(`Unexpected range: ${String(record?.Range)}`);
  return { start: Number(match[1]), end: Number(match[2]) + 1 };
}

function rangeResponse(bytes: Uint8Array, range: Range, url?: string): Response {
  const response = new Response(bytes.slice(range.start, range.end), {
    status: 206,
    headers: {
      'Content-Length': String(range.end - range.start),
      'Content-Range': `bytes ${String(range.start)}-${String(range.end - 1)}/${String(bytes.length)}`,
    },
  });
  if (url) Object.defineProperty(response, 'url', { value: url });
  return response;
}

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
    expect(headers.Range).toBe('bytes=0-11');
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
      expect(headers.Range).toBe('bytes=4-11');
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
    ).rejects.toThrow(/HTTP 404/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reports an HTTP 403 without retrying', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 403 }));

    await expect(
      downloadModel({
        ...baseRequest(store, controller.signal),
        fetchImpl,
        attempts: 3,
      }),
    ).rejects.toThrow(/HTTP 403/);
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

  it('splits the transfer into ranged segments and reuses the resolved CDN URL', async () => {
    const payload = bytesOf('abcdefghijklmnopqrstuvwxyz');
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const cdn = 'https://cdn.example.test/model.gguf';
    const ranges: Range[] = [];
    let first = true;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (first) {
        first = false;
        expect(url).toBe('https://example.test/model.gguf');
        return rangeResponse(payload, { start: 0, end: 8 }, cdn);
      }

      expect(url).toBe(cdn);
      const range = rangeOf(init?.headers);
      ranges.push(range);
      return rangeResponse(payload, range, cdn);
    });

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      source: sourceOf(payload),
      fetchImpl,
      segmentBytes: 8,
      concurrency: 2,
    });

    expect(result.resumedFrom).toBe(0);
    expect(ranges.sort((left, right) => left.start - right.start)).toEqual([
      { start: 8, end: 16 },
      { start: 16, end: 24 },
      { start: 24, end: 26 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(new TextDecoder().decode(store.files.get(FINAL))).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  it('keeps more than one ranged request in flight', async () => {
    const payload = bytesOf('0123456789abcdefghijklmnopqrstuv');
    const store = new MemoryFileStore();
    const controller = new AbortController();
    let first = true;
    let active = 0;
    let maxActive = 0;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const range = rangeOf(init?.headers);
      if (first) {
        first = false;
        return rangeResponse(payload, range);
      }

      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return rangeResponse(payload, range);
    };

    await downloadModel({
      ...baseRequest(store, controller.signal),
      source: sourceOf(payload),
      fetchImpl,
      segmentBytes: 4,
      concurrency: 3,
    });

    expect(maxActive).toBeGreaterThan(1);
    expect(new TextDecoder().decode(store.files.get(FINAL))).toBe(
      '0123456789abcdefghijklmnopqrstuv',
    );
  });

  it('retries one failed segment without restarting the completed ones', async () => {
    const payload = bytesOf('0123456789abcdef');
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const calls = new Map<string, number>();
    let failed = false;
    let first = true;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const range = rangeOf(init?.headers);
      const key = `${String(range.start)}-${String(range.end)}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);

      if (!first && range.start === 4 && !failed) {
        failed = true;
        throw new TypeError('network down');
      }

      first = false;
      return rangeResponse(payload, range);
    });

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      source: sourceOf(payload),
      fetchImpl,
      attempts: 2,
      retryDelayMs: 0,
      segmentBytes: 4,
      concurrency: 2,
    });

    expect(result.resumedFrom).toBe(0);
    expect(calls.get('0-4')).toBe(1);
    expect(calls.get('4-8')).toBe(2);
    expect(new TextDecoder().decode(store.files.get(FINAL))).toBe('0123456789abcdef');
  });

  it('falls back to the single stream when a later segment ignores Range', async () => {
    const payload = bytesOf('0123456789abcdef');
    const store = new MemoryFileStore();
    const controller = new AbortController();
    let first = true;
    let plainRequests = 0;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const headers = init?.headers as Record<string, string> | undefined;
      if (first) {
        first = false;
        return rangeResponse(payload, rangeOf(headers));
      }
      if (!headers?.Range) {
        plainRequests += 1;
        return new Response(new Uint8Array(payload), { status: 200 });
      }
      return new Response(new Uint8Array(payload), { status: 200 });
    };

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      source: sourceOf(payload),
      fetchImpl,
      segmentBytes: 4,
      concurrency: 2,
    });

    expect(result.resumedFrom).toBe(0);
    expect(plainRequests).toBe(1);
    expect(new TextDecoder().decode(store.files.get(FINAL))).toBe('0123456789abcdef');
  });

  it('keeps the contiguous prefix when a segmented download is aborted', async () => {
    const payload = bytesOf('0123456789abcdef');
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const originalCreateWriter = store.createWriter.bind(store);
    let writes = 0;
    let first = true;

    store.createWriter = async (path, offset) => {
      const writer = await originalCreateWriter(path, offset);
      return {
        write: async (chunk: Uint8Array) => {
          await writer.write(chunk);
          writes += 1;
          if (writes === 1) controller.abort();
        },
        close: () => writer.close(),
      };
    };

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const range = rangeOf(init?.headers);
      if (first) {
        first = false;
        return rangeResponse(payload, range);
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            init?.signal?.addEventListener('abort', () => {
              stream.error(new DOMException('Aborted', 'AbortError'));
            });
          },
        }),
        {
          status: 206,
          headers: {
            'Content-Range': `bytes ${String(range.start)}-${String(range.end - 1)}/${String(payload.length)}`,
          },
        },
      );
    };

    await expect(
      downloadModel({
        ...baseRequest(store, controller.signal),
        source: sourceOf(payload),
        fetchImpl,
        segmentBytes: 4,
        concurrency: 3,
      }),
    ).rejects.toMatchObject({ code: 'aborted' });

    expect(store.files.get(PART)?.length).toBe(4);
    expect(store.files.has(FINAL)).toBe(false);
  });
});
