import { abortError, EngineError, isAbortError } from '../errors';
import type { DownloadProgress, DownloadPhase } from './download';
import type { ModelFileStore } from './file-store';
import { sha256OfBlob, type HashOptions } from './sha256';

export const DEFAULT_COPY_CHUNK_BYTES = 1024 * 1024;

export interface CopyModelRequest {
  blob: Blob;
  store: ModelFileStore;
  partPath: string;
  finalPath: string;
  size: number;
  sha256: string;
  signal: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  hashBlob?: (blob: Blob, options?: HashOptions) => Promise<string>;
  chunkBytes?: number;
}

export interface CopyModelResult {
  bytes: number;
  sha256: string;
}

export const STALE_PART_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Per-operation temp name so concurrent profile copies do not share one `.part` file. */
export function uniquePartPath(partPath: string): string {
  const token = crypto.randomUUID();
  if (partPath.endsWith('.part')) {
    return `${partPath.slice(0, -'.part'.length)}.${token}.part`;
  }
  return `${partPath}.${token}.part`;
}

function progressOf(received: number, total: number, phase: DownloadPhase): DownloadProgress {
  return {
    received,
    total,
    ratio: total > 0 ? Math.min(1, received / total) : 0,
    resumedFrom: 0,
    phase,
  };
}

function emitProgress(request: CopyModelRequest, progress: DownloadProgress): void {
  try {
    request.onProgress?.(progress);
  } catch {
    // Progress listeners are cosmetic and must not interrupt the copy.
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

async function discardPart(store: ModelFileStore, partPath: string): Promise<void> {
  await store.remove(partPath).catch(() => undefined);
}

export interface ReuseVerifiedFinalRequest {
  store: ModelFileStore;
  partPath: string;
  finalPath: string;
  size: number;
  sha256: string;
  signal: AbortSignal;
  hashBlob?: (blob: Blob, options?: HashOptions) => Promise<string> | undefined;
}

/** Reuse a final file another operation already wrote, deleting only our own temp part. */
export async function reuseVerifiedFinal(
  request: ReuseVerifiedFinalRequest,
): Promise<CopyModelResult | null> {
  const { store, finalPath, size, sha256, signal } = request;
  const hashBlob = request.hashBlob ?? sha256OfBlob;
  const existingSize = await store.size(finalPath);
  if (existingSize !== size) return null;
  try {
    const blob = await store.read(finalPath);
    const digest = await hashBlob(blob, { signal });
    if (digest !== sha256) return null;
    await discardPart(store, request.partPath);
    return { bytes: size, sha256: digest };
  } catch {
    return null;
  }
}

/**
 * Streams an already-installed official GGUF into the primary store as a temp `.part`
 * file, verifies size and SHA-256, then renames it. Abort or a failed check deletes the
 * `.part` so a partial copy is never treated as valid. Callers delete the OPFS source
 * only after this returns.
 */
export async function copyModelFile(request: CopyModelRequest): Promise<CopyModelResult> {
  const chunkBytes = Math.max(1, request.chunkBytes ?? DEFAULT_COPY_CHUNK_BYTES);
  const hashBlob = request.hashBlob ?? sha256OfBlob;
  const { blob, store, partPath, finalPath, size, sha256, signal } = request;

  const reused = await reuseVerifiedFinal({ ...request, hashBlob });
  if (reused) return reused;

  await discardPart(store, partPath);

  const writer = await store.createWriter(partPath, 0);
  let writerClosed = false;
  let received = 0;

  const closeWriter = async (): Promise<void> => {
    if (writerClosed) return;
    writerClosed = true;
    await writer.close().catch(() => undefined);
  };

  try {
    throwIfAborted(signal);
    emitProgress(request, progressOf(0, size, 'download'));

    if (blob.size !== size) {
      throw new EngineError('model-integrity', 'The model copy is not the pinned size.', {
        retryable: false,
      });
    }

    for (let offset = 0; offset < blob.size; offset += chunkBytes) {
      throwIfAborted(signal);
      const slice = blob.slice(offset, Math.min(offset + chunkBytes, blob.size));
      const chunk = new Uint8Array(await slice.arrayBuffer());
      if (chunk.byteLength === 0) continue;
      await writer.write(chunk);
      received += chunk.byteLength;
      emitProgress(request, progressOf(received, size, 'download'));
      if (offset > 0) await Promise.resolve();
    }

    await closeWriter();
    throwIfAborted(signal);

    if (received !== size) {
      throw new EngineError(
        'download-failed',
        `The model copy stopped at ${String(received)} of ${String(size)} bytes.`,
      );
    }

    const copied = await store.read(partPath);
    if (copied.size !== size) {
      throw new EngineError('model-integrity', 'The model copy is not the pinned size.', {
        retryable: false,
      });
    }

    const digest = await hashBlob(copied, {
      signal,
      onProgress: (hashed) => {
        emitProgress(request, progressOf(hashed, size, 'verify'));
      },
    });
    throwIfAborted(signal);

    if (digest !== sha256) {
      throw new EngineError('model-integrity', 'The copied model failed its digest check.', {
        retryable: false,
      });
    }

    await store.move(partPath, finalPath);
    return { bytes: copied.size, sha256: digest };
  } catch (error) {
    await closeWriter();
    await discardPart(store, partPath);
    if (isAbortError(error) || signal.aborted) throw abortError();
    throw error;
  }
}
