import { abortError, EngineError, isAbortError } from '../errors';
import type { BackendSelection } from '../in-browser/backend';
import type { LlamaRuntime } from '../in-browser/runtime';
import type { ModelState, ModelStatus } from '../../shared/engine-status';
import { DEFAULT_MODEL_ID, MODEL_CATALOG, type ModelEntry, type ModelId } from './catalog';
import { downloadModel, type DownloadProgress } from './download';
import type { ModelFileStore } from './file-store';
import type { HashOptions } from './sha256';

export interface LoadedModel {
  id: ModelId;
  runtime: LlamaRuntime;
  selection: BackendSelection;
}

export interface ModelManagerOptions {
  store: ModelFileStore;
  createRuntime: (blob: Blob, selection: BackendSelection) => Promise<LlamaRuntime>;
  fetchImpl?: typeof fetch;
  hashBlob?: (blob: Blob, options?: HashOptions) => Promise<string>;
  entries?: Readonly<Record<ModelId, ModelEntry>>;
  onStatus?: (status: ModelStatus) => void;
}

interface ModelManifest {
  id: ModelId;
  sha256: string;
  size: number;
  commit: string;
  verifiedAt: number;
}

const FREE_SPACE_MARGIN = 64 * 1024 * 1024;
const TEXT_ENCODER = new TextEncoder();

export class ModelManager {
  private readonly store: ModelFileStore;
  private readonly createRuntime: ModelManagerOptions['createRuntime'];
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly hashBlob: ((blob: Blob, options?: HashOptions) => Promise<string>) | undefined;
  private readonly entries: Readonly<Record<ModelId, ModelEntry>>;
  private readonly onStatus: ((status: ModelStatus) => void) | undefined;
  private readonly downloads = new Map<
    ModelId,
    { operation: Promise<void>; abort: AbortController }
  >();
  private readonly errors = new Map<ModelId, string>();
  private loaded: LoadedModel | null = null;
  private loadChain: Promise<void> = Promise.resolve();

  constructor(options: ModelManagerOptions) {
    this.store = options.store;
    this.createRuntime = options.createRuntime;
    this.fetchImpl = options.fetchImpl;
    this.hashBlob = options.hashBlob;
    this.entries = options.entries ?? MODEL_CATALOG;
    this.onStatus = options.onStatus;
  }

  private entry(modelId: ModelId): ModelEntry {
    return this.entries[modelId];
  }

  get loadedModel(): LoadedModel | null {
    return this.loaded;
  }

  async status(modelId: ModelId = DEFAULT_MODEL_ID): Promise<ModelStatus> {
    const entry = this.entry(modelId);
    const failure = this.errors.get(modelId);
    const [fileSize, partSize] = await Promise.all([
      this.store.size(this.finalPath(modelId)),
      this.store.size(this.partPath(modelId)),
    ]);
    const received = Math.min(partSize, entry.size);

    if (this.loaded?.id === modelId) {
      return { id: modelId, state: 'loaded', received: entry.size, total: entry.size, progress: 1 };
    }

    if (failure) {
      return {
        id: modelId,
        state: 'error',
        received,
        total: entry.size,
        progress: received / entry.size,
        error: failure,
      };
    }

    const manifest = await this.readManifest(modelId);
    if (
      manifest &&
      manifest.sha256 === entry.sha256 &&
      manifest.size === entry.size &&
      fileSize === entry.size
    ) {
      return { id: modelId, state: 'ready', received: entry.size, total: entry.size, progress: 1 };
    }

    const state: ModelState = partSize > 0 ? 'partial' : 'absent';
    return {
      id: modelId,
      state,
      received,
      total: entry.size,
      progress: received / entry.size,
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

      const status = await this.status(modelId);
      if (status.state !== 'ready') {
        throw new EngineError('model-missing', 'The translation model is not downloaded yet.');
      }

      this.notify({ ...status, state: 'loading' });
      const blob = await this.store.read(this.finalPath(modelId));
      const runtime = await this.createRuntime(blob, selection);
      const loaded: LoadedModel = { id: modelId, runtime, selection };
      this.loaded = loaded;
      this.notify({ ...status, state: 'loaded' });
      return loaded;
    };

    const result = this.loadChain.then(run, run);
    this.loadChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runDownload(
    modelId: ModelId,
    signal: AbortSignal,
    onProgress: ((progress: DownloadProgress) => void) | undefined,
  ): Promise<void> {
    const entry = this.entry(modelId);
    this.errors.delete(modelId);

    const current = await this.status(modelId);
    if (current.state === 'ready' || current.state === 'loaded') {
      this.notify(current);
      return;
    }

    try {
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

      await this.writeManifest(modelId, {
        id: modelId,
        sha256: entry.sha256,
        size: entry.size,
        commit: entry.commit,
        verifiedAt: Date.now(),
      });

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

  private async readManifest(modelId: ModelId): Promise<ModelManifest | null> {
    try {
      const blob = await this.store.read(this.manifestPath(modelId));
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
      };
    } catch {
      return null;
    }
  }

  private async writeManifest(modelId: ModelId, manifest: ModelManifest): Promise<void> {
    const path = this.manifestPath(modelId);
    await this.store.remove(path);
    await this.store.append(path, TEXT_ENCODER.encode(JSON.stringify(manifest)), 0);
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
