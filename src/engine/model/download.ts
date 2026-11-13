import { abortError, EngineError, isAbortError, isEngineError } from '../errors';
import type { ModelFileStore } from './file-store';
import { createSha256, sha256OfBlob, type HashOptions, type Sha256Hasher } from './sha256';

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
/** Bytes per ranged request. Shared with the model manager and benchmark. */
export const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;
/** Maximum number of ranged requests in flight. Shared with the model manager and benchmark. */
export const DEFAULT_CONCURRENCY = 6;
// Four progress updates per second keep the UI smooth without flooding the offscreen channel.
const PROGRESS_INTERVAL_MS = 250;
// Reading the resumed .part prefix in small slices keeps peak memory bounded on multi-GB files.
const HASH_READ_BYTES = 4 * 1024 * 1024;

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

/**
 * Checks the Content-Range on a 206. Returns how many bytes the response actually carries.
 * Some CDNs legitimately answer with a shorter range than requested, so the caller keeps the
 * prefix and requests the remainder instead of failing the whole download as non-retryable.
 */
function validateSegment(response: Response, segment: DownloadSegment, size: number): number {
  const range = parseContentRange(response.headers.get('content-range'));
  if (!range) return segment.end - segment.start;

  if (range.start !== segment.start) {
    throw new EngineError('download-failed', 'The server returned the wrong byte range.', {
      retryable: false,
    });
  }
  if (range.end < range.start || range.end > segment.end - 1) {
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
  return range.end - range.start + 1;
}

interface SharedRefreshResponse {
  url: string;
  response: Response;
  owner: number;
}

/**
 * A refresh is shared by all workers. Only its owner may read the fetched body; every other
 * caller has to cancel its unused view so the connection is not held open while it retries
 * against the refreshed URL.
 */
export async function takeSharedRefreshResponse(
  refresh: SharedRefreshResponse,
  index: number,
): Promise<Response | null> {
  if (refresh.owner === index) return refresh.response;
  await refresh.response.body?.cancel().catch(() => undefined);
  return null;
}

async function hashPartPrefix(
  request: DownloadRequest,
  length: number,
  hasher: Sha256Hasher,
): Promise<void> {
  const blob = await request.store.read(request.partPath);
  const size = Math.min(length, blob.size);
  let hashed = 0;
  let lastReportedAt = Date.now() - PROGRESS_INTERVAL_MS;

  while (hashed < size) {
    throwIfAborted(request.signal);
    const end = Math.min(hashed + HASH_READ_BYTES, size);
    hasher.update(new Uint8Array(await blob.slice(hashed, end).arrayBuffer()));
    hashed = end;

    const now = Date.now();
    if (hashed < size && now - lastReportedAt < PROGRESS_INTERVAL_MS) continue;
    lastReportedAt = now;
    emitProgress(request, progressOf(hashed, request.source.size, length, 'verify'));
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
  progressFloor = resumedFrom,
): (received: number, force?: boolean) => void {
  let lastReportedAt = Date.now();
  let lastReportedBytes = progressFloor;

  return (received: number, force = false): void => {
    const shown = Math.max(received, progressFloor);
    const now = Date.now();
    if (!force) {
      if (now - lastReportedAt < PROGRESS_INTERVAL_MS) return;
      if (shown === lastReportedBytes) return;
    }
    lastReportedAt = now;
    lastReportedBytes = shown;
    emitProgress(request, progressOf(shown, request.source.size, resumedFrom, 'download'));
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
  const cancelReader = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) cancelReader();
  else signal.addEventListener('abort', cancelReader, { once: true });

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
    signal.removeEventListener('abort', cancelReader);
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

async function transfer(
  request: DownloadRequest,
  fetchImpl: typeof fetch,
  hasher: Sha256Hasher | null,
): Promise<number> {
  const { source, store, partPath, signal } = request;
  let offset = await store.size(partPath);

  if (offset > source.size) {
    await store.remove(partPath);
    offset = 0;
  }

  const resumedFrom = offset;
  emitProgress(request, progressOf(offset, source.size, resumedFrom, 'download'));

  if (offset > 0 && hasher) {
    await hashPartPrefix(request, offset, hasher);
    // Switch the UI back to the transfer as soon as the prefix is hashed. The bytes shown do
    // not rewind: the download continues from the same offset.
    emitProgress(request, progressOf(offset, source.size, resumedFrom, 'download'));
  }

  if (offset === source.size) return resumedFrom;

  const firstEnd = Math.min(offset + segmentSize(request.segmentBytes), source.size);
  const stop = new AbortController();
  const combined = AbortSignal.any([signal, stop.signal]);
  const response = await fetchImpl(source.url, {
    headers: { Range: `bytes=${String(offset)}-${String(firstEnd - 1)}` },
    signal: combined,
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
    return transferSingle(request, response, offset, resumedFrom, false, resumedFrom, hasher);
  }

  if (response.status !== 206) throw statusError(response);

  try {
    return await transferSegments(
      request,
      fetchImpl,
      response,
      offset,
      resumedFrom,
      stop,
      combined,
      hasher,
    );
  } catch (error) {
    if (isAbortError(error) || signal.aborted) throw abortError();
    if (!(error instanceof SegmentRangeIgnoredError)) throw error;

    // One of the later segments came back as a full 200 body. Keep the already valid prefix
    // while the plain single-stream path overwrites it from the start, so progress does not
    // rewind and an interrupted fallback can still resume.
    const fallback = await fetchImpl(source.url, {
      signal,
      cache: 'no-store',
      redirect: 'follow',
    });
    const preserved = await store.size(partPath);
    // The single stream starts at byte 0 again, so discard the partial prefix digest.
    hasher?.reset();
    return transferSingle(
      request,
      fallback,
      0,
      resumedFrom,
      true,
      Math.max(resumedFrom, preserved),
      hasher,
    );
  }
}

async function transferSingle(
  request: DownloadRequest,
  response: Response,
  initialOffset: number,
  resumedFrom: number,
  preserveExisting = false,
  progressFloor = resumedFrom,
  hasher: Sha256Hasher | null = null,
): Promise<number> {
  const { source, store, partPath, signal } = request;
  let offset = initialOffset;
  let keepExistingData = preserveExisting;

  if (response.status === 416) {
    await store.remove(partPath);
    throw new EngineError('download-failed', 'The server rejected the resume range.', {
      retryable: false,
    });
  }

  if (response.status !== 200 && response.status !== 206) throw statusError(response);

  if (response.status === 200 && offset > 0) {
    // The server ignored Range and sent the whole file. Overwrite from the start but keep the
    // old valid bytes behind the new prefix, so a cancel or retry does not lose the resume point.
    offset = 0;
    keepExistingData = true;
    hasher?.reset();
  }

  if (!response.body) {
    throw new EngineError('download-failed', 'The model response has no body.');
  }

  const reader = response.body.getReader();
  const writer = await store.createWriter(
    partPath,
    offset,
    keepExistingData ? { keepExistingData: true } : undefined,
  );
  const report = progressReporter(request, resumedFrom, progressFloor);
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
      hasher?.update(value);
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
  stop: AbortController,
  combined: AbortSignal,
  hasher: Sha256Hasher | null,
): Promise<number> {
  const { source, store, partPath } = request;
  const attempts = Math.max(1, request.attempts ?? DEFAULT_ATTEMPTS);
  const retryDelay = Math.max(0, request.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const segments = segmentsOf(initialOffset, source.size, segmentSize(request.segmentBytes));
  const firstSegment = segments[0];
  if (!firstSegment) return resumedFrom;

  let resolvedUrl = firstResponse.url || source.url;
  let refreshedUrl = false;
  let refreshTask: Promise<{ url: string; response: Response; owner: number }> | null = null;

  const writer = await store.createWriter(partPath, initialOffset);
  const report = progressReporter(request, resumedFrom);
  const maxBuffered = concurrencyOf(request.concurrency);

  let buffered = 0;
  let received = initialOffset;
  let nextWrite = 0;
  const ready = new Map<number, Uint8Array>();
  const slotWaiters = new Set<() => void>();
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
  const wakeSlotWaiters = (): void => {
    for (const wake of [...slotWaiters]) wake();
  };
  const releaseSlot = (wake = true): void => {
    if (buffered > 0) buffered -= 1;
    if (wake) wakeSlotWaiters();
  };
  const acquireSlot = async (): Promise<void> => {
    while (buffered >= maxBuffered) {
      throwIfAborted(combined);
      await new Promise<void>((resolve) => {
        const done = (): void => {
          slotWaiters.delete(done);
          combined.removeEventListener('abort', done);
          resolve();
        };
        slotWaiters.add(done);
        combined.addEventListener('abort', done, { once: true });
      });
    }
    throwIfAborted(combined);
    buffered += 1;
  };

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
      hasher?.update(block);
      received += block.byteLength;
      nextWrite += 1;
      releaseSlot();
      report(received);
    }
  };

  const refreshResolvedUrl = (
    owner: number,
    segment: DownloadSegment,
  ): Promise<SharedRefreshResponse> => {
    if (!refreshTask) {
      refreshedUrl = true;
      refreshTask = (async () => {
        const response = await fetchImpl(source.url, {
          headers: { Range: `bytes=${String(segment.start)}-${String(segment.end - 1)}` },
          signal: combined,
          cache: 'no-store',
          redirect: 'follow',
        });

        if (response.status === 200) {
          await response.body?.cancel().catch(() => undefined);
          throw new SegmentRangeIgnoredError();
        }
        if (response.status === 416) {
          throw new EngineError('download-failed', 'The server rejected the segment range.', {
            retryable: false,
          });
        }
        if (response.status !== 206) throw statusError(response);

        validateSegment(response, segment, source.size);
        return { url: response.url || source.url, response, owner };
      })();
    }
    return refreshTask;
  };

  const fetchSegment = async (
    index: number,
    segment: DownloadSegment,
    first: Response | undefined,
  ): Promise<Uint8Array> => {
    const data = new Uint8Array(segment.end - segment.start);
    let filled = 0;
    let candidate = first;
    let lastError: unknown;
    let attempt = 1;

    while (attempt <= attempts) {
      throwIfAborted(combined);
      let active: Response | undefined;

      try {
        while (filled < data.length) {
          throwIfAborted(combined);
          const start = segment.start + filled;
          const end = segment.end;
          const requestedUrl = resolvedUrl;
          let response =
            candidate ??
            (await fetchImpl(requestedUrl, {
              headers: { Range: `bytes=${String(start)}-${String(end - 1)}` },
              signal: combined,
              cache: 'no-store',
              redirect: 'follow',
            }));
          candidate = undefined;
          active = response;

          if (response.status === 401 || response.status === 403 || response.status === 410) {
            await response.body?.cancel().catch(() => undefined);
            active = undefined;

            if (!refreshedUrl) {
              const refresh = await refreshResolvedUrl(index, { start, end });
              resolvedUrl = refresh.url;
              const owned = await takeSharedRefreshResponse(refresh, index);
              if (!owned) continue;

              response = owned;
              active = response;
            } else {
              // A sibling already refreshed the URL. Requests sent with the stale URL may retry
              // once against the new one; a request that already used the new URL gives up.
              if (refreshTask) resolvedUrl = (await refreshTask).url;
              if (requestedUrl !== resolvedUrl) continue;
              throw statusError(response);
            }
          }

          if (response.status === 200) throw new SegmentRangeIgnoredError();
          if (response.status === 416) {
            throw new EngineError('download-failed', 'The server rejected the segment range.', {
              retryable: false,
            });
          }
          if (response.status !== 206) throw statusError(response);

          const length = validateSegment(response, { start, end }, source.size);
          const piece = await readSegment(response, length, combined);
          active = undefined;
          data.set(piece, filled);
          filled += piece.length;
        }
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
        attempt += 1;
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
      await acquireSlot();

      const index = nextSegment;
      nextSegment += 1;
      const segment = segments[index];
      if (!segment) {
        releaseSlot();
        return;
      }

      try {
        const data = await fetchSegment(index, segment, index === 0 ? firstResponse : undefined);
        throwIfAborted(combined);
        ready.set(index, data);
        notifyWriter();
      } catch (error) {
        releaseSlot(false);
        throw error;
      }
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
 * The same ordered write also feeds the streaming digest. A resumed `.part` prefix is hashed
 * before the transfer continues, so completing a download never needs a second full-file pass.
 */
export async function downloadModel(request: DownloadRequest): Promise<DownloadResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const customHash = request.hashBlob;
  const attempts = Math.max(1, request.attempts ?? DEFAULT_ATTEMPTS);
  const retryDelay = request.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastError: unknown;
  let integrityRetried = false;
  let lastVerifyAt = Date.now() - PROGRESS_INTERVAL_MS;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(request.signal);

    try {
      // The normal path hashes while the ordered writer commits blocks, so the final digest
      // needs no second pass over a multi-GB file. An injected `hashBlob` keeps the old
      // end-of-download behaviour for callers and tests that need a custom verifier.
      const hasher = customHash ? null : await createSha256();
      const resumedFrom = await transfer(request, fetchImpl, hasher);
      let digest: string;
      let bytes: number;

      if (hasher) {
        digest = hasher.hex();
        bytes = request.source.size;
        emitProgress(request, progressOf(bytes, request.source.size, resumedFrom, 'verify'));
      } else {
        const blob = await request.store.read(request.partPath);
        digest = await (customHash ?? sha256OfBlob)(blob, {
          signal: request.signal,
          onProgress: (hashed, total) => {
            const now = Date.now();
            if (hashed < total && now - lastVerifyAt < PROGRESS_INTERVAL_MS) return;
            lastVerifyAt = now;
            emitProgress(request, progressOf(hashed, request.source.size, resumedFrom, 'verify'));
          },
        });
        bytes = blob.size;
      }
      throwIfAborted(request.signal);

      if (digest !== request.source.sha256) {
        await request.store.remove(request.partPath);
        throw new EngineError('model-integrity', 'The downloaded model failed its digest check.');
      }

      await request.store.move(request.partPath, request.finalPath);
      return { bytes, sha256: digest, resumedFrom };
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
