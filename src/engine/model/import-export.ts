import { abortError, EngineError, isAbortError } from '../errors';
import {
  getModel,
  knownRevisions,
  type ModelEntry,
  type ModelId,
  type ModelRevision,
} from './catalog';
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
  entry?: Pick<ModelEntry, 'size' | 'sha256' | 'commit' | 'file'> &
    Partial<Pick<ModelEntry, 'revisions'>>;
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
  revision: ModelRevision,
  sha256: string,
): Promise<void> {
  const info = await store.stat(finalPath(modelId));
  const manifest = {
    id: modelId,
    sha256,
    size: revision.size,
    commit: revision.commit,
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
  const pinnedSize =
    knownRevisions(entry).find((item) => item.size === file.size)?.size ?? entry.size;

  throwIfAborted(signal);
  await discardPart(store, modelId);

  if (!knownRevisions(entry).some((revision) => revision.size === file.size)) {
    throw importSizeError();
  }

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
    emitProgress(request, progressOf('copy', 0, pinnedSize));

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
          emitProgress(request, progressOf('copy', received, pinnedSize));
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
        emitProgress(request, progressOf('copy', received, pinnedSize));
      }
    }

    await closeWriter();
    throwIfAborted(signal);

    if (received !== pinnedSize) throw importSizeError();

    emitProgress(request, progressOf('verify', pinnedSize, pinnedSize));
    const digest = request.hashBlob
      ? await request.hashBlob(await store.read(partPath(modelId)), {
          signal,
          onProgress: (hashed) => {
            emitProgress(request, progressOf('verify', hashed, pinnedSize));
          },
        })
      : (hasher?.hex() ?? '');
    throwIfAborted(signal);

    const revision = knownRevisions(entry).find(
      (item) => item.size === file.size && item.sha256 === digest,
    );
    if (!revision) throw importDigestError();

    await store.move(partPath(modelId), finalPath(modelId));
    await writeVerifiedManifest(store, modelId, revision, digest);
    return { bytes: revision.size, sha256: digest };
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
