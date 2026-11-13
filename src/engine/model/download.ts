import { abortError, EngineError, isAbortError, isEngineError } from '../errors';
import type { ModelFileStore } from './file-store';
import { sha256OfBlob, type HashOptions } from './sha256';

export interface DownloadSource {
  url: string;
  size: number;
  sha256: string;
}

export type DownloadPhase = 'download' | 'verify';

export interface DownloadProgress {
  received: number;
  total: number;
  ratio: number;
  resumedFrom: number;
  phase: DownloadPhase;
}

export interface DownloadRequest {
  source: DownloadSource;
  store: ModelFileStore;
  partPath: string;
  finalPath: string;
  signal: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  fetchImpl?: typeof fetch;
  hashBlob?: (blob: Blob, options?: HashOptions) => Promise<string>;
  attempts?: number;
  retryDelayMs?: number;
  /** Bytes per ranged request. Multi-megabyte blocks keep request overhead low. */
  segmentBytes?: number;
  /** Maximum number of ranged requests in flight. */
  concurrency?: number;
}

export interface DownloadResult {
  bytes: number;
  sha256: string;
  resumedFrom: number;
}

interface DownloadSegment {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

interface ContentRange {
  start: number;
  end: number;
  total: number | null;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 6;
// Four progress updates per second keep the UI smooth without flooding the offscreen channel.
const PROGRESS_INTERVAL_MS = 250;

/** A later ranged request was answered with 200, so ranges are not supported. */
class SegmentRangeIgnoredError extends Error {}

function progressOf(
  received: number,
  total: number,
  resumedFrom: number,
  phase: DownloadPhase,
): DownloadProgress {
  return {
    received,
    total,
    ratio: total > 0 ? Math.min(1, received / total) : 0,
    resumedFrom,
    phase,
  };
}

function emitProgress(request: DownloadRequest, progress: DownloadProgress): void {
  try {
    request.onProgress?.(progress);
  } catch {
    // Progress listeners are cosmetic and must not interrupt the transfer.
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, milliseconds);

    const handleAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

function segmentSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_SEGMENT_BYTES;
  return Math.floor(value);
}

function concurrencyOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_CONCURRENCY;
  return Math.floor(value);
}

function segmentsOf(start: number, end: number, size: number): DownloadSegment[] {
  const segments: DownloadSegment[] = [];
  for (let offset = start; offset < end; offset += size) {
    segments.push({ start: offset, end: Math.min(offset + size, end) });
  }
  return segments;
}

function parseContentRange(value: string | null): ContentRange | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/iu.exec(value.trim());
  if (!match) return null;

  const start = Number(match[1] ?? '');
  const end = Number(match[2] ?? '');
  const total = match[3] === '*' ? null : Number(match[3] ?? '');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (total !== null && !Number.isSafeInteger(total)) return null;
  return { start, end, total };
}

function validateSegment(response: Response, segment: DownloadSegment, size: number): void {
  const range = parseContentRange(response.headers.get('content-range'));
  if (!range) return;

  if (range.start !== segment.start) {
    throw new EngineError('download-failed', 'The server returned the wrong byte range.', {
      retryable: false,
    });
  }
  if (range.total !== null && range.total !== size) {
    throw new EngineError(
      'download-failed',
      `The server reported ${String(range.total)} bytes but the pinned size is ${String(size)}.`,
      { retryable: false },
    );
  }
}

function statusError(response: Response): EngineError {
  return new EngineError(
    'download-failed',
    `The model request failed with HTTP ${String(response.status)}.`,
    { retryable: response.status >= 500 },
  );
}

function progressReporter(
  request: DownloadRequest,
  resumedFrom: number,
): (received: number, force?: boolean) => void {
  let lastReportedAt = Date.now();
  let lastReportedBytes = resumedFrom;

  return (received: number, force = false): void => {
    const now = Date.now();
    if (!force) {
      if (now - lastReportedAt < PROGRESS_INTERVAL_MS) return;
      if (received === lastReportedBytes) return;
    }
    lastReportedAt = now;
    lastReportedBytes = received;
    emitProgress(request, progressOf(received, request.source.size, resumedFrom, 'download'));
  };
}

async function readSegment(
  response: Response,
  length: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    throw new EngineError('download-failed', 'The model response has no body.');
  }

  const reader = response.body.getReader();
  const data = new Uint8Array(length);
  let filled = 0;

  try {
    while (filled < length) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      if (filled + value.byteLength > length) {
        await reader.cancel().catch(() => undefined);
        throw new EngineError('download-failed', 'The model is larger than the pinned size.');
      }

      data.set(value, filled);
      filled += value.byteLength;
    }
  } finally {
    if (filled === length) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (filled !== length) {
    throw new EngineError(
      'download-failed',
      `A model segment stopped at ${String(filled)} of ${String(length)} bytes.`,
    );
  }

  return data;
}

async function transfer(request: DownloadRequest, fetchImpl: typeof fetch): Promise<number> {
  const { source, store, partPath, signal } = request;
  let offset = await store.size(partPath);

  if (offset > source.size) {
    await store.remove(partPath);
    offset = 0;
  }

  const resumedFrom = offset;
  emitProgress(request, progressOf(offset, source.size, resumedFrom, 'download'));

  if (offset === source.size) return resumedFrom;

  const firstEnd = Math.min(offset + segmentSize(request.segmentBytes), source.size);
  const response = await fetchImpl(source.url, {
    headers: { Range: `bytes=${String(offset)}-${String(firstEnd - 1)}` },
    signal,
    cache: 'no-store',
    redirect: 'follow',
  });

  if (response.status === 416) {
    await store.remove(partPath);
    throw new EngineError('download-failed', 'The server rejected the resume range.', {
      retryable: false,
    });
  }

  if (response.status === 200) {
    return transferSingle(request, response, offset, resumedFrom);
  }

  if (response.status !== 206) throw statusError(response);

  try {
    return await transferSegments(request, fetchImpl, response, offset, resumedFrom);
  } catch (error) {
    if (isAbortError(error) || signal.aborted) throw abortError();
    if (!(error instanceof SegmentRangeIgnoredError)) throw error;

    // One of the later segments came back as a full 200 body. Drop what the ranged workers
    // wrote and restart with the plain single-stream path, which is the safest fallback.
    await store.remove(partPath);
    emitProgress(request, progressOf(0, source.size, resumedFrom, 'download'));
    const fallback = await fetchImpl(source.url, {
      signal,
      cache: 'no-store',
      redirect: 'follow',
    });
    return transferSingle(request, fallback, 0, resumedFrom);
  }
}

async function transferSingle(
  request: DownloadRequest,
  response: Response,
  initialOffset: number,
  resumedFrom: number,
): Promise<number> {
  const { source, store, partPath, signal } = request;
  let offset = initialOffset;

  if (response.status === 416) {
    await store.remove(partPath);
    throw new EngineError('download-failed', 'The server rejected the resume range.', {
      retryable: false,
    });
  }

  if (response.status !== 200 && response.status !== 206) throw statusError(response);

  if (response.status === 200 && offset > 0) {
    await store.remove(partPath);
    offset = 0;
    emitProgress(request, progressOf(offset, source.size, resumedFrom, 'download'));
  }

  if (!response.body) {
    throw new EngineError('download-failed', 'The model response has no body.');
  }

  const reader = response.body.getReader();
  const writer = await store.createWriter(partPath, offset);
  const report = progressReporter(request, resumedFrom);
  let writerClosed = false;
  let received = offset;

  const closeWriter = async (): Promise<void> => {
    if (writerClosed) return;
    writerClosed = true;
    await writer.close().catch(() => undefined);
  };

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      if (received + value.byteLength > source.size) {
        await reader.cancel().catch(() => undefined);
        await closeWriter();
        await store.remove(partPath);
        throw new EngineError('download-failed', 'The model is larger than the pinned size.');
      }

      await writer.write(value);
      received += value.byteLength;
      report(received);
    }
  } finally {
    reader.releaseLock();
    await closeWriter();
  }

  report(received, true);

  if (received !== source.size) {
    throw new EngineError(
      'download-failed',
      `The model download stopped at ${String(received)} of ${String(source.size)} bytes.`,
    );
  }

  return resumedFrom;
}

async function transferSegments(
  request: DownloadRequest,
  fetchImpl: typeof fetch,
  firstResponse: Response,
  initialOffset: number,
  resumedFrom: number,
): Promise<number> {
  const { source, store, partPath, signal } = request;
  const attempts = Math.max(1, request.attempts ?? DEFAULT_ATTEMPTS);
  const retryDelay = Math.max(0, request.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const segments = segmentsOf(initialOffset, source.size, segmentSize(request.segmentBytes));
  const firstSegment = segments[0];
  if (!firstSegment) return resumedFrom;
  validateSegment(firstResponse, firstSegment, source.size);

  const resolvedUrl = firstResponse.url || source.url;
  const stop = new AbortController();
  const combined = AbortSignal.any([signal, stop.signal]);
  const writer = await store.createWriter(partPath, initialOffset);
  const report = progressReporter(request, resumedFrom);

  let received = initialOffset;
  let nextWrite = 0;
  const ready = new Map<number, Uint8Array>();
  let wakeWriter: (() => void) | null = null;
  const notifyWriter = (): void => {
    const wake = wakeWriter;
    wakeWriter = null;
    wake?.();
  };
  const waitForWriter = (): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        combined.removeEventListener('abort', done);
        if (wakeWriter === done) wakeWriter = null;
        resolve();
      };
      wakeWriter = done;
      combined.addEventListener('abort', done, { once: true });
    });

  const writerLoop = async (): Promise<void> => {
    while (nextWrite < segments.length) {
      throwIfAborted(combined);
      const block = ready.get(nextWrite);
      if (!block) {
        await waitForWriter();
        continue;
      }

      ready.delete(nextWrite);
      await writer.write(block);
      received += block.byteLength;
      nextWrite += 1;
      report(received);
    }
  };

  const fetchSegment = async (
    segment: DownloadSegment,
    first: Response | undefined,
  ): Promise<Uint8Array> => {
    let candidate = first;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      throwIfAborted(combined);
      let active: Response | undefined;

      try {
        const response =
          candidate ??
          (await fetchImpl(resolvedUrl, {
            headers: { Range: `bytes=${String(segment.start)}-${String(segment.end - 1)}` },
            signal: combined,
            cache: 'no-store',
            redirect: 'follow',
          }));
        candidate = undefined;
        active = response;

        if (response.status === 200) throw new SegmentRangeIgnoredError();
        if (response.status === 416) {
          throw new EngineError('download-failed', 'The server rejected the segment range.', {
            retryable: false,
          });
        }
        if (response.status !== 206) throw statusError(response);

        validateSegment(response, segment, source.size);
        const data = await readSegment(response, segment.end - segment.start, combined);
        active = undefined;
        return data;
      } catch (error) {
        if (!(error instanceof SegmentRangeIgnoredError)) {
          await active?.body?.cancel().catch(() => undefined);
        }
        if (isAbortError(error) || combined.aborted) throw abortError();
        if (error instanceof SegmentRangeIgnoredError) throw error;
        if (isEngineError(error) && !error.retryable) throw error;

        lastError = error;
        if (attempt === attempts) break;
        await delay(retryDelay * attempt, combined);
      }
    }

    if (isEngineError(lastError) && !lastError.retryable) throw lastError;
    throw new EngineError('download-failed', 'A model download segment failed.', {
      cause: lastError,
      retryable: false,
    });
  };

  let nextSegment = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      throwIfAborted(combined);
      const index = nextSegment;
      nextSegment += 1;
      const segment = segments[index];
      if (!segment) return;

      const data = await fetchSegment(segment, index === 0 ? firstResponse : undefined);
      throwIfAborted(combined);
      ready.set(index, data);
      notifyWriter();
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrencyOf(request.concurrency), segments.length) },
    () => worker(),
  );
  const tasks = [writerLoop(), ...workers];
  let failure: unknown;

  try {
    await Promise.all(tasks);
  } catch (error) {
    failure = error;
  }

  // Stop in-flight segment requests and let the ordered writer close its handle before the
  // caller either retries from the persisted prefix or falls back to a single stream.
  stop.abort();
  await Promise.allSettled(tasks);
  await writer.close().catch(() => undefined);

  if (failure) throw failure;
  report(received, true);

  if (received !== source.size) {
    throw new EngineError(
      'download-failed',
      `The model download stopped at ${String(received)} of ${String(source.size)} bytes.`,
    );
  }

  return resumedFrom;
}

/**
 * Downloads the model into `partPath` with HTTP Range resume, verifies the pinned digest and
 * moves the verified file to `finalPath`. A partial file survives cancellation so the next
 * call continues from its end.
 *
 * When the server supports ranges, the remaining bytes are fetched as parallel multi-megabyte
 * segments. Blocks are committed to OPFS in order so the `.part` file always ends at a real
 * contiguous prefix, which keeps resume correct even when a later segment finishes first.
 */
export async function downloadModel(request: DownloadRequest): Promise<DownloadResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const hashBlob = request.hashBlob ?? sha256OfBlob;
  const attempts = Math.max(1, request.attempts ?? DEFAULT_ATTEMPTS);
  const retryDelay = request.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastError: unknown;
  let integrityRetried = false;
  let lastVerifyAt = Date.now() - PROGRESS_INTERVAL_MS;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(request.signal);

    try {
      const resumedFrom = await transfer(request, fetchImpl);
      const blob = await request.store.read(request.partPath);
      const digest = await hashBlob(blob, {
        signal: request.signal,
        onProgress: (hashed, total) => {
          const now = Date.now();
          if (hashed < total && now - lastVerifyAt < PROGRESS_INTERVAL_MS) return;
          lastVerifyAt = now;
          emitProgress(request, progressOf(hashed, request.source.size, resumedFrom, 'verify'));
        },
      });
      throwIfAborted(request.signal);

      if (digest !== request.source.sha256) {
        await request.store.remove(request.partPath);
        throw new EngineError('model-integrity', 'The downloaded model failed its digest check.');
      }

      await request.store.move(request.partPath, request.finalPath);
      return { bytes: blob.size, sha256: digest, resumedFrom };
    } catch (error) {
      if (isAbortError(error) || request.signal.aborted) throw abortError();

      if (isEngineError(error) && error.code === 'model-integrity') {
        if (integrityRetried) throw error;
        integrityRetried = true;
        lastError = error;
        if (attempt === attempts) break;
        continue;
      }

      if (isEngineError(error) && !error.retryable) throw error;

      lastError = error;
      if (attempt === attempts) break;
      await delay(retryDelay * attempt, request.signal);
    }
  }

  if (isEngineError(lastError)) throw lastError;
  throw new EngineError('download-failed', 'The model download failed.', { cause: lastError });
}
