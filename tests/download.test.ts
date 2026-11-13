import { describe, expect, it, vi } from 'vitest';
import { EngineError } from '@/engine/errors';
import { downloadModel, type DownloadProgress } from '@/engine/model/download';
import {
  createHasherWorker,
  type HasherWorkerRequest,
  type HasherWorkerResponse,
} from '@/engine/model/sha256-worker-core';
import { sha256Hex } from '@/engine/model/sha256';
import { advanceModelStatus } from '@/shared/model-progress';
import type { ModelStatus } from '@/shared/engine-status';
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

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('The download did not settle promptly.')),
      milliseconds,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

/**
 * A loopback hashing worker with browser-like transfer semantics: cloning with a transfer list
 * detaches the sender's ArrayBuffers, so later reads of the original view report zero bytes.
 */
class TransferringWorker {
  onmessage: ((event: MessageEvent<HasherWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  transfers = 0;
  private readonly handle = createHasherWorker({
    postMessage: (message: HasherWorkerResponse) => {
      queueMicrotask(() =>
        this.onmessage?.({ data: message } as MessageEvent<HasherWorkerResponse>),
      );
    },
  });

  postMessage(message: HasherWorkerRequest, transfer?: Transferable[]): void {
    const delivered = transfer ? structuredClone(message, { transfer }) : structuredClone(message);
    if (transfer && transfer.length > 0) this.transfers += 1;
    queueMicrotask(() => this.handle(delivered));
  }

  terminate(): void {}
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
      return new Response(streamOf([PAYLOAD.slice(4)]), {
        status: 206,
        headers: {
          'Content-Length': String(PAYLOAD.length - 4),
          'Content-Range': `bytes 4-${String(PAYLOAD.length - 1)}/${String(PAYLOAD.length)}`,
        },
      });
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

  it('restarts when the server ignores the range header without rewinding progress', async () => {
    const store = new MemoryFileStore();
    await store.append(PART, bytesOf('XXXXXXXX'), 0);
    const controller = new AbortController();
    const progress: DownloadProgress[] = [];

    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(PAYLOAD), { status: 200 }));

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      fetchImpl,
      onProgress: (event) => progress.push(event),
    });

    expect(result.resumedFrom).toBe(8);
    expect(new TextDecoder().decode(store.files.get(FINAL))).toBe('hello world!');
    expect(progress.every((event) => event.phase !== 'download' || event.received >= 8)).toBe(true);
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
      return new Response(streamOf([PAYLOAD.slice(4)]), {
        status: 206,
        headers: {
          'Content-Length': String(PAYLOAD.length - 4),
          'Content-Range': `bytes 4-${String(PAYLOAD.length - 1)}/${String(PAYLOAD.length)}`,
        },
      });
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

  it.each([5, 17, 33])('resumes from an unaligned .part offset of %i bytes', async (offset) => {
    const payload = Uint8Array.from({ length: 80 }, (_value, index) => index);
    const store = new MemoryFileStore();
    await store.append(PART, payload.slice(0, offset), 0);
    const controller = new AbortController();
    const ranges: Range[] = [];

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const range = rangeOf(init?.headers);
      ranges.push(range);
      return rangeResponse(payload, range);
    };

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      source: sourceOf(payload),
      fetchImpl,
      segmentBytes: 16,
      concurrency: 2,
    });

    expect(result.resumedFrom).toBe(offset);
    expect(ranges[0]?.start).toBe(offset);
    expect(store.files.get(FINAL)).toEqual(payload);
  });

  it('rejects a segment that starts at the wrong offset', async () => {
    const payload = bytesOf('0123456789abcdef');
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      async () =>
        new Response(payload.slice(0, 8), {
          status: 206,
          headers: {
            'Content-Length': '8',
            'Content-Range': `bytes 1-8/${String(payload.length)}`,
          },
        }),
    );

    await expect(
      downloadModel({
        ...baseRequest(store, controller.signal),
        source: sourceOf(payload),
        fetchImpl,
        segmentBytes: 8,
        concurrency: 1,
      }),
    ).rejects.toThrow(/wrong byte range/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('accepts a shorter legal Content-Range and fetches the remainder', async () => {
    const payload = bytesOf('0123456789abcdef');
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const ranges: Range[] = [];
    let first = true;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const range = rangeOf(init?.headers);
      ranges.push(range);
      if (first) {
        first = false;
        return new Response(payload.slice(0, 5), {
          status: 206,
          headers: {
            'Content-Length': '5',
            'Content-Range': `bytes 0-4/${String(payload.length)}`,
          },
        });
      }
      return rangeResponse(payload, range);
    };

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      source: sourceOf(payload),
      fetchImpl,
      segmentBytes: 8,
      concurrency: 2,
    });

    expect(result.resumedFrom).toBe(0);
    expect(ranges).toContainEqual({ start: 5, end: 8 });
    expect(store.files.get(FINAL)).toEqual(payload);
  });

  it('retries the remainder of a legally short range', async () => {
    const payload = bytesOf('0123456789abcdef');
    const store = new MemoryFileStore();
    const controller = new AbortController();
    let first = true;
    let remainderAttempts = 0;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const range = rangeOf(init?.headers);
      if (first) {
        first = false;
        return new Response(payload.slice(0, 5), {
          status: 206,
          headers: {
            'Content-Length': '5',
            'Content-Range': `bytes 0-4/${String(payload.length)}`,
          },
        });
      }
      if (range.start === 5) {
        remainderAttempts += 1;
        if (remainderAttempts === 1) throw new TypeError('network down');
      }
      return rangeResponse(payload, range);
    };

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      source: sourceOf(payload),
      fetchImpl,
      attempts: 2,
      retryDelayMs: 0,
      segmentBytes: 8,
      concurrency: 1,
    });

    expect(result.resumedFrom).toBe(0);
    expect(remainderAttempts).toBe(2);
    expect(store.files.get(FINAL)).toEqual(payload);
  });

  it('stops a segment that keeps answering with one-byte ranges', async () => {
    const payload = bytesOf('0123456789abcdef');
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const range = rangeOf(init?.headers);
      return new Response(payload.slice(range.start, range.start + 1), {
        status: 206,
        headers: {
          'Content-Length': '1',
          'Content-Range': `bytes ${String(range.start)}-${String(range.start)}/${String(payload.length)}`,
        },
      });
    });

    await expect(
      downloadModel({
        ...baseRequest(store, controller.signal),
        source: sourceOf(payload),
        fetchImpl,
        attempts: 1,
        retryDelayMs: 0,
        segmentBytes: 16,
        concurrency: 1,
      }),
    ).rejects.toThrow(/shorter byte ranges/);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
  });

  it('rejects a partial response without Content-Range or Content-Length', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      async () => new Response(streamOf([PAYLOAD.slice(4)]), { status: 206 }),
    );

    await expect(
      downloadModel({
        ...baseRequest(store, controller.signal),
        fetchImpl,
        attempts: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/Content-Range or Content-Length/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('keeps resumed bytes monotonic without a verifying-to-downloading flip', async () => {
    const store = new MemoryFileStore();
    await store.append(PART, PAYLOAD.slice(0, 4), 0);
    const controller = new AbortController();
    const progress: DownloadProgress[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const range = rangeOf(init?.headers);
      return rangeResponse(PAYLOAD, range);
    };

    await downloadModel({
      ...baseRequest(store, controller.signal),
      fetchImpl,
      onProgress: (event) => progress.push(event),
    });

    const statuses: ModelStatus[] = [];
    let previous: ModelStatus | null = null;
    for (const event of progress) {
      previous = advanceModelStatus(previous, {
        id: 'plamo-3-translate-0.8b-q4_k_m',
        state: event.phase === 'verify' ? 'verifying' : 'downloading',
        received: event.received,
        total: event.total,
        progress: event.ratio,
      });
      statuses.push(previous);
    }

    expect(statuses.some((status) => status.state === 'verifying')).toBe(true);
    for (let index = 1; index < statuses.length; index += 1) {
      expect(statuses[index]?.received ?? 0).toBeGreaterThanOrEqual(
        statuses[index - 1]?.received ?? 0,
      );
      if (statuses[index - 1]?.state === 'verifying') {
        expect(statuses[index]?.state).not.toBe('downloading');
      }
    }
  });

  it('hashes the existing partial prefix when resuming and avoids a second read', async () => {
    const store = new MemoryFileStore();
    await store.append(PART, PAYLOAD.slice(0, 4), 0);
    const controller = new AbortController();
    const progress: DownloadProgress[] = [];
    const read = vi.spyOn(store, 'read');
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const range = rangeOf(init?.headers);
      return rangeResponse(PAYLOAD, range);
    };

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      fetchImpl,
      onProgress: (event) => progress.push(event),
    });

    expect(result).toMatchObject({ resumedFrom: 4, sha256: sha256Hex(PAYLOAD) });
    expect(progress[0]).toMatchObject({ phase: 'download', received: 4 });
    const firstVerify = progress.findIndex((event) => event.phase === 'verify');
    expect(progress.slice(0, firstVerify).every((event) => event.phase === 'download')).toBe(true);
    expect(progress[firstVerify]).toMatchObject({ received: PAYLOAD.length });
    expect(read).toHaveBeenCalledOnce();
    expect(store.files.get(FINAL)).toEqual(PAYLOAD);
  });

  it('verifies during the transfer without reading the finished file again', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const read = vi.spyOn(store, 'read');
    const fetchImpl = async () => new Response(new Uint8Array(PAYLOAD), { status: 200 });

    const result = await downloadModel({ ...baseRequest(store, controller.signal), fetchImpl });

    expect(result.sha256).toBe(sha256Hex(PAYLOAD));
    expect(read).not.toHaveBeenCalled();
  });

  it('re-resolves the CDN URL once when several segments expire together', async () => {
    const payload = Uint8Array.from({ length: 40 }, (_value, index) => index);
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const sourceUrl = 'https://example.test/model.gguf';
    const oldCdn = 'https://cdn.example.test/expired/model.gguf';
    const newCdn = 'https://cdn.example.test/fresh/model.gguf';
    const sourceCalls: Range[] = [];
    let refreshCancelled = false;
    let oldCalls = 0;
    let newCalls = 0;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const range = rangeOf(init?.headers);

      if (url === sourceUrl) {
        sourceCalls.push(range);
        if (range.start === 0) return rangeResponse(payload, range, oldCdn);
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(payload.slice(range.start, range.end));
          },
          cancel() {
            refreshCancelled = true;
          },
        });
        const response = new Response(body, {
          status: 206,
          headers: {
            'Content-Length': String(range.end - range.start),
            'Content-Range': `bytes ${String(range.start)}-${String(range.end - 1)}/${String(payload.length)}`,
          },
        });
        Object.defineProperty(response, 'url', { value: newCdn });
        return response;
      }
      if (url === oldCdn) {
        oldCalls += 1;
        return new Response(null, { status: 403 });
      }
      if (url === newCdn) {
        newCalls += 1;
        return rangeResponse(payload, range, newCdn);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      source: { ...sourceOf(payload), url: sourceUrl },
      fetchImpl,
      attempts: 1,
      retryDelayMs: 0,
      segmentBytes: 8,
      concurrency: 5,
    });

    expect(result.sha256).toBe(sha256Hex(payload));
    expect(result.resumedFrom).toBe(0);
    expect(sourceCalls).toHaveLength(2);
    expect(refreshCancelled).toBe(true);
    expect(oldCalls).toBeGreaterThan(1);
    expect(newCalls).toBe(4);
    expect(store.files.get(FINAL)).toEqual(payload);
  });

  it('refreshes an expired CDN URL once and completes the remaining segments', async () => {
    const payload = Uint8Array.from({ length: 24 }, (_value, index) => index);
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const sourceUrl = 'https://example.test/model.gguf';
    const oldCdn = 'https://cdn.example.test/expired/model.gguf';
    const newCdn = 'https://cdn.example.test/fresh/model.gguf';
    const sourceCalls: Range[] = [];
    let oldCalls = 0;
    let newCalls = 0;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const range = rangeOf(init?.headers);

      if (url === sourceUrl) {
        sourceCalls.push(range);
        if (range.start === 0) return rangeResponse(payload, range, oldCdn);
        return rangeResponse(payload, range, newCdn);
      }
      if (url === oldCdn) {
        oldCalls += 1;
        return new Response(null, { status: 403 });
      }
      if (url === newCdn) {
        newCalls += 1;
        return rangeResponse(payload, range, newCdn);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      source: { ...sourceOf(payload), url: sourceUrl },
      fetchImpl,
      attempts: 1,
      retryDelayMs: 0,
      segmentBytes: 8,
      concurrency: 3,
    });

    expect(result.resumedFrom).toBe(0);
    expect(sourceCalls).toHaveLength(2);
    expect(oldCalls).toBe(2);
    expect(newCalls).toBe(2);
    expect(store.files.get(FINAL)).toEqual(payload);
  });

  it('gives up after the refreshed CDN URL also rejects the range', async () => {
    const payload = Uint8Array.from({ length: 24 }, (_value, index) => index);
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const sourceUrl = 'https://example.test/model.gguf';
    const oldCdn = 'https://cdn.example.test/expired/model.gguf';
    const newCdn = 'https://cdn.example.test/still-expired/model.gguf';
    let sourceCalls = 0;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const range = rangeOf(init?.headers);
      if (url === sourceUrl) {
        sourceCalls += 1;
        return rangeResponse(payload, range, range.start === 0 ? oldCdn : newCdn);
      }
      if (url === oldCdn || url === newCdn) return new Response(null, { status: 403 });
      throw new Error(`Unexpected URL: ${url}`);
    };

    const promise = downloadModel({
      ...baseRequest(store, controller.signal),
      source: { ...sourceOf(payload), url: sourceUrl },
      fetchImpl,
      attempts: 1,
      retryDelayMs: 0,
      segmentBytes: 8,
      concurrency: 3,
    });

    await expect(within(promise, 1_000)).rejects.toMatchObject({ code: 'download-failed' });
    expect(sourceCalls).toBe(2);
  });

  it('fails promptly when the first segment stalls and another exhausts retries', async () => {
    const payload = bytesOf('0123456789abcdef');
    const store = new MemoryFileStore();
    const controller = new AbortController();
    let first = true;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const range = rangeOf(init?.headers);
      if (first) {
        first = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // The first segment never finishes on its own.
            },
          }),
          {
            status: 206,
            headers: {
              'Content-Range': `bytes ${String(range.start)}-${String(range.end - 1)}/${String(payload.length)}`,
            },
          },
        );
      }
      throw new TypeError('network down');
    });

    const promise = downloadModel({
      ...baseRequest(store, controller.signal),
      source: sourceOf(payload),
      fetchImpl,
      attempts: 2,
      retryDelayMs: 0,
      segmentBytes: 4,
      concurrency: 2,
    });

    await expect(within(promise, 1_000)).rejects.toMatchObject({ code: 'download-failed' });
  });

  it('bounds buffered segments while the first block is stalled', async () => {
    const payload = Uint8Array.from({ length: 60 }, (_value, index) => index);
    const store = new MemoryFileStore();
    const controller = new AbortController();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetched = new Set<number>();
    const laterRanges: Range[] = [];
    let first = true;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const range = rangeOf(init?.headers);
      if (first) {
        first = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              void firstGate.then(() => {
                stream.enqueue(payload.slice(range.start, range.end));
                stream.close();
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
      }

      fetched.add(range.start);
      laterRanges.push(range);
      return rangeResponse(payload, range);
    };

    const promise = downloadModel({
      ...baseRequest(store, controller.signal),
      source: sourceOf(payload),
      fetchImpl,
      segmentBytes: 4,
      concurrency: 3,
    });

    await vi.waitFor(() => {
      expect(fetched.size).toBeGreaterThanOrEqual(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(laterRanges).toHaveLength(2);

    releaseFirst();
    await expect(promise).resolves.toMatchObject({ resumedFrom: 0 });
    expect(store.files.get(FINAL)).toEqual(payload);
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

  it('counts a 200 stream after the hashing worker detaches every chunk', async () => {
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const worker = new TransferringWorker();
    const workerFactory = vi.fn(() => worker);
    const fetchImpl = vi.fn(
      async () => new Response(streamOf([PAYLOAD.slice(0, 5), PAYLOAD.slice(5)]), { status: 200 }),
    );

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      fetchImpl,
      workerFactory,
    });

    expect(workerFactory).toHaveBeenCalledOnce();
    expect(worker.transfers).toBe(2);
    expect(result).toEqual({
      bytes: PAYLOAD.length,
      sha256: sha256Hex(PAYLOAD),
      resumedFrom: 0,
    });
    expect(store.files.get(FINAL)).toEqual(PAYLOAD);
  });

  it('counts 206 segment blocks after the hashing worker detaches every block', async () => {
    const payload = Uint8Array.from({ length: 30 }, (_value, index) => index);
    const store = new MemoryFileStore();
    const controller = new AbortController();
    const worker = new TransferringWorker();
    const workerFactory = vi.fn(() => worker);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      return rangeResponse(payload, rangeOf(init?.headers));
    });

    const result = await downloadModel({
      ...baseRequest(store, controller.signal),
      source: sourceOf(payload),
      fetchImpl,
      segmentBytes: 8,
      concurrency: 3,
      workerFactory,
    });

    expect(workerFactory).toHaveBeenCalledOnce();
    expect(worker.transfers).toBe(4);
    expect(result).toEqual({
      bytes: payload.length,
      sha256: sha256Hex(payload),
      resumedFrom: 0,
    });
    expect(store.files.get(FINAL)).toEqual(payload);
  });
});
