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
}

export interface DownloadResult {
  bytes: number;
  sha256: string;
  resumedFrom: number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const PROGRESS_BYTES = 1024 * 1024;
const PROGRESS_INTERVAL_MS = 200;

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

  const headers: Record<string, string> = {};
  if (offset > 0) headers.Range = `bytes=${offset}-`;

  const response = await fetchImpl(source.url, {
    headers,
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

  if (response.status !== 200 && response.status !== 206) {
    throw new EngineError(
      'download-failed',
      `The model request failed with HTTP ${String(response.status)}.`,
      { retryable: response.status >= 500 },
    );
  }

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
  let writerClosed = false;
  let received = offset;
  let lastReportedAt = Date.now();
  let lastReportedBytes = offset;

  const closeWriter = async (): Promise<void> => {
    if (writerClosed) return;
    writerClosed = true;
    await writer.close().catch(() => undefined);
  };

  const report = (force: boolean): void => {
    const now = Date.now();
    if (
      !force &&
      received - lastReportedBytes < PROGRESS_BYTES &&
      now - lastReportedAt < PROGRESS_INTERVAL_MS
    ) {
      return;
    }
    lastReportedBytes = received;
    lastReportedAt = now;
    emitProgress(request, progressOf(received, source.size, resumedFrom, 'download'));
  };

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      if (received + value.byteLength > source.size) {
        await reader.cancel();
        await closeWriter();
        await store.remove(partPath);
        throw new EngineError('download-failed', 'The model is larger than the pinned size.');
      }

      await writer.write(value);
      received += value.byteLength;
      report(false);
    }
  } finally {
    reader.releaseLock();
    await closeWriter();
  }

  report(true);

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
 */
export async function downloadModel(request: DownloadRequest): Promise<DownloadResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const hashBlob = request.hashBlob ?? sha256OfBlob;
  const attempts = Math.max(1, request.attempts ?? DEFAULT_ATTEMPTS);
  const retryDelay = request.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastError: unknown;
  let integrityRetried = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(request.signal);

    try {
      const resumedFrom = await transfer(request, fetchImpl);
      const blob = await request.store.read(request.partPath);
      const digest = await hashBlob(blob, {
        signal: request.signal,
        onProgress: (hashed) => {
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
