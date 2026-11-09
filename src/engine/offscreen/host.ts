import { browser, type Browser } from 'wxt/browser';
import { hasLicenseConsent } from '@/shared/agreement';
import { lastGpuDiagnostic, probeCapabilities } from '@/shared/capabilities';
import { mergeGpuDiagnostic, type GpuDiagnostic } from '@/shared/gpu-diagnostic';
import { canonicalLanguage } from '@/shared/languages';
import type { EngineStatus, ModelStatus } from '@/shared/engine-status';
import { advanceModelStatus } from '@/shared/model-progress';
import { loadSettings } from '@/shared/storage';
import type { TierPreference } from '@/shared/settings';
import { MemoryTranslationCacheStore, IndexedDbTranslationCacheStore } from '../cache/store';
import { CachingEngine } from '../cache/caching-engine';
import { TranslationCache } from '../cache/cache';
import { prewarmRequest } from '../cache/prewarm';
import { ChromeTranslatorEngine } from '../chrome/translator';
import { isAbortError, isEngineError } from '../errors';
import {
  cpuFallback,
  lighterSelection,
  selectionAfterGpuLoss,
  selectionForTier,
  type BackendSelection,
} from '../in-browser/backend';
import { LazyInBrowserEngine } from '../in-browser/lazy-engine';
import { createWllamaRuntime, lastWebGpuLoadLog, type LlamaRuntime } from '../in-browser/runtime';
import { DEFAULT_MODEL_ID, getModel, type ModelId } from '../model/catalog';
import { OpfsModelFileStore } from '../model/file-store';
import { ModelManager, type LoadedModel } from '../model/manager';
import type { DownloadProgress } from '../model/download';
import { QUALITY_PARAGRAPH } from '../model/suggestion';
import { buildTranslationPrompt } from '../prompt/pfml3';
import { RoutingEngine, type PairSupport } from '../router';
import {
  ENGINE_HOST_PORT,
  deserializeTranslateOptions,
  errorPayload,
  isEngineHostRequest,
  type BenchmarkRequest,
  type CacheClearRequest,
  type EngineHostMessage,
  type ModelDeleteRequest,
  type ModelDownloadRequest,
  type ModelStatusRequest,
  type TierSetRequest,
  type TranslateRequest,
} from './protocol';

const IDLE_RELEASE_MS = 5 * 60 * 1000;
const WARMUP_TIMEOUT_MS = 20_000;

export interface EngineServices {
  manager: ModelManager;
  router: RoutingEngine;
  chrome: ChromeTranslatorEngine;
  lazy: LazyInBrowserEngine;
  /** Loads the active model, dropping to the CPU tier when the GPU cannot take it. */
  load: (signal: AbortSignal) => Promise<LoadedModel>;
  readonly selection: BackendSelection;
  clearCache: () => Promise<void>;
  setTier: (tier: TierPreference) => Promise<void>;
}

export interface EngineHostOptions {
  idleReleaseMs?: number;
  createServices?: () => Promise<EngineServices>;
}

interface HostRequest {
  controller: AbortController;
  port: Browser.runtime.Port | null;
  kind: 'translate' | 'download' | 'warm';
}

interface ActiveDownload {
  modelId: ModelId;
  controller: AbortController;
  operation: Promise<ModelStatus>;
  attachments: Map<string, Browser.runtime.Port>;
  status: ModelStatus | null;
}

async function openCache(): Promise<TranslationCache> {
  try {
    return new TranslationCache(await IndexedDbTranslationCacheStore.open());
  } catch {
    return new TranslationCache(new MemoryTranslationCacheStore());
  }
}

async function warmup(runtime: LlamaRuntime, tgt: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);

  try {
    const language = canonicalLanguage(tgt) ?? 'ja';
    await runtime.complete({
      prompt: buildTranslationPrompt({
        text: 'Hello.',
        src: language === 'ja' ? 'en' : 'ja',
        tgt: language,
        ...(language === 'ja' ? { form: 'polite' } : {}),
      }),
      maxTokens: 16,
      signal: controller.signal,
      onToken: () => undefined,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Adapter/device/WGSL failures will not be fixed by asking for fewer slots; skip straight
 * to CPU so the model is not loaded and discarded twice (10–24 s on a failed GPU path).
 */
export function skipRemainingWebGpuAttempts(error: unknown): boolean {
  if (!isEngineError(error)) return false;
  if (error.code === 'gpu-unavailable') return true;
  const text = `${error.detail ?? ''}\n${error.message}`;
  return /Failed to get an adapter|adapter lacks shader-f16|no adapter with shader-f16|Failed to get a device after retries|giving up on WebGPU|Error while parsing WGSL|extension 'subgroups' is not allowed|correctness probe failed|WebGPU backend disabled/iu.test(
    text,
  );
}

/**
 * Loads on the current selection and, when a GPU load fails for any reason but an abort, steps
 * down to fewer slots, then one conservative WebGPU slot, then the CPU. A missing adapter,
 * a device that failed after ggml retries, or a WGSL compile error skips the narrower loads.
 * Translation and warm-up both come through here, so neither can leave the engine without a
 * model just because WebGPU would not take it.
 */
export async function loadWithFallback(
  ensureLoaded: (selection: BackendSelection) => Promise<LoadedModel>,
  selection: BackendSelection,
  signal: AbortSignal,
): Promise<{ loaded: LoadedModel; selection: BackendSelection }> {
  let current = selection;
  for (;;) {
    try {
      return { loaded: await ensureLoaded(current), selection: current };
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      const next = skipRemainingWebGpuAttempts(error)
        ? cpuFallback(current)
        : lighterSelection(current);
      if (!next) throw error;
      current = next;
    }
  }
}

export class EngineHost {
  private readonly idleReleaseMs: number;
  private readonly openServices: () => Promise<EngineServices>;
  private servicesTask: Promise<EngineServices> | null = null;
  private readonly requests = new Map<string, HostRequest>();
  private readonly downloads = new Map<ModelId, ActiveDownload>();
  private activeModelId: ModelId = DEFAULT_MODEL_ID;
  private plamoReady = false;
  private warming = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleGeneration = 0;
  private benchmark: AbortController | null = null;
  private prewarmKey: string | null = null;
  /** The probe offered WebGPU but the model could not be placed on it. */
  private gpuFallback = false;
  private gpuDiagnostic: GpuDiagnostic | null = null;

  constructor(options: EngineHostOptions = {}) {
    this.idleReleaseMs = options.idleReleaseMs ?? IDLE_RELEASE_MS;
    this.openServices = options.createServices ?? (() => this.createServices());

    if (browser.storage?.onChanged) {
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) this.touch();
      });
    }
  }

  handlePort(port: Browser.runtime.Port): void {
    if (port.name !== ENGINE_HOST_PORT) return;
    if (port.sender?.id !== browser.runtime.id) return;
    if (port.sender?.tab) return;

    port.onMessage.addListener((message: unknown) => {
      void this.handleMessage(port, message).catch(() => undefined);
    });

    port.onDisconnect.addListener(() => {
      this.detachPort(port);
    });
  }

  async status(): Promise<EngineStatus> {
    const services = await this.services();
    return this.statusOf(services);
  }

  private services(): Promise<EngineServices> {
    if (!this.servicesTask) {
      const task = this.openServices().catch((error: unknown) => {
        if (this.servicesTask === task) this.servicesTask = null;
        throw error;
      });
      this.servicesTask = task;
    }

    return this.servicesTask;
  }

  private noteGpuError(error: unknown): void {
    const detail = isEngineError(error)
      ? (error.detail ?? error.message)
      : error instanceof Error
        ? error.message
        : String(error);
    this.gpuDiagnostic = mergeGpuDiagnostic(lastGpuDiagnostic(), detail, lastWebGpuLoadLog());
  }

  private async createServices(): Promise<EngineServices> {
    const capabilities = await probeCapabilities();
    this.gpuDiagnostic = mergeGpuDiagnostic(lastGpuDiagnostic(), null);
    const probe = {
      webgpu: capabilities.webgpu === 'ready',
      hardwareConcurrency: capabilities.hardwareConcurrency,
      fastBatches: capabilities.gpuFastBatches === true,
    };
    const stored = browser.storage?.local ? await loadSettings().catch(() => null) : null;
    const selection = selectionForTier(stored?.tier ?? 'auto', probe);
    const selectionState = { current: selection };
    const store = await OpfsModelFileStore.open();
    const manager = new ModelManager({ store, createRuntime: createWllamaRuntime });
    const cache = await openCache();
    const chrome = new ChromeTranslatorEngine();
    const load = async (signal: AbortSignal): Promise<LoadedModel> => {
      const result = await loadWithFallback(
        async (selection) => {
          try {
            return await manager.ensureLoaded(this.activeModelId, selection, { signal });
          } catch (error) {
            this.noteGpuError(error);
            throw error;
          }
        },
        selectionState.current,
        signal,
      );
      if (result.selection !== selectionState.current) {
        selectionState.current = result.selection;
        this.gpuFallback = true;
      }
      this.gpuDiagnostic = mergeGpuDiagnostic(
        lastGpuDiagnostic(),
        this.gpuDiagnostic?.error,
        lastWebGpuLoadLog(),
      );

      this.touch();
      return result.loaded;
    };
    let lastGpuLossAt = Number.NEGATIVE_INFINITY;
    const onGpuLost = async (): Promise<void> => {
      const now = Date.now();
      const next = selectionAfterGpuLoss(selectionState.current, now - lastGpuLossAt);
      lastGpuLossAt = now;
      if (next !== selectionState.current) {
        selectionState.current = next;
        this.gpuFallback = true;
      }
      this.gpuDiagnostic = mergeGpuDiagnostic(lastGpuDiagnostic(), this.gpuDiagnostic?.error);
      await manager.unload();
    };
    const lazy = new LazyInBrowserEngine({ loadRuntime: load, onGpuLost });

    const chromeForCache = chrome.available ? new CachingEngine(chrome, cache, 'chrome') : null;

    const router = new RoutingEngine({
      plamo: new CachingEngine(lazy, cache, () => this.activeModelId),
      chrome: chromeForCache,
      plamoSupports: (src, tgt) =>
        canonicalLanguage(tgt) !== null &&
        (src === undefined || src.trim().length === 0 || canonicalLanguage(src) !== null),
      chromeSupport: (segments, src, tgt) => this.chromeSupport(chrome, segments, src, tgt),
    });

    const model = await manager.status(this.activeModelId);
    this.plamoReady = model.state === 'ready' || model.state === 'loaded';

    return {
      manager,
      router,
      chrome,
      lazy,
      load,
      get selection() {
        return selectionState.current;
      },
      clearCache: () => cache.clear(),
      setTier: async (tier: TierPreference) => {
        selectionState.current = selectionForTier(tier, probe);
        this.gpuFallback = false;
        this.gpuDiagnostic = mergeGpuDiagnostic(lastGpuDiagnostic(), null);
        lazy.reset();
        await manager.unload();
      },
    };
  }

  private async chromeSupport(
    chrome: ChromeTranslatorEngine,
    segments: readonly { id: string; text: string }[],
    src: string | undefined,
    tgt: string,
  ): Promise<PairSupport> {
    if (!chrome.available) return 'unavailable';

    let source = src;
    if (!source || source.trim().length === 0) {
      const sample = segments
        .map((segment) => segment.text)
        .join('\n')
        .slice(0, 1000);
      const detected = await chrome.detect(sample);
      if (!detected) return 'unavailable';
      source = detected;
    }

    return chrome.availability(source, tgt);
  }

  private async handleMessage(port: Browser.runtime.Port, message: unknown): Promise<void> {
    if (!isEngineHostRequest(message)) return;

    switch (message.type) {
      case 'ping':
        try {
          await this.services();
          this.respond(port, message.requestId, null);
        } catch (error) {
          this.respondError(port, message.requestId, error);
        }
        return;
      case 'status':
        try {
          this.respond(port, message.requestId, await this.status());
        } catch (error) {
          this.respondError(port, message.requestId, error);
        }
        return;
      case 'translate':
        this.abortBenchmark();
        void this.handleTranslate(port, message);
        return;
      case 'cancel':
      case 'model-cancel':
        this.requests.get(message.requestId)?.controller.abort();
        this.requests.delete(message.requestId);
        return;
      case 'model-download':
        void this.handleDownload(port, message);
        return;
      case 'model-warm':
        void this.handleWarm(port, message.requestId);
        return;
      case 'model-delete':
        void this.handleDelete(port, message);
        return;
      case 'model-use':
        void this.handleUse(port, message.requestId, message.modelId);
        return;
      case 'model-status':
        void this.handleModelStatus(port, message);
        return;
      case 'cache-clear':
        void this.handleCacheClear(port, message);
        return;
      case 'tier-set':
        void this.handleTier(port, message);
        return;
      case 'benchmark':
        void this.handleBenchmark(port, message);
        return;
    }
  }

  private async handleTranslate(
    port: Browser.runtime.Port,
    request: TranslateRequest,
  ): Promise<void> {
    const controller = new AbortController();
    this.requests.set(request.requestId, { controller, port, kind: 'translate' });
    this.touch();

    try {
      const services = await this.services();
      if (controller.signal.aborted) return;

      const options = deserializeTranslateOptions(request.options, controller.signal);

      for await (const chunk of services.router.translate(request.segments, options)) {
        if (controller.signal.aborted) return;
        this.post(port, { type: 'chunk', requestId: request.requestId, chunk });
      }

      if (!controller.signal.aborted) {
        this.post(port, { type: 'done', requestId: request.requestId });
      }
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) {
        this.post(port, {
          type: 'error',
          requestId: request.requestId,
          error: errorPayload(error),
        });
      }
    } finally {
      this.requests.delete(request.requestId);
      this.touch();
    }
  }

  private async handleWarm(port: Browser.runtime.Port, requestId: string): Promise<void> {
    const controller = new AbortController();
    this.requests.set(requestId, { controller, port, kind: 'warm' });
    this.warming = true;
    this.touch();

    try {
      const services = await this.services();
      let loaded = services.manager.loadedModel;
      if (!loaded || loaded.id !== this.activeModelId) {
        loaded = await services.load(controller.signal);
      }
      try {
        await warmup(loaded.runtime, 'ja');
      } catch {
        // The short warm-up is optional; translation still runs.
      }
      this.plamoReady = true;
      this.respond(port, requestId, await services.manager.status(this.activeModelId));
      void this.prewarmFrequent(services);
    } catch (error) {
      if (!controller.signal.aborted) this.respondError(port, requestId, error);
    } finally {
      this.warming = false;
      this.requests.delete(requestId);
      this.touch();
    }
  }

  private async handleDownload(
    port: Browser.runtime.Port,
    request: ModelDownloadRequest,
  ): Promise<void> {
    const modelId = request.modelId;
    let download = this.downloads.get(modelId);
    if (!download) download = this.startDownload(modelId);

    const requestId = request.requestId;
    download.attachments.set(requestId, port);
    this.requests.set(requestId, { controller: download.controller, port, kind: 'download' });
    this.touch();

    if (download.status) {
      this.post(port, { type: 'model-progress', requestId, status: download.status });
    }

    try {
      const status = await download.operation;
      this.respond(port, requestId, status);
    } catch (error) {
      if (!download.controller.signal.aborted) this.respondError(port, requestId, error);
    } finally {
      download.attachments.delete(requestId);
      this.requests.delete(requestId);
      this.touch();
    }
  }

  private startDownload(modelId: ModelId): ActiveDownload {
    const model = getModel(modelId);
    const controller = new AbortController();
    const download: ActiveDownload = {
      modelId,
      controller,
      operation: Promise.resolve({
        id: modelId,
        state: 'absent',
        received: 0,
        total: model.size,
        progress: 0,
      }),
      attachments: new Map(),
      status: null,
    };
    this.downloads.set(modelId, download);

    download.operation = this.runDownload(download).finally(() => {
      if (this.downloads.get(modelId) === download) this.downloads.delete(modelId);
      for (const [requestId, entry] of this.requests) {
        if (entry.controller === controller) this.requests.delete(requestId);
      }
    });

    return download;
  }

  private async runDownload(download: ActiveDownload): Promise<ModelStatus> {
    const { modelId, controller } = download;

    try {
      const services = await this.services();

      if (services.manager.loadedModel?.id === modelId) {
        return services.manager.status(modelId);
      }

      await services.manager.download(modelId, {
        signal: controller.signal,
        onProgress: (progress) => {
          this.reportProgress(download, progress);
        },
      });

      const status = await services.manager.status(modelId);
      download.status = status;
      if (modelId === this.activeModelId) {
        this.plamoReady = status.state === 'ready' || status.state === 'loaded';
      }
      return status;
    } finally {
      this.touch();
    }
  }

  private reportProgress(download: ActiveDownload, progress: DownloadProgress): void {
    const status = advanceModelStatus(download.status, {
      id: download.modelId,
      state: progress.phase === 'verify' ? 'verifying' : 'downloading',
      received: progress.received,
      total: getModel(download.modelId).size,
      progress: progress.ratio,
    });
    download.status = status;

    for (const [requestId, port] of download.attachments) {
      this.post(port, { type: 'model-progress', requestId, status });
    }
  }

  private async handleDelete(
    port: Browser.runtime.Port,
    request: ModelDeleteRequest,
  ): Promise<void> {
    try {
      const services = await this.services();
      await services.manager.deleteModel(request.modelId);

      if (request.modelId === this.activeModelId) {
        services.lazy.reset();
        this.activeModelId = DEFAULT_MODEL_ID;
        const fallback = await services.manager.status(DEFAULT_MODEL_ID);
        this.plamoReady = fallback.state === 'ready' || fallback.state === 'loaded';
      }

      this.respond(port, request.requestId, await services.manager.status(request.modelId));
    } catch (error) {
      this.respondError(port, request.requestId, error);
    }
  }

  private async handleUse(
    port: Browser.runtime.Port,
    requestId: string,
    modelId: ModelId,
  ): Promise<void> {
    try {
      const services = await this.services();

      for (const [id, request] of this.requests) {
        if (request.kind !== 'warm') continue;
        request.controller.abort();
        this.requests.delete(id);
      }

      services.lazy.reset();
      await services.manager.unload();
      this.activeModelId = modelId;

      const status = await services.manager.status(modelId);
      this.plamoReady = status.state === 'ready' || status.state === 'loaded';
      this.respond(port, requestId, status);
    } catch (error) {
      this.respondError(port, requestId, error);
    }
  }

  private detachPort(port: Browser.runtime.Port): void {
    for (const [requestId, request] of this.requests) {
      if (request.port !== port) continue;
      if (request.kind === 'download') {
        request.port = null;
        continue;
      }
      request.controller.abort();
      this.requests.delete(requestId);
    }

    for (const download of this.downloads.values()) {
      for (const [requestId, attached] of download.attachments) {
        if (attached === port) download.attachments.delete(requestId);
      }
    }
  }

  private async statusOf(services: EngineServices): Promise<EngineStatus> {
    const download = this.downloads.get(this.activeModelId);
    let model = download?.status ?? (await services.manager.status(this.activeModelId));

    if (this.warming && model.state !== 'loaded') {
      model = { ...model, state: 'loading' };
    }

    this.plamoReady = model.state === 'ready' || model.state === 'loaded';
    const loaded = services.manager.loadedModel;
    const selection = loaded?.selection ?? services.selection;

    return {
      model,
      backend: selection.backend,
      tier: selection.tier,
      threads: selection.nThreads,
      parallel: selection.nParallel,
      gpuFallback: this.gpuFallback && selection.backend === 'cpu-wasm',
      ...(this.gpuDiagnostic ? { gpuDiagnostic: this.gpuDiagnostic } : {}),
      plamoReady: this.plamoReady,
      chromeSupported: services.chrome.available,
      active: services.router.activeEngine,
    };
  }

  private async handleModelStatus(
    port: Browser.runtime.Port,
    request: ModelStatusRequest,
  ): Promise<void> {
    try {
      const services = await this.services();
      const live = this.downloads.get(request.modelId)?.status;
      this.respond(
        port,
        request.requestId,
        live ?? (await services.manager.status(request.modelId)),
      );
    } catch (error) {
      this.respondError(port, request.requestId, error);
    }
  }

  private async handleCacheClear(
    port: Browser.runtime.Port,
    request: CacheClearRequest,
  ): Promise<void> {
    try {
      const services = await this.services();
      await services.clearCache();
      this.respond(port, request.requestId, null);
    } catch (error) {
      this.respondError(port, request.requestId, error);
    }
  }

  private async handleTier(port: Browser.runtime.Port, request: TierSetRequest): Promise<void> {
    try {
      const services = await this.services();
      await services.setTier(request.tier);
      this.respond(port, request.requestId, null);
    } catch (error) {
      this.respondError(port, request.requestId, error);
    }
  }

  private async handleBenchmark(
    port: Browser.runtime.Port,
    request: BenchmarkRequest,
  ): Promise<void> {
    if ([...this.requests.values()].some((entry) => entry.kind === 'translate')) {
      this.respond(port, request.requestId, null);
      return;
    }

    const controller = new AbortController();
    this.benchmark = controller;
    this.requests.set(request.requestId, { controller, port, kind: 'warm' });
    this.touch();

    try {
      const services = await this.services();
      const loaded = services.manager.loadedModel;
      if (!loaded || controller.signal.aborted) {
        this.respond(port, request.requestId, null);
        return;
      }

      const started = performance.now();
      await loaded.runtime.complete({
        prompt: buildTranslationPrompt({ text: QUALITY_PARAGRAPH, tgt: 'ja', form: 'polite' }),
        maxTokens: 512,
        signal: controller.signal,
        onToken: () => undefined,
      });
      if (controller.signal.aborted) {
        this.respond(port, request.requestId, null);
        return;
      }
      this.respond(port, request.requestId, { milliseconds: performance.now() - started });
    } catch (error) {
      if (controller.signal.aborted) this.respond(port, request.requestId, null);
      else this.respondError(port, request.requestId, error);
    } finally {
      if (this.benchmark === controller) this.benchmark = null;
      this.requests.delete(request.requestId);
      this.touch();
    }
  }

  private async prewarmFrequent(services: EngineServices): Promise<void> {
    const settings = await loadSettings().catch(() => null);
    if (!hasLicenseConsent(settings)) return;

    const request = prewarmRequest(settings.targetLanguage);
    if (!request) return;

    const key = `${this.activeModelId}|${settings.targetLanguage}|${settings.form}|${request.src}`;
    if (this.prewarmKey === key) return;
    this.prewarmKey = key;

    const controller = new AbortController();
    const requestId = `prewarm:${key}`;
    this.requests.set(requestId, { controller, port: null, kind: 'translate' });
    this.touch();

    try {
      const glossary = settings.glossary.filter(
        (entry) => entry.source.trim().length > 0 && entry.target.trim().length > 0,
      );
      for (const segment of request.segments) {
        if (controller.signal.aborted) break;
        for await (const chunk of services.router.translate([segment], {
          src: request.src,
          tgt: settings.targetLanguage,
          form: settings.form,
          priority: 99,
          signal: controller.signal,
          ...(glossary.length > 0 ? { glossary } : {}),
        })) {
          if (controller.signal.aborted) break;
          void chunk;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch {
      this.prewarmKey = null;
    } finally {
      this.requests.delete(requestId);
      this.touch();
    }
  }

  private abortBenchmark(): void {
    this.benchmark?.abort();
    this.benchmark = null;
  }

  private touch(): void {
    const generation = ++this.idleGeneration;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    void this.resolveIdleMs().then((ms) => {
      if (generation !== this.idleGeneration || ms <= 0) return;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        void this.releaseIdle();
      }, ms);
    });
  }

  private resolveIdleMs(): Promise<number> {
    if (!browser.storage?.local) return Promise.resolve(this.idleReleaseMs);
    return loadSettings()
      .then((settings) => (settings.idleMinutes === 0 ? 0 : settings.idleMinutes * 60_000))
      .catch(() => this.idleReleaseMs);
  }

  private async releaseIdle(): Promise<void> {
    if (this.requests.size > 0) {
      this.touch();
      return;
    }

    try {
      const services = await this.services();
      if (this.requests.size > 0) {
        this.touch();
        return;
      }

      services.lazy.reset();
      await services.manager.unload();
      await services.chrome.dispose();
    } catch {
      // Releasing early is best effort; the next request loads again.
    }
  }

  private respond(port: Browser.runtime.Port, requestId: string, value: unknown): void {
    this.post(port, { type: 'response', requestId, ok: true, value });
  }

  private respondError(port: Browser.runtime.Port, requestId: string, error: unknown): void {
    this.post(port, { type: 'response', requestId, ok: false, error: errorPayload(error) });
  }

  private post(port: Browser.runtime.Port, message: EngineHostMessage): void {
    try {
      port.postMessage(message);
    } catch {
      // The other end is gone; pending requests are settled by the disconnect handler.
    }
  }
}
