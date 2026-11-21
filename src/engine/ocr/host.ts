import { abortError, isAbortError } from '@/engine/errors';
import { AssetManager } from '@/engine/model/asset-manager';
import type { AssetStatus } from '@/engine/model/asset';
import { OpfsModelFileStore, type ModelFileStore } from '@/engine/model/file-store';
import { DEFAULT_OCR_TIER, OCR_TIER_CATALOG, type OcrTier } from './catalog';
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
      .finally(() => this.untrack(requestId, controller));
  }

  async download(requestId: string, tier: OcrTier): Promise<AssetStatus<OcrTier>> {
    const controller = this.track(requestId, tier);
    try {
      const assets = await this.assets();
      await assets.download(tier, { signal: controller.signal });
      return this.status(tier);
    } finally {
      this.untrack(requestId, controller);
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
   * left on its original store: switching files underneath an ORT session or a ranged
   * transfer would be worse than finishing on the store that started it.
   */
  async refreshStore(): Promise<void> {
    if (this.requests.size > 0) return;
    await this.releaseRuntime();
    this.assetsTask = null;
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
    if (!this.assetsTask) {
      this.assetsTask = this.options.createAssetManager
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
    return this.assetsTask;
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
