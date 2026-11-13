import { abortError, EngineError, isAbortError } from '../errors';
import { getModel, type ModelEntry, type ModelId } from './catalog';
import type { ModelFileStore } from './file-store';
import { createSha256, type HashOptions } from './sha256';

export const MODEL_IMPORT_SIZE_ERROR = 'import-size';
export const MODEL_IMPORT_DIGEST_ERROR = 'import-digest';
export const DEFAULT_IMPORT_CHUNK_BYTES = 1024 * 1024;

export type ModelTransferPhase = 'copy' | 'verify';

export interface ModelTransferProgress {
  phase: ModelTransferPhase;
  received: number;
  total: number;
  ratio: number;
}

export interface ImportModelFileRequest {
  file: Blob;
  modelId: ModelId;
  store: ModelFileStore;
  signal: AbortSignal;
  /** Unit tests use a small pinned entry instead of the real catalog. */
  entry?: Pick<ModelEntry, 'size' | 'sha256' | 'commit' | 'file'>;
  onProgress?: (progress: ModelTransferProgress) => void;
  /** Tests can force a digest without hashing the fake bytes. */
  hashBlob?: (blob: Blob, options?: HashOptions) => Promise<string>;
  chunkBytes?: number;
}

export interface ImportModelFileResult {
  bytes: number;
  sha256: string;
}

const TEXT_ENCODER = new TextEncoder();

function modelDirectory(modelId: ModelId): string {
  return `models/${modelId}`;
}

function finalPath(modelId: ModelId): string {
  return `${modelDirectory(modelId)}/model.gguf`;
}

/** Manager-compatible install path, exposed for the settings import/export surface. */
export function modelInstallPath(modelId: ModelId): string {
  return finalPath(modelId);
}

function partPath(modelId: ModelId): string {
  return `${modelDirectory(modelId)}/model.gguf.part`;
}

function manifestPath(modelId: ModelId): string {
  return `${modelDirectory(modelId)}/model.json`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function progressOf(
  phase: ModelTransferPhase,
  received: number,
  total: number,
): ModelTransferProgress {
  return {
    phase,
    received,
    total,
    ratio: total > 0 ? Math.min(1, received / total) : 0,
  };
}

function emitProgress(request: ImportModelFileRequest, progress: ModelTransferProgress): void {
  try {
    request.onProgress?.(progress);
  } catch {
    // Progress listeners are cosmetic and must not interrupt the import.
  }
}

function integrityError(message: string, detail: string): EngineError {
  return new EngineError('model-integrity', message, { retryable: false, detail });
}

function importSizeError(): EngineError {
  return integrityError('The imported model file is not the pinned size.', MODEL_IMPORT_SIZE_ERROR);
}

function importDigestError(): EngineError {
  return integrityError(
    'The imported model file failed its digest check.',
    MODEL_IMPORT_DIGEST_ERROR,
  );
}

async function discardPart(store: ModelFileStore, modelId: ModelId): Promise<void> {
  await store.remove(partPath(modelId)).catch(() => undefined);
}

async function writeVerifiedManifest(
  store: ModelFileStore,
  modelId: ModelId,
  entry: Pick<ModelEntry, 'size' | 'sha256' | 'commit' | 'file'>,
  sha256: string,
): Promise<void> {
  const info = await store.stat(finalPath(modelId));
  const manifest = {
    id: modelId,
    sha256,
    size: entry.size,
    commit: entry.commit,
    verifiedAt: Date.now(),
    ...(info ? { lastModified: info.lastModified } : {}),
  };
  const writer = await store.createWriter(manifestPath(modelId), 0);
  try {
    await writer.write(TEXT_ENCODER.encode(JSON.stringify(manifest)));
  } finally {
    await writer.close();
  }
}

/**
 * Streams a user-selected GGUF into the browser store as a `.part` file while hashing it,
 * then checks the pinned size and SHA-256 before renaming it. A wrong file or an abort
 * removes the part; an already installed model is never overwritten by a failed import.
 */
export async function importModelFile(
  request: ImportModelFileRequest,
): Promise<ImportModelFileResult> {
  const { file, modelId, store, signal } = request;
  const entry = request.entry ?? getModel(modelId);
  const chunkBytes = Math.max(1, request.chunkBytes ?? DEFAULT_IMPORT_CHUNK_BYTES);

  throwIfAborted(signal);
  await discardPart(store, modelId);

  if (file.size !== entry.size) throw importSizeError();

  const writer = await store.createWriter(partPath(modelId), 0);
  const hasher = request.hashBlob ? null : await createSha256();
  let writerClosed = false;
  let received = 0;

  const closeWriter = async (): Promise<void> => {
    if (writerClosed) return;
    writerClosed = true;
    await writer.close().catch(() => undefined);
  };

  try {
    emitProgress(request, progressOf('copy', 0, entry.size));

    if (typeof file.stream === 'function') {
      const reader = file.stream().getReader();
      try {
        for (;;) {
          throwIfAborted(signal);
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          await writer.write(value);
          hasher?.update(value);
          received += value.byteLength;
          emitProgress(request, progressOf('copy', received, entry.size));
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      for (let offset = 0; offset < file.size; offset += chunkBytes) {
        throwIfAborted(signal);
        const slice = file.slice(offset, Math.min(offset + chunkBytes, file.size));
        const chunk = new Uint8Array(await slice.arrayBuffer());
        if (chunk.byteLength === 0) continue;
        await writer.write(chunk);
        hasher?.update(chunk);
        received += chunk.byteLength;
        emitProgress(request, progressOf('copy', received, entry.size));
      }
    }

    await closeWriter();
    throwIfAborted(signal);

    if (received !== entry.size) throw importSizeError();

    emitProgress(request, progressOf('verify', entry.size, entry.size));
    const digest = request.hashBlob
      ? await request.hashBlob(await store.read(partPath(modelId)), {
          signal,
          onProgress: (hashed) => {
            emitProgress(request, progressOf('verify', hashed, entry.size));
          },
        })
      : (hasher?.hex() ?? '');
    throwIfAborted(signal);

    if (digest !== entry.sha256) throw importDigestError();

    await store.move(partPath(modelId), finalPath(modelId));
    await writeVerifiedManifest(store, modelId, entry, digest);
    return { bytes: entry.size, sha256: digest };
  } catch (error) {
    await closeWriter();
    await discardPart(store, modelId);
    if (isAbortError(error) || signal.aborted) throw abortError();
    throw error;
  }
}

/** True for an import that downloaded/selected the wrong bytes. */
export function isModelImportIntegrityError(error: unknown): boolean {
  return (
    error instanceof EngineError &&
    error.code === 'model-integrity' &&
    (error.detail === MODEL_IMPORT_SIZE_ERROR || error.detail === MODEL_IMPORT_DIGEST_ERROR)
  );
}

/**
 * Hands an installed model to the browser's download flow. The Blob stays disk-backed, so
 * Chrome and Firefox can stream a 1.8 GB file without reading it into page memory.
 */
export async function exportModelFile(request: {
  modelId: ModelId;
  store: ModelFileStore;
  filename?: string;
}): Promise<string> {
  const { modelId, store } = request;
  const info = await store.stat(finalPath(modelId));
  if (!info) throw new EngineError('model-missing', 'The model file is not installed.');

  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new EngineError('unknown', 'This page cannot start a file download.');
  }

  const blob = await store.read(finalPath(modelId));
  const filename = request.filename ?? getModel(modelId).file;
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Give the browser time to start reading the Blob URL before revoking it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return filename;
}
