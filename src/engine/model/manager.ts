import {
  abortError,
  EngineError,
  folderPermissionError,
  isAbortError,
  isEngineError,
} from '../errors';
import type { BackendSelection } from '../in-browser/backend';
import type { LlamaRuntime } from '../in-browser/runtime';
import type { ModelState, ModelStatus } from '../../shared/engine-status';
import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  knownRevisions,
  revisionForDigest,
  revisionForSize,
  type ModelEntry,
  type ModelId,
} from './catalog';
import { copyModelFile, reuseVerifiedFinal, uniquePartPath } from './copy';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_SEGMENT_BYTES,
  downloadModel,
  type DownloadProgress,
} from './download';
import { isPermissionDenied, type ModelFileStore } from './file-store';
import { decideIntegrity, digestMatchesPin, type IntegrityManifest } from './integrity';
import { SharedFolderModelFileStore } from './shared-store';
import { sha256OfBlob, type HashOptions } from './sha256';
import { DownloadStallError, stallTimeoutOf, withinStall } from './stall';

export interface LoadedModel {
  id: ModelId;
  runtime: LlamaRuntime;
  selection: BackendSelection;
}

export interface ModelManagerOptions {
  store: ModelFileStore;
  /** Browser OPFS copy, used as fallback until a verified move into the shared folder. */
  fallbackStore?: ModelFileStore;
  createRuntime: (blob: Blob, selection: BackendSelection) => Promise<LlamaRuntime>;
  fetchImpl?: typeof fetch;
  hashBlob?: (blob: Blob, options?: HashOptions) => Promise<string>;
  entries?: Readonly<Record<ModelId, ModelEntry>>;
  onStatus?: (status: ModelStatus) => void;
  /** Override the streamed OPFS→folder copy chunk size. Tests use a small value. */
  copyChunkBytes?: number;
  /** Test hook for bounding one network or filesystem operation that makes no progress. */
  stallTimeoutMs?: number;
  /** Profile-local partial paths; injected by tests or a persistent session adapter. */
  downloadPartPaths?: Map<ModelId, string>;
}

interface ModelManifest extends IntegrityManifest {
  id: ModelId;
  verifiedAt: number;
}

const FREE_SPACE_MARGIN = 64 * 1024 * 1024;
const TEXT_ENCODER = new TextEncoder();

/** Internal status.error tokens. The UI maps size/digest to the wrong-file copy and revision to the update hint. */
export const INTEGRITY_SIZE_ERROR = 'integrity-size';
export const INTEGRITY_DIGEST_ERROR = 'integrity-digest';
/** Correct-size file with a hash that is not in the catalog's known-revision list. */
export const INTEGRITY_REVISION_ERROR = 'integrity-revision';

export function isModelIntegrityError(error: string | undefined): boolean {
  return (
    error === INTEGRITY_SIZE_ERROR ||
    error === INTEGRITY_DIGEST_ERROR ||
    error === INTEGRITY_REVISION_ERROR
  );
}

export class ModelManager {
  private store: ModelFileStore;
  private fallbackStore: ModelFileStore | undefined;
  /** OPFS is primary while the folder grant is missing; the Settings copy is still deletable. */
  private browserCopyIsPrimary = false;
  private readonly createRuntime: ModelManagerOptions['createRuntime'];
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly hashBlob: ((blob: Blob, options?: HashOptions) => Promise<string>) | undefined;
  private readonly entries: Readonly<Record<ModelId, ModelEntry>>;
  private readonly onStatus: ((status: ModelStatus) => void) | undefined;
  private readonly copyChunkBytes: number | undefined;
  private readonly stallTimeoutMs: number | undefined;
  private readonly downloads = new Map<
    ModelId,
    { operation: Promise<void>; abort: AbortController; signal: AbortSignal }
  >();
  private readonly verifies = new Map<ModelId, { operation: Promise<void>; signal: AbortSignal }>();
  private readonly standaloneVerifies = new Map<ModelId, AbortController>();
  private readonly downloadParts: Map<ModelId, string>;
  private readonly errors = new Map<ModelId, string>();
  private loaded: LoadedModel | null = null;
  private loadChain: Promise<void> = Promise.resolve();

  constructor(options: ModelManagerOptions) {
    this.store = options.store;
    this.fallbackStore = options.fallbackStore;
    this.createRuntime = options.createRuntime;
    this.fetchImpl = options.fetchImpl;
    this.hashBlob = options.hashBlob;
    this.entries = options.entries ?? MODEL_CATALOG;
    this.onStatus = options.onStatus;
    this.copyChunkBytes = options.copyChunkBytes;
    this.stallTimeoutMs = options.stallTimeoutMs;
    this.downloadParts = options.downloadPartPaths ?? new Map<ModelId, string>();
  }

  setStores(
    primary: ModelFileStore,
    fallback?: ModelFileStore,
    options: { primaryIsBrowserCopy?: boolean } = {},
  ): void {
    this.store = primary;
    this.fallbackStore = fallback === primary ? undefined : fallback;
    this.browserCopyIsPrimary = options.primaryIsBrowserCopy === true && !this.fallbackStore;
  }

  private entry(modelId: ModelId): ModelEntry {
    return this.entries[modelId];
  }

  get loadedModel(): LoadedModel | null {
    return this.loaded;
  }

  get primaryStore(): ModelFileStore {
    return this.store;
  }

  get secondaryStore(): ModelFileStore | undefined {
    return this.fallbackStore;
  }

  async status(
    modelId: ModelId = DEFAULT_MODEL_ID,
    options: { signal?: AbortSignal } = {},
  ): Promise<ModelStatus> {
    const entry = this.entry(modelId);

    if (this.loaded?.id === modelId) {
      return { id: modelId, state: 'loaded', received: entry.size, total: entry.size, progress: 1 };
    }

    const primary = await this.inspect(this.store, modelId);
    if (primary.state === 'ready') {
      this.errors.delete(modelId);
      return primary;
    }

    if (primary.integrity === 'needs-hash' && !this.errors.has(modelId)) {
      this.kickVerify(this.store, modelId, options.signal);
    }

    if (this.fallbackStore) {
      const fallback = await this.inspect(this.fallbackStore, modelId);
      if (fallback.state === 'ready') return fallback;
    }

    const failure = this.errors.get(modelId);
    if (failure) {
      return {
        id: modelId,
        state: 'error',
        received: primary.received,
        total: entry.size,
        progress: primary.progress,
        error: failure,
      };
    }

    if (this.verifies.has(modelId) || primary.integrity === 'needs-hash') {
      return {
        id: modelId,
        state: 'verifying',
        received: entry.size,
        total: entry.size,
        progress: 0,
      };
    }

    return {
      id: modelId,
      state: primary.state,
      received: primary.received,
      total: entry.size,
      progress: primary.progress,
      ...(primary.error ? { error: primary.error } : {}),
    };
  }

  async download(
    modelId: ModelId,
    options: { signal: AbortSignal; onProgress?: (progress: DownloadProgress) => void },
  ): Promise<void> {
    if (options.signal.aborted) throw abortError();

    const existing = this.downloads.get(modelId);
    if (existing) {
      if (!existing.signal.aborted) return existing.operation;
      // The aborted transfer may still own its writer and partial file. Wait for its cleanup,
      // then de-dupe again in case another Resume caller already started the replacement.
      await existing.operation.catch(() => undefined);
      return this.download(modelId, options);
    }

    const abort = new AbortController();
    const signal = AbortSignal.any([options.signal, abort.signal]);
    const operation = this.runDownload(modelId, signal, options.onProgress).finally(() => {
      if (this.downloads.get(modelId)?.operation === operation) this.downloads.delete(modelId);
    });
    this.downloads.set(modelId, { operation, abort, signal });
    return operation;
  }

  /** Stop both a tracked transfer and verification started by a read-only status check. */
  cancel(modelId: ModelId): void {
    this.downloads.get(modelId)?.abort.abort();
    this.standaloneVerifies.get(modelId)?.abort();
  }

  /**
   * Hash any correctly-sized files already in the primary store, then copy each verified
   * official OPFS model that the folder does not already have. Used after the user picks a
   * shared folder so Chrome profile A can share with Edge without a network download.
   */
  async adoptPresentModels(options: { signal?: AbortSignal } = {}): Promise<void> {
    const signal = options.signal ?? new AbortController().signal;
    for (const modelId of this.knownModelIds()) {
      const inspected = await this.inspect(this.store, modelId);
      if (inspected.integrity !== 'needs-hash') continue;
      await this.runVerify(this.store, modelId, signal).catch(() => undefined);
    }
    for (const modelId of this.knownModelIds()) {
      try {
        await this.copyOneFallback(modelId, signal);
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw abortError();
      }
    }
  }

  /**
   * Move verified OPFS models into the folder: adopt each model, then delete its browser
   * copy only after the folder copy is verified. A failed verification leaves OPFS in place,
   * so Settings can report what could not be moved.
   */
  async adoptPresentModelsAndRemoveOpfs(
    options: { signal?: AbortSignal } = {},
  ): Promise<ModelId[]> {
    await this.adoptPresentModels(options);
    if (!this.fallbackStore) return [];

    const removed: ModelId[] = [];
    for (const modelId of this.knownModelIds()) {
      const primary = await this.inspect(this.store, modelId);
      if (primary.state !== 'ready') continue;
      if (!(await this.fallbackCopyPresent(modelId))) continue;
      // A running download may still be reading this copy for its store handoff.
      if (this.downloads.has(modelId)) continue;
      await this.deleteFallbackCopy(modelId);
      removed.push(modelId);
    }
    return removed;
  }

  /**
   * Copy verified folder models into the OPFS browser store. The source folder files are
   * never deleted: another Chromium profile may still be using them. The caller drops the
   * stored folder handle after this succeeds.
   */
  async copyPresentModelsToBrowser(options: { signal?: AbortSignal } = {}): Promise<ModelId[]> {
    if (!this.fallbackStore) return [];
    const signal = options.signal ?? new AbortController().signal;
    const copied: ModelId[] = [];

    for (const modelId of this.knownModelIds()) {
      let primary = await this.inspect(this.store, modelId);
      if (primary.integrity === 'needs-hash') {
        await this.runVerify(this.store, modelId, signal).catch(() => undefined);
        primary = await this.inspect(this.store, modelId);
      }
      if (primary.integrity === 'missing') continue;
      if (primary.state !== 'ready') {
        // The folder has a file for this model but it is not the pinned official GGUF.
        // Stop before dropping the handle so the user can fix or keep using the folder.
        throw new EngineError('model-integrity', 'The folder model failed verification.', {
          retryable: false,
        });
      }

      let target = await this.inspect(this.fallbackStore, modelId);
      if (target.integrity === 'needs-hash') {
        await this.runVerify(this.fallbackStore, modelId, signal).catch(() => undefined);
        target = await this.inspect(this.fallbackStore, modelId);
      }
      if (target.state === 'ready') {
        copied.push(modelId);
        continue;
      }

      if (await this.copyBetweenStores(this.store, this.fallbackStore, modelId, signal)) {
        copied.push(modelId);
      }
    }
    return copied;
  }

  async deleteModel(modelId: ModelId): Promise<void> {
    const active = this.downloads.get(modelId);
    if (active) {
      active.abort.abort();
      await active.operation.catch(() => undefined);
    }

    if (this.loaded?.id === modelId) await this.unload();

    this.errors.delete(modelId);
    this.downloadParts.delete(modelId);
    await this.store.removeDirectory(this.modelDirectory(modelId));
    this.notify({
      id: modelId,
      state: 'absent',
      received: 0,
      total: this.entry(modelId).size,
      progress: 0,
    });
  }

  /**
   * Bytes for a second wllama instance (WebGPU collapse retry). Reads the shared
   * folder when it is verified, otherwise the OPFS copy.
   */
  async modelBlob(modelId: ModelId = DEFAULT_MODEL_ID): Promise<Blob> {
    const store = await this.resolveReadStore(modelId);
    if (!store) {
      const failure = this.errors.get(modelId);
      if (failure) throw new EngineError('model-integrity', failure, { retryable: false });
      throw new EngineError('model-missing', 'The translation model is not downloaded yet.');
    }
    return store.read(this.finalPath(modelId));
  }

  /**
   * Deletes the OPFS browser copy only. Never touches the shared folder.
   *
   * When the folder grant is missing the OPFS store becomes primary instead of a
   * separate fallback. Settings still offers that browser copy for deletion, so the
   * same per-model directory is removed from the primary store in that mode.
   */
  async deleteFallbackCopy(modelId: ModelId): Promise<void> {
    const target = this.fallbackStore ?? (this.browserCopyIsPrimary ? this.store : undefined);
    if (!target) return;
    if (this.loaded?.id === modelId) {
      const source = await this.resolveReadStore(modelId);
      if (source === target) await this.unload();
    }
    await target.removeDirectory(this.modelDirectory(modelId));
  }

  async fallbackCopyPresent(modelId: ModelId): Promise<boolean> {
    if (!this.fallbackStore) return false;
    const inspected = await this.inspect(this.fallbackStore, modelId);
    return inspected.state === 'ready';
  }

  async primaryReady(modelId: ModelId): Promise<boolean> {
    const inspected = await this.inspect(this.store, modelId);
    return inspected.state === 'ready';
  }

  /**
   * True when a verified model can be read right now, either from the loaded runtime, the
   * current primary store (which is OPFS when the shared folder cannot open), or the OPFS
   * fallback retained beside a folder primary. A missing folder grant alone must not stop
   * a load that can answer from one of these copies.
   */
  async hasReadableCopy(modelId: ModelId): Promise<boolean> {
    if (this.loaded?.id === modelId) return true;
    if (await this.primaryReady(modelId)) return true;
    return this.fallbackCopyPresent(modelId);
  }

  async sharedIntegrityIssue(
    modelId: ModelId,
  ): Promise<{ kind: 'size' | 'digest' | 'revision'; file: string } | null> {
    const entry = this.entry(modelId);
    const inspected = await this.inspect(this.store, modelId);
    if (inspected.integrity === 'reject-size') {
      return { kind: 'size', file: entry.file };
    }
    const stat = await this.store.stat(this.finalPath(modelId));
    if (!stat) return null;
    if (!revisionForSize(entry, stat.size)) {
      return { kind: 'size', file: entry.file };
    }
    const error = this.errors.get(modelId);
    if (error === INTEGRITY_REVISION_ERROR) {
      return { kind: 'revision', file: entry.file };
    }
    if (error === INTEGRITY_DIGEST_ERROR) {
      return { kind: 'digest', file: entry.file };
    }
    return null;
  }

  async unload(): Promise<void> {
    const current = this.loaded;
    this.loaded = null;
    if (!current) return;

    try {
      await current.runtime.dispose();
    } catch {
      // A runtime that fails to dispose is already unusable.
    }

    const entry = this.entry(current.id);
    this.notify({
      id: current.id,
      state: 'ready',
      received: entry.size,
      total: entry.size,
      progress: 1,
    });
  }

  async ensureLoaded(
    modelId: ModelId,
    selection: BackendSelection,
    options: { signal?: AbortSignal } = {},
  ): Promise<LoadedModel> {
    const run = async (): Promise<LoadedModel> => {
      if (this.loaded && this.matchesLoaded(this.loaded, modelId, selection)) return this.loaded;
      if (options.signal?.aborted) throw abortError();

      await this.unload();

      const store = await this.resolveReadStore(modelId, options.signal);
      if (!store) {
        const failure = this.errors.get(modelId);
        if (failure) throw new EngineError('model-integrity', failure, { retryable: false });
        throw new EngineError('model-missing', 'The translation model is not downloaded yet.');
      }

      const status = await this.inspect(store, modelId);
      this.notify({
        id: modelId,
        state: 'loading',
        received: status.received,
        total: this.entry(modelId).size,
        progress: 1,
      });
      let blob: Blob;
      try {
        blob = await store.read(this.finalPath(modelId));
      } catch (error) {
        if (isPermissionDenied(error)) throw folderPermissionError();
        throw error;
      }
      const runtime = await this.createRuntime(blob, selection);
      const loaded: LoadedModel = { id: modelId, runtime, selection };
      this.loaded = loaded;
      this.notify({
        id: modelId,
        state: 'loaded',
        received: this.entry(modelId).size,
        total: this.entry(modelId).size,
        progress: 1,
      });
      return loaded;
    };

    const result = this.loadChain.then(run, run);
    this.loadChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private knownModelIds(): readonly ModelId[] {
    return Object.keys(this.entries) as ModelId[];
  }

  private async runDownload(
    modelId: ModelId,
    signal: AbortSignal,
    onProgress: ((progress: DownloadProgress) => void) | undefined,
  ): Promise<void> {
    const entry = this.entry(modelId);
    // A folder apply replaces this.store while the host keeps this download alive. Pin every
    // step of the transfer to one store, then hand the verified result to the latest store.
    const store = this.store;
    const fallbackStore = this.fallbackStore;
    this.errors.delete(modelId);

    const current = await this.inspect(store, modelId);
    if (current.state === 'ready' || this.loaded?.id === modelId) {
      this.downloadParts.delete(modelId);
      await this.finishDownloadInCurrentStore(modelId, store, signal, onProgress);
      return;
    }

    try {
      if (current.integrity === 'reject-size') {
        throw new EngineError('model-integrity', INTEGRITY_SIZE_ERROR, { retryable: false });
      }

      if (current.integrity === 'needs-hash') {
        await this.runVerify(store, modelId, signal, onProgress);
        this.downloadParts.delete(modelId);
        await this.finishDownloadInCurrentStore(modelId, store, signal, onProgress);
        return;
      }

      try {
        if (
          await this.copyOneFallback(modelId, signal, onProgress, {
            primary: store,
            fallback: fallbackStore,
          })
        ) {
          this.downloadParts.delete(modelId);
          await this.finishDownloadInCurrentStore(modelId, store, signal, onProgress);
          return;
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
      }

      const partPath = await this.resolveDownloadPartPath(modelId, store, fallbackStore, signal);
      const reused = await reuseVerifiedFinal({
        store,
        partPath,
        finalPath: this.finalPath(modelId),
        size: entry.size,
        sha256: entry.sha256,
        revisions: knownRevisions(entry),
        signal,
        ...(this.hashBlob ? { hashBlob: this.hashBlob } : {}),
      });
      if (reused) {
        this.downloadParts.delete(modelId);
        await this.writeVerifiedManifest(store, modelId, reused.sha256);
        await this.finishDownloadInCurrentStore(modelId, store, signal, onProgress);
        return;
      }

      await this.ensureSpace(store, modelId, partPath);

      const resumedBytes = await store.size(partPath);
      this.notify({
        id: modelId,
        state: 'downloading',
        received: Math.min(resumedBytes, entry.size),
        total: entry.size,
        progress: Math.min(1, resumedBytes / entry.size),
      });

      const downloaded = await downloadModel({
        source: {
          url: entry.url,
          size: entry.size,
          sha256: entry.sha256,
          revisions: knownRevisions(entry),
        },
        store,
        partPath,
        finalPath: this.finalPath(modelId),
        signal,
        attempts: 3,
        segmentBytes: DEFAULT_SEGMENT_BYTES,
        concurrency: DEFAULT_CONCURRENCY,
        ...(this.stallTimeoutMs !== undefined ? { stallTimeoutMs: this.stallTimeoutMs } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        ...(this.hashBlob ? { hashBlob: this.hashBlob } : {}),
        onProgress: (progress) => {
          const state: ModelState = progress.phase === 'verify' ? 'verifying' : 'downloading';
          this.notify({
            id: modelId,
            state,
            received: progress.received,
            total: entry.size,
            progress: progress.ratio,
          });
          onProgress?.(progress);
        },
      });

      await this.writeVerifiedManifest(store, modelId, downloaded.sha256);
      this.downloadParts.delete(modelId);
      await this.finishDownloadInCurrentStore(modelId, store, signal, onProgress);
    } catch (error) {
      if (isAbortError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.errors.set(modelId, message);
      // A timed-out writer can still settle later. Never let a retry open the same temp file.
      if (error instanceof DownloadStallError && error.writer) {
        this.downloadParts.delete(modelId);
      }
      const partPath = this.downloadParts.get(modelId);
      const received = partPath ? await store.size(partPath).catch(() => 0) : 0;
      this.notify({
        id: modelId,
        state: 'error',
        received,
        total: entry.size,
        progress: Math.min(1, received / entry.size),
        error: message,
      });
      throw error;
    }
  }

  /** Keep one host download attached while a folder pick changes its final destination. */
  private async finishDownloadInCurrentStore(
    modelId: ModelId,
    downloadedStore: ModelFileStore,
    signal: AbortSignal,
    onProgress: ((progress: DownloadProgress) => void) | undefined,
  ): Promise<void> {
    let source = downloadedStore;
    while (this.store !== source) {
      const target = this.store;
      const inspected = await this.inspect(target, modelId);
      if (inspected.integrity === 'needs-hash') {
        await this.runVerify(target, modelId, signal, onProgress);
        source = target;
        continue;
      }
      if (inspected.integrity === 'reject-size') {
        throw new EngineError('model-integrity', INTEGRITY_SIZE_ERROR, { retryable: false });
      }
      if (inspected.state === 'ready') {
        source = target;
        continue;
      }

      const copied = await this.copyOneFallback(modelId, signal, onProgress, {
        primary: target,
        fallback: source,
      });
      if (!copied) {
        // A concurrent folder adoption may have installed the file since the first inspect.
        if ((await this.inspect(target, modelId)).state === 'ready') {
          source = target;
          continue;
        }
        throw new EngineError(
          'download-failed',
          'The downloaded model could not be moved to the selected store.',
        );
      }
      source = target;
    }

    const entry = this.entry(modelId);
    this.notify({
      id: modelId,
      state: 'ready',
      received: entry.size,
      total: entry.size,
      progress: 1,
    });
  }

  /**
   * Copy a verified official OPFS model into the primary (shared) store when that store
   * does not already have a valid file. Never overwrites a wrong-sized folder file. The
   * OPFS copy is retained as a fallback for a later lost-folder-permission visit.
   */
  private async copyOneFallback(
    modelId: ModelId,
    signal: AbortSignal,
    onProgress?: (progress: DownloadProgress) => void,
    stores: { primary: ModelFileStore; fallback: ModelFileStore | undefined } = {
      primary: this.store,
      fallback: this.fallbackStore,
    },
  ): Promise<boolean> {
    const { primary: primaryStore, fallback: fallbackStore } = stores;
    if (!fallbackStore) return false;

    const primary = await this.inspect(primaryStore, modelId);
    // Another Chrome/Edge profile may already hold a pin-sized GGUF here. Never
    // replace it: `removeEntry` + rewrite is how one profile can invalidate the
    // file another profile's handle still points at. Only fill an empty slot.
    if (primary.integrity !== 'missing') return false;
    const error = this.errors.get(modelId);
    if (error === INTEGRITY_DIGEST_ERROR || error === INTEGRITY_REVISION_ERROR) return false;
    if (await this.copyAlreadyRejected(modelId, fallbackStore)) return false;

    let fallback = await this.inspect(fallbackStore, modelId);
    if (fallback.integrity === 'needs-hash') {
      await this.runVerify(fallbackStore, modelId, signal, onProgress).catch(() => undefined);
      fallback = await this.inspect(fallbackStore, modelId);
    }
    if (fallback.state !== 'ready') return false;
    return this.copyBetweenStores(fallbackStore, primaryStore, modelId, signal, onProgress);
  }

  private async copyBetweenStores(
    source: ModelFileStore,
    target: ModelFileStore,
    modelId: ModelId,
    signal: AbortSignal,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<boolean> {
    const entry = this.entry(modelId);
    const blob = await source.read(this.finalPath(modelId));

    this.notify({
      id: modelId,
      state: 'downloading',
      received: 0,
      total: entry.size,
      progress: 0,
    });

    const partPath = uniquePartPath(this.partPath(modelId));
    if (target instanceof SharedFolderModelFileStore) {
      await target.pruneStalePartFiles(modelId, partPath).catch(() => undefined);
    }

    let copiedDigest: string;
    try {
      const copied = await copyModelFile({
        blob,
        store: target,
        partPath,
        finalPath: this.finalPath(modelId),
        size: entry.size,
        sha256: entry.sha256,
        revisions: knownRevisions(entry),
        signal,
        onProgress: (progress) => {
          const state: ModelState = progress.phase === 'verify' ? 'verifying' : 'downloading';
          this.notify({
            id: modelId,
            state,
            received: progress.received,
            total: entry.size,
            progress: progress.ratio,
          });
          onProgress?.(progress);
        },
        ...(this.hashBlob ? { hashBlob: this.hashBlob } : {}),
        ...(this.copyChunkBytes !== undefined ? { chunkBytes: this.copyChunkBytes } : {}),
        ...(this.stallTimeoutMs !== undefined ? { stallTimeoutMs: this.stallTimeoutMs } : {}),
      });
      copiedDigest = copied.sha256;
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw abortError();
      // A pinned-size OPFS file whose bytes do not match the catalog must not be
      // copied again on every folder reload or offscreen start. Record the skip on
      // OPFS so a new offscreen document does not hash hundreds of MB again.
      if (
        isEngineError(error) &&
        error.code === 'model-integrity' &&
        source === this.fallbackStore
      ) {
        await this.rememberCopyRejection(modelId);
        this.notify(await this.status(modelId));
        return false;
      }
      throw error;
    }

    this.errors.delete(modelId);
    await this.writeVerifiedManifest(target, modelId, copiedDigest);
    this.notify({
      id: modelId,
      state: 'ready',
      received: entry.size,
      total: entry.size,
      progress: 1,
    });
    return true;
  }

  private kickVerify(store: ModelFileStore, modelId: ModelId, signal?: AbortSignal): void {
    if (this.downloads.has(modelId) || this.standaloneVerifies.has(modelId)) return;
    const abort = new AbortController();
    this.standaloneVerifies.set(modelId, abort);
    const verifySignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    void this.runVerify(store, modelId, verifySignal)
      .catch(() => undefined)
      .finally(() => {
        if (this.standaloneVerifies.get(modelId) === abort) {
          this.standaloneVerifies.delete(modelId);
        }
      });
  }

  private async runVerify(
    store: ModelFileStore,
    modelId: ModelId,
    signal: AbortSignal,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<void> {
    if (signal.aborted) throw abortError();
    const existing = this.verifies.get(modelId);
    if (existing) {
      if (!existing.signal.aborted) return existing.operation;
      await existing.operation.catch(() => undefined);
      return this.runVerify(store, modelId, signal, onProgress);
    }
    const operation = this.verifyExisting(store, modelId, signal, onProgress).finally(() => {
      if (this.verifies.get(modelId)?.operation === operation) this.verifies.delete(modelId);
    });
    this.verifies.set(modelId, { operation, signal });
    return operation;
  }

  private async verifyExisting(
    store: ModelFileStore,
    modelId: ModelId,
    signal: AbortSignal,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<void> {
    const entry = this.entry(modelId);

    this.notify({
      id: modelId,
      state: 'verifying',
      received: 0,
      total: entry.size,
      progress: 0,
    });

    const blob = await store.read(this.finalPath(modelId));
    const hashBlob = this.hashBlob ?? sha256OfBlob;
    const digest = await hashBlob(blob, {
      signal,
      onProgress: (hashed) => {
        const progress = {
          received: hashed,
          total: entry.size,
          ratio: entry.size > 0 ? Math.min(1, hashed / entry.size) : 0,
          resumedFrom: 0,
          phase: 'verify' as const,
        };
        this.notify({
          id: modelId,
          state: 'verifying',
          received: hashed,
          total: entry.size,
          progress: progress.ratio,
        });
        onProgress?.(progress);
      },
    });

    if (signal.aborted) throw abortError();

    if (!digestMatchesPin(digest, entry)) {
      const stat = await store.stat(this.finalPath(modelId));
      // Correct size under the official filename means an unrecognised official revision,
      // not a completely different model. The UI suggests updating Sakutto for that case.
      const token =
        stat && revisionForSize(entry, stat.size)
          ? INTEGRITY_REVISION_ERROR
          : INTEGRITY_DIGEST_ERROR;
      this.errors.set(modelId, token);
      throw new EngineError('model-integrity', token, { retryable: false });
    }

    this.errors.delete(modelId);
    await this.writeVerifiedManifest(store, modelId, digest);
    this.notify({
      id: modelId,
      state: 'ready',
      received: entry.size,
      total: entry.size,
      progress: 1,
    });
  }

  private async resolveReadStore(
    modelId: ModelId,
    signal?: AbortSignal,
  ): Promise<ModelFileStore | null> {
    const abort = signal ?? new AbortController().signal;
    const pick = async (store: ModelFileStore): Promise<ModelFileStore | null> => {
      const inspected = await this.inspect(store, modelId);
      if (inspected.integrity === 'needs-hash') {
        await this.runVerify(store, modelId, abort).catch(() => undefined);
        const verified = await this.inspect(store, modelId);
        return verified.state === 'ready' ? store : null;
      }
      return inspected.state === 'ready' ? store : null;
    };

    const primary = await pick(this.store);
    if (primary) return primary;
    if (!this.fallbackStore) return null;
    return pick(this.fallbackStore);
  }

  private async inspect(
    store: ModelFileStore,
    modelId: ModelId,
  ): Promise<ModelStatus & { integrity: ReturnType<typeof decideIntegrity> }> {
    const entry = this.entry(modelId);
    const partPath = this.downloadParts.get(modelId);
    const [fileStat, partSize] = await Promise.all([
      store.stat(this.finalPath(modelId)),
      partPath ? store.size(partPath) : Promise.resolve(0),
    ]);
    const received = Math.min(partSize, entry.size);
    const manifest = await this.readManifest(store, modelId);
    const file = fileStat ? { size: fileStat.size, lastModified: fileStat.lastModified } : null;
    const integrity = decideIntegrity(entry, file, manifest);
    const displaySize = (fileStat && revisionForSize(entry, fileStat.size)?.size) || entry.size;

    if (integrity === 'verified') {
      return {
        id: modelId,
        state: 'ready',
        received: displaySize,
        total: displaySize,
        progress: 1,
        integrity,
      };
    }

    if (integrity === 'reject-size') {
      return {
        id: modelId,
        state: 'error',
        received: fileStat?.size ?? 0,
        total: displaySize,
        progress: 0,
        error: INTEGRITY_SIZE_ERROR,
        integrity,
      };
    }

    const state: ModelState = partSize > 0 ? 'partial' : 'absent';
    return {
      id: modelId,
      state,
      received,
      total: displaySize,
      progress: received / displaySize,
      integrity,
    };
  }

  private async ensureSpace(
    store: ModelFileStore,
    modelId: ModelId,
    partPath: string,
  ): Promise<void> {
    const entry = this.entry(modelId);
    const estimate = await store.estimate();
    if (estimate.quota <= 0) return;

    const existing = await store.size(partPath);
    const needed = Math.max(0, entry.size - existing) + FREE_SPACE_MARGIN;
    if (estimate.quota - estimate.usage < needed) {
      throw new EngineError(
        'storage-insufficient',
        'There is not enough free storage for the translation model.',
      );
    }
  }

  private matchesLoaded(
    loaded: LoadedModel,
    modelId: ModelId,
    selection: BackendSelection,
  ): boolean {
    return (
      loaded.id === modelId &&
      loaded.selection.backend === selection.backend &&
      loaded.selection.nThreads === selection.nThreads &&
      loaded.selection.nGpuLayers === selection.nGpuLayers &&
      loaded.selection.nParallel === selection.nParallel &&
      loaded.selection.nCtx === selection.nCtx
    );
  }

  private async readManifest(
    store: ModelFileStore,
    modelId: ModelId,
  ): Promise<ModelManifest | null> {
    try {
      const blob = await store.read(this.manifestPath(modelId));
      const parsed: unknown = JSON.parse(await blob.text());
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      if (
        record.id !== modelId ||
        typeof record.sha256 !== 'string' ||
        typeof record.size !== 'number' ||
        typeof record.commit !== 'string' ||
        typeof record.verifiedAt !== 'number'
      ) {
        return null;
      }
      return {
        id: modelId,
        sha256: record.sha256,
        size: record.size,
        commit: record.commit,
        verifiedAt: record.verifiedAt,
        ...(typeof record.lastModified === 'number' ? { lastModified: record.lastModified } : {}),
      };
    } catch {
      return null;
    }
  }

  private async writeVerifiedManifest(
    store: ModelFileStore,
    modelId: ModelId,
    sha256: string = this.entry(modelId).sha256,
  ): Promise<void> {
    const entry = this.entry(modelId);
    const info = await store.stat(this.finalPath(modelId));
    const revision = revisionForDigest(entry, sha256) ??
      (info ? revisionForSize(entry, info.size) : undefined) ?? {
        commit: entry.commit,
        size: entry.size,
        sha256,
      };
    await this.writeManifest(store, modelId, {
      id: modelId,
      sha256,
      size: revision.size,
      commit: revision.commit,
      verifiedAt: Date.now(),
      ...(info ? { lastModified: info.lastModified } : {}),
    });
  }

  private async writeManifest(
    store: ModelFileStore,
    modelId: ModelId,
    manifest: ModelManifest,
  ): Promise<void> {
    const path = this.manifestPath(modelId);
    const stallTimeout = stallTimeoutOf(this.stallTimeoutMs);
    const writer = await withinStall(store.createWriter(path, 0), stallTimeout, undefined, true);
    try {
      await withinStall(
        writer.write(TEXT_ENCODER.encode(JSON.stringify(manifest))),
        stallTimeout,
        undefined,
        true,
      );
      await withinStall(writer.close(), stallTimeout, undefined, true);
    } catch (error) {
      await withinStall(writer.close(), stallTimeout, undefined, true).catch(() => undefined);
      throw error;
    }
  }

  private notify(status: ModelStatus): void {
    try {
      this.onStatus?.(status);
    } catch {
      // Status listeners are cosmetic and must not interrupt a download.
    }
  }

  private async resolveDownloadPartPath(
    modelId: ModelId,
    store: ModelFileStore,
    fallbackStore: ModelFileStore | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const tracked = this.downloadParts.get(modelId);
    if (tracked) {
      const size = await store.size(tracked).catch(() => 0);
      if (size > 0) return tracked;
      if (fallbackStore && fallbackStore !== store) {
        const fallbackSize = await fallbackStore.size(tracked).catch(() => 0);
        if (fallbackSize > 0) {
          const partPath = uniquePartPath(this.partPath(modelId));
          await this.movePartialForResume(fallbackStore, store, tracked, partPath, signal);
          this.downloadParts.set(modelId, partPath);
          if (store instanceof SharedFolderModelFileStore) {
            await store.pruneStalePartFiles(modelId, partPath).catch(() => undefined);
          }
          return partPath;
        }
      }
      this.downloadParts.delete(modelId);
    }
    const partPath = uniquePartPath(this.partPath(modelId));
    this.downloadParts.set(modelId, partPath);
    if (store instanceof SharedFolderModelFileStore) {
      await store.pruneStalePartFiles(modelId, partPath).catch(() => undefined);
    }
    return partPath;
  }

  /** Move only our saved temp prefix; the normal resumed transfer still hashes it once. */
  private async movePartialForResume(
    source: ModelFileStore,
    target: ModelFileStore,
    sourcePath: string,
    targetPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const blob = await source.read(sourcePath);
    const stallTimeout = stallTimeoutOf(this.stallTimeoutMs);
    const writer = await withinStall(
      target.createWriter(targetPath, 0),
      stallTimeout,
      undefined,
      true,
    );
    const chunkBytes = Math.max(1, this.copyChunkBytes ?? DEFAULT_SEGMENT_BYTES);
    try {
      for (let offset = 0; offset < blob.size; offset += chunkBytes) {
        if (signal.aborted) throw abortError();
        const end = Math.min(offset + chunkBytes, blob.size);
        const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
        await withinStall(writer.write(chunk), stallTimeout, undefined, true);
      }
      if (signal.aborted) throw abortError();
      await withinStall(writer.close(), stallTimeout, undefined, true);
    } catch (error) {
      await withinStall(writer.close(), stallTimeout, undefined, true).catch(() => undefined);
      await target.remove(targetPath).catch(() => undefined);
      throw error;
    }
    await source.remove(sourcePath).catch(() => undefined);
  }

  private modelDirectory(modelId: ModelId): string {
    return `models/${modelId}`;
  }

  private finalPath(modelId: ModelId): string {
    return `${this.modelDirectory(modelId)}/model.gguf`;
  }

  private partPath(modelId: ModelId): string {
    return `${this.modelDirectory(modelId)}/model.gguf.part`;
  }

  private manifestPath(modelId: ModelId): string {
    return `${this.modelDirectory(modelId)}/model.json`;
  }

  private copyRejectedPath(modelId: ModelId): string {
    return `${this.modelDirectory(modelId)}/copy-rejected.json`;
  }

  private async copyAlreadyRejected(
    modelId: ModelId,
    fallbackStore: ModelFileStore | undefined = this.fallbackStore,
  ): Promise<boolean> {
    if (!fallbackStore) return false;
    const stat = await fallbackStore.stat(this.finalPath(modelId));
    if (!stat) return false;
    try {
      const parsed: unknown = JSON.parse(
        await (await fallbackStore.read(this.copyRejectedPath(modelId))).text(),
      );
      if (typeof parsed !== 'object' || parsed === null) return false;
      const record = parsed as Record<string, unknown>;
      const entry = this.entry(modelId);
      const revision = revisionForSize(entry, stat.size) ?? entry;
      return (
        record.sha256 === revision.sha256 &&
        record.size === revision.size &&
        record.fileSize === stat.size &&
        record.lastModified === stat.lastModified
      );
    } catch {
      return false;
    }
  }

  private async rememberCopyRejection(modelId: ModelId): Promise<void> {
    if (!this.fallbackStore) return;
    const stat = await this.fallbackStore.stat(this.finalPath(modelId));
    if (!stat) return;
    const entry = this.entry(modelId);
    const revision = revisionForSize(entry, stat.size) ?? entry;
    const path = this.copyRejectedPath(modelId);
    await this.fallbackStore.remove(path);
    await this.fallbackStore.append(
      path,
      TEXT_ENCODER.encode(
        JSON.stringify({
          sha256: revision.sha256,
          size: revision.size,
          fileSize: stat.size,
          lastModified: stat.lastModified,
        }),
      ),
      0,
    );
  }
}
