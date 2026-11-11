import { abortError, EngineError, isAbortError } from '../errors';
import type { BackendSelection } from '../in-browser/backend';
import type { LlamaRuntime } from '../in-browser/runtime';
import type { ModelState, ModelStatus } from '../../shared/engine-status';
import { DEFAULT_MODEL_ID, MODEL_CATALOG, type ModelEntry, type ModelId } from './catalog';
import { downloadModel, type DownloadProgress } from './download';
import type { ModelFileStore } from './file-store';
import { decideIntegrity, digestMatchesPin, type IntegrityManifest } from './integrity';
import { sha256OfBlob, type HashOptions } from './sha256';

export interface LoadedModel {
  id: ModelId;
  runtime: LlamaRuntime;
  selection: BackendSelection;
}

export interface ModelManagerOptions {
  store: ModelFileStore;
  /** Browser OPFS copy, used when a shared folder is active so translation can still start. */
  fallbackStore?: ModelFileStore;
  createRuntime: (blob: Blob, selection: BackendSelection) => Promise<LlamaRuntime>;
  fetchImpl?: typeof fetch;
  hashBlob?: (blob: Blob, options?: HashOptions) => Promise<string>;
  entries?: Readonly<Record<ModelId, ModelEntry>>;
  onStatus?: (status: ModelStatus) => void;
}

interface ModelManifest extends IntegrityManifest {
  id: ModelId;
  verifiedAt: number;
}

const FREE_SPACE_MARGIN = 64 * 1024 * 1024;
const TEXT_ENCODER = new TextEncoder();
const SIZE_MISMATCH_MESSAGE =
  'The file is not the official PLaMo model (size mismatch). Sakutto will not load it.';
const DIGEST_MISMATCH_MESSAGE =
  'The file failed its digest check, so Sakutto will not load it. Wrong translations are not acceptable.';

export class ModelManager {
  private store: ModelFileStore;
  private fallbackStore: ModelFileStore | undefined;
  private readonly createRuntime: ModelManagerOptions['createRuntime'];
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly hashBlob: ((blob: Blob, options?: HashOptions) => Promise<string>) | undefined;
  private readonly entries: Readonly<Record<ModelId, ModelEntry>>;
  private readonly onStatus: ((status: ModelStatus) => void) | undefined;
  private readonly downloads = new Map<
    ModelId,
    { operation: Promise<void>; abort: AbortController }
  >();
  private readonly verifies = new Map<ModelId, Promise<void>>();
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
  }

  setStores(primary: ModelFileStore, fallback?: ModelFileStore): void {
    this.store = primary;
    this.fallbackStore = fallback === primary ? undefined : fallback;
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

  async status(modelId: ModelId = DEFAULT_MODEL_ID): Promise<ModelStatus> {
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
      this.kickVerify(this.store, modelId);
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
    const existing = this.downloads.get(modelId);
    if (existing) return existing.operation;

    const abort = new AbortController();
    const signal = AbortSignal.any([options.signal, abort.signal]);
    const operation = this.runDownload(modelId, signal, options.onProgress).finally(() => {
      this.downloads.delete(modelId);
    });
    this.downloads.set(modelId, { operation, abort });
    return operation;
  }

  /**
   * Hash any correctly-sized unofficial-looking files already in the primary store.
   * Used after the user picks a shared folder so an existing official GGUF is adopted
   * without hitting the network.
   */
  async adoptPresentModels(options: { signal?: AbortSignal } = {}): Promise<void> {
    const signal = options.signal ?? new AbortController().signal;
    for (const modelId of this.knownModelIds()) {
      const inspected = await this.inspect(this.store, modelId);
      if (inspected.integrity !== 'needs-hash') continue;
      await this.runVerify(this.store, modelId, signal).catch(() => undefined);
    }
  }

  async deleteModel(modelId: ModelId): Promise<void> {
    const active = this.downloads.get(modelId);
    if (active) {
      active.abort.abort();
      await active.operation.catch(() => undefined);
    }

    if (this.loaded?.id === modelId) await this.unload();

    this.errors.delete(modelId);
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

  /** Deletes the OPFS copy only. Never used automatically when a shared folder is set. */
  async deleteFallbackCopy(modelId: ModelId): Promise<void> {
    if (!this.fallbackStore) return;
    if (this.loaded?.id === modelId) {
      const source = await this.resolveReadStore(modelId);
      if (source === this.fallbackStore) await this.unload();
    }
    await this.fallbackStore.removeDirectory(this.modelDirectory(modelId));
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

  async sharedIntegrityIssue(
    modelId: ModelId,
  ): Promise<{ kind: 'size' | 'digest'; file: string } | null> {
    const inspected = await this.inspect(this.store, modelId);
    if (inspected.integrity === 'reject-size') {
      return { kind: 'size', file: this.entry(modelId).file };
    }
    if (this.errors.get(modelId) === DIGEST_MISMATCH_MESSAGE) {
      return { kind: 'digest', file: this.entry(modelId).file };
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
      const blob = await store.read(this.finalPath(modelId));
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
    this.errors.delete(modelId);

    const current = await this.inspect(this.store, modelId);
    if (current.state === 'ready' || this.loaded?.id === modelId) {
      this.notify(await this.status(modelId));
      return;
    }

    try {
      if (current.integrity === 'reject-size') {
        throw new EngineError('model-integrity', SIZE_MISMATCH_MESSAGE, { retryable: false });
      }

      if (current.integrity === 'needs-hash') {
        await this.runVerify(this.store, modelId, signal, onProgress);
        return;
      }

      await this.ensureSpace(modelId);

      const resumedBytes = await this.store.size(this.partPath(modelId));
      this.notify({
        id: modelId,
        state: 'downloading',
        received: Math.min(resumedBytes, entry.size),
        total: entry.size,
        progress: Math.min(1, resumedBytes / entry.size),
      });

      await downloadModel({
        source: { url: entry.url, size: entry.size, sha256: entry.sha256 },
        store: this.store,
        partPath: this.partPath(modelId),
        finalPath: this.finalPath(modelId),
        signal,
        attempts: 3,
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

      await this.writeVerifiedManifest(this.store, modelId);

      this.notify({
        id: modelId,
        state: 'ready',
        received: entry.size,
        total: entry.size,
        progress: 1,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.errors.set(modelId, message);
      const received = await this.store.size(this.partPath(modelId)).catch(() => 0);
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

  private kickVerify(store: ModelFileStore, modelId: ModelId): void {
    if (this.downloads.has(modelId)) return;
    void this.runVerify(store, modelId, new AbortController().signal).catch(() => undefined);
  }

  private runVerify(
    store: ModelFileStore,
    modelId: ModelId,
    signal: AbortSignal,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<void> {
    const existing = this.verifies.get(modelId);
    if (existing) return existing;
    const operation = this.verifyExisting(store, modelId, signal, onProgress).finally(() => {
      if (this.verifies.get(modelId) === operation) this.verifies.delete(modelId);
    });
    this.verifies.set(modelId, operation);
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
      this.errors.set(modelId, DIGEST_MISMATCH_MESSAGE);
      throw new EngineError('model-integrity', DIGEST_MISMATCH_MESSAGE, { retryable: false });
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
    const primary = await this.inspect(this.store, modelId);
    if (primary.integrity === 'needs-hash') {
      await this.runVerify(this.store, modelId, signal ?? new AbortController().signal).catch(
        () => undefined,
      );
      const verified = await this.inspect(this.store, modelId);
      if (verified.state === 'ready') return this.store;
    } else if (primary.state === 'ready') {
      return this.store;
    }

    if (!this.fallbackStore) return null;
    const fallback = await this.inspect(this.fallbackStore, modelId);
    if (fallback.integrity === 'needs-hash') {
      await this.runVerify(
        this.fallbackStore,
        modelId,
        signal ?? new AbortController().signal,
      ).catch(() => undefined);
      const verified = await this.inspect(this.fallbackStore, modelId);
      if (verified.state === 'ready') return this.fallbackStore;
      return null;
    }
    return fallback.state === 'ready' ? this.fallbackStore : null;
  }

  private async inspect(
    store: ModelFileStore,
    modelId: ModelId,
  ): Promise<ModelStatus & { integrity: ReturnType<typeof decideIntegrity> }> {
    const entry = this.entry(modelId);
    const [fileStat, partSize] = await Promise.all([
      store.stat(this.finalPath(modelId)),
      store.size(this.partPath(modelId)),
    ]);
    const received = Math.min(partSize, entry.size);
    const manifest = await this.readManifest(store, modelId);
    const file = fileStat ? { size: fileStat.size, lastModified: fileStat.lastModified } : null;
    const integrity = decideIntegrity(entry, file, manifest);

    if (integrity === 'verified') {
      return {
        id: modelId,
        state: 'ready',
        received: entry.size,
        total: entry.size,
        progress: 1,
        integrity,
      };
    }

    if (integrity === 'reject-size') {
      return {
        id: modelId,
        state: 'error',
        received: fileStat?.size ?? 0,
        total: entry.size,
        progress: 0,
        error: SIZE_MISMATCH_MESSAGE,
        integrity,
      };
    }

    const state: ModelState = partSize > 0 ? 'partial' : 'absent';
    return {
      id: modelId,
      state,
      received,
      total: entry.size,
      progress: received / entry.size,
      integrity,
    };
  }

  private async ensureSpace(modelId: ModelId): Promise<void> {
    const entry = this.entry(modelId);
    const estimate = await this.store.estimate();
    if (estimate.quota <= 0) return;

    const existing = await this.store.size(this.partPath(modelId));
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
    await this.writeManifest(store, modelId, {
      id: modelId,
      sha256,
      size: entry.size,
      commit: entry.commit,
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
    await store.remove(path);
    await store.append(path, TEXT_ENCODER.encode(JSON.stringify(manifest)), 0);
  }

  private notify(status: ModelStatus): void {
    try {
      this.onStatus?.(status);
    } catch {
      // Status listeners are cosmetic and must not interrupt a download.
    }
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
}
