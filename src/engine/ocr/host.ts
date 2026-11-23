import { abortError, isAbortError } from '@/engine/errors';
import { AssetManager } from '@/engine/model/asset-manager';
import type { AssetStatus } from '@/engine/model/asset';
import { OpfsModelFileStore, type ModelFileStore } from '@/engine/model/file-store';
import { DEFAULT_OCR_TIER, OCR_TIER_CATALOG, SELECTABLE_OCR_TIERS, type OcrTier } from './catalog';
import type { DecodedOcrImage } from './codec';

export interface OcrRuntimeLike {
  recognize(image: DecodedOcrImage, signal: AbortSignal): Promise<unknown>;
  release(): void | Promise<void>;
}

export interface OcrHostOptions {
  hasConsent?: () => boolean;
  onStatus?: (status: AssetStatus<OcrTier>) => void;
  createAssetManager?: () => Promise<AssetManager<OcrTier>>;
  /** Resolves the current shared folder or browser storage when the host is first used. */
  createAssetStore?: () => Promise<ModelFileStore>;
  createRuntime?: (
    assets: AssetManager<OcrTier>,
    tier: OcrTier,
    signal: AbortSignal,
  ) => Promise<OcrRuntimeLike>;
}

interface OcrRequest {
  tier: OcrTier;
  controller: AbortController;
}

/** Lazy OCR owner. Constructing it does not initialize translation or ONNX Runtime. */
export class OcrHost {
  private readonly options: OcrHostOptions;
  private assetsTask: Promise<AssetManager<OcrTier>> | null = null;
  private runtimeTask: Promise<OcrRuntimeLike> | null = null;
  private runtimeTier: OcrTier | null = null;
  private runtime: OcrRuntimeLike | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly requests = new Map<string, OcrRequest>();
  /** A folder change arrived while requests were still bound to the previous store. */
  private pendingRefresh = false;
  /** Folder adoption moves verified browser bundles; switching back only copies them. */
  private pendingRemoveSource = false;
  private refreshing = false;
  private readonly refreshWaiters: Array<() => void> = [];

  constructor(options: OcrHostOptions = {}) {
    this.options = options;
  }

  async status(tier: OcrTier = DEFAULT_OCR_TIER): Promise<AssetStatus<OcrTier>> {
    if ((this.runtime || this.runtimeTask) && this.runtimeTier === tier) {
      const entry = OCR_TIER_CATALOG[tier];
      return {
        id: tier,
        state: this.runtime ? 'loaded' : 'loading',
        received: entry.size,
        total: entry.size,
        progress: 1,
      };
    }
    return (await this.assets()).status(tier);
  }

  recognize(
    requestId: string,
    tier: OcrTier,
    image: DecodedOcrImage,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = this.track(requestId, tier, signal);
    const operation = this.queue.then(async () => {
      if (controller.signal.aborted) throw abortError();
      const runtime = await this.loadRuntime(tier, controller.signal);
      if (controller.signal.aborted) throw abortError();
      return runtime.recognize(image, controller.signal);
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) throw abortError();
        throw error;
      })
      .finally(() => {
        this.untrack(requestId, controller);
        this.settleRefresh();
      });
  }

  async download(requestId: string, tier: OcrTier): Promise<AssetStatus<OcrTier>> {
    const controller = this.track(requestId, tier);
    try {
      const assets = await this.assets();
      await assets.download(tier, { signal: controller.signal });
      return this.status(tier);
    } finally {
      this.untrack(requestId, controller);
      this.settleRefresh();
    }
  }

  async delete(tier: OcrTier): Promise<AssetStatus<OcrTier>> {
    for (const [id, request] of this.requests) {
      if (request.tier !== tier) continue;
      request.controller.abort();
      this.requests.delete(id);
    }
    // The serialized queue always settles, including cancelled inference. Do not release an
    // ORT session while its native run is still using the session handle.
    await this.queue;
    if (this.runtimeTier === tier) await this.releaseRuntime();
    const assets = await this.assets();
    await assets.delete(tier);
    return assets.status(tier);
  }

  cancel(requestId: string): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    request.controller.abort();
    this.requests.delete(requestId);
    void this.assetsTask?.then((assets) => assets.cancel(request.tier));
  }

  /**
   * Re-resolve storage after the shared folder changed. An active download/recognition is
   * left on its original store: swapping files underneath an ORT session or a ranged
   * transfer would be worse than letting it finish. The refresh is deferred until the last
   * request settles, and callers wait for it so no stale manager survives the folder switch.
   *
   * Verified bundles follow the folder: adopting it moves the browser copies into it, while
   * switching back copies the folder files into OPFS and leaves the shared files in place
   * (see PRIVACY.md and docs/design/shared-model-folder.md).
   */
  async refreshStore(options: { removeSource?: boolean } = {}): Promise<void> {
    this.pendingRemoveSource ||= options.removeSource === true;
    if (this.requests.size === 0 && !this.refreshing) {
      await this.applyRefresh();
      return;
    }
    this.pendingRefresh = true;
    await new Promise<void>((resolve) => {
      this.refreshWaiters.push(resolve);
    });
  }

  /** Applies a refresh queued while requests were still using the previous store. */
  private settleRefresh(): void {
    if (!this.pendingRefresh || this.refreshing || this.requests.size > 0) return;
    void this.applyRefresh();
  }

  private async applyRefresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.pendingRefresh = false;
    const stale = this.assetsTask;
    const removeSource = this.pendingRemoveSource;
    this.pendingRemoveSource = false;
    try {
      // Wait for queued inference first: releasing an ORT session while its native run is
      // still using the handle is worse than finishing the run on the old store.
      await this.queue;
      await this.releaseRuntime();
      // A newer request may have re-created the manager while the runtime was releasing.
      // Only touch the manager that predates this refresh.
      if (this.assetsTask === stale) {
        if (stale) {
          try {
            const previous = await stale;
            const current = await this.createAssets();
            for (const tier of SELECTABLE_OCR_TIERS) {
              try {
                await previous.copyToStore(tier, current.fileStore, { removeSource });
              } catch {
                // Keep a tier in its old store when its copy cannot be verified. It can be
                // downloaded again; deleting it here could lose the only working bundle.
              }
            }
          } catch {
            // The new store may be blocked (a linked folder without a grant). The old files
            // stay put, and status() surfaces the storage error on the next request.
          }
        }
        this.assetsTask = null;
      }
    } finally {
      this.refreshing = false;
      this.pendingRefresh = false;
      const waiters = this.refreshWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  private track(requestId: string, tier: OcrTier, signal?: AbortSignal): AbortController {
    this.cancel(requestId);
    const controller = new AbortController();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', () => controller.abort(), { once: true });
    this.requests.set(requestId, { tier, controller });
    return controller;
  }

  private untrack(requestId: string, controller: AbortController): void {
    if (this.requests.get(requestId)?.controller === controller) this.requests.delete(requestId);
  }

  private assets(): Promise<AssetManager<OcrTier>> {
    if (!this.assetsTask) this.assetsTask = this.createAssets();
    return this.assetsTask;
  }

  /** Resolves the current store without caching, so a refresh can migrate into it. */
  private createAssets(): Promise<AssetManager<OcrTier>> {
    return this.options.createAssetManager
      ? this.options.createAssetManager()
      : (this.options.createAssetStore?.() ?? OpfsModelFileStore.open()).then(
          (store) =>
            new AssetManager<OcrTier>({
              store,
              bundles: OCR_TIER_CATALOG,
              ...(this.options.hasConsent ? { hasConsent: this.options.hasConsent } : {}),
              ...(this.options.onStatus ? { onStatus: this.options.onStatus } : {}),
            }),
        );
  }

  private async loadRuntime(tier: OcrTier, signal: AbortSignal): Promise<OcrRuntimeLike> {
    if (this.runtime && this.runtimeTier === tier) return this.runtime;
    if (this.runtimeTask && this.runtimeTier === tier) return this.runtimeTask;
    await this.releaseRuntime();
    this.runtimeTier = tier;
    this.runtimeTask = (async () => {
      const assets = await this.assets();
      if (!this.options.createRuntime) {
        const { OcrRuntime } = await import('./runtime');
        return OcrRuntime.create(assets, tier, signal);
      }
      return this.options.createRuntime(assets, tier, signal);
    })();
    try {
      const runtime = await this.runtimeTask;
      if (signal.aborted) {
        await runtime.release();
        throw abortError();
      }
      this.runtime = runtime;
      return runtime;
    } catch (error) {
      this.runtimeTask = null;
      this.runtimeTier = null;
      throw error;
    }
  }

  private async releaseRuntime(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = null;
    this.runtimeTask = null;
    this.runtimeTier = null;
    if (runtime) await runtime.release();
  }
}
