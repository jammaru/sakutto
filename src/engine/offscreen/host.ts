import { browser, type Browser } from 'wxt/browser';
import { hasLicenseConsent } from '@/shared/agreement';
import { lastGpuDiagnostic, probeCapabilities } from '@/shared/capabilities';
import { mergeGpuDiagnostic, type GpuDiagnostic } from '@/shared/gpu-diagnostic';
import { canonicalLanguage, type TargetLanguage } from '@/shared/languages';
import {
  modelCanTranslate,
  type EngineSource,
  type EngineStatus,
  type ModelStatus,
} from '@/shared/engine-status';
import { advanceModelStatus } from '@/shared/model-progress';
import { loadSettings, saveSettings } from '@/shared/storage';
import type { Formality, IdleMinutes, Settings, TierPreference } from '@/shared/settings';
import { MemoryTranslationCacheStore, IndexedDbTranslationCacheStore } from '../cache/store';
import { CachingEngine } from '../cache/caching-engine';
import { TranslationCache } from '../cache/cache';
import { prewarmRequest } from '../cache/prewarm';
import { ChromeTranslatorEngine } from '../chrome/translator';
import { EngineError, abortError, isAbortError, isEngineError, modelChangedError } from '../errors';
import {
  cpuFallback,
  isGpuLoadFallback,
  lighterSelection,
  selectionAfterGpuLoss,
  selectionForTier,
  type BackendSelection,
} from '../in-browser/backend';
import { InBrowserEngine } from '../in-browser/engine';
import { LazyInBrowserEngine } from '../in-browser/lazy-engine';
import { createWllamaRuntime, lastWebGpuLoadLog, type LlamaRuntime } from '../in-browser/runtime';
import { localServerConfigFromSettings, type LocalServerConfig } from '../local-server/client';
import { LocalServerRuntime } from '../local-server/runtime';
import { PlamoSourceEngine } from '../local-server/source';
import { JobScheduler } from '../queue/scheduler';
import { DEFAULT_MODEL_ID, SELECTABLE_MODEL_IDS, getModel, type ModelId } from '../model/catalog';
import { normalizeSelectedModelId, resolveActiveModel } from '../model/selection';
import { OpfsModelFileStore } from '../model/file-store';
import { ModelManager, type LoadedModel } from '../model/manager';
import type { DownloadProgress } from '../model/download';
import { QUALITY_PARAGRAPH } from '../model/suggestion';
import { buildTranslationPrompt, cleanModelOutput } from '../prompt/pfml3';
import { isBrokenTranslation } from '../text/degenerate';
import { RoutingEngine, type PairSupport } from '../router';
import type { GlossaryEntry } from '../types';
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
  type ModelSetRequest,
  type ModelStatusRequest,
  type RuntimeSetRequest,
  type SourceSetRequest,
  type TierSetRequest,
  type TranslateRequest,
} from './protocol';

const IDLE_RELEASE_MS = 5 * 60 * 1000;
const WARMUP_TIMEOUT_MS = 20_000;
/**
 * Extra CPU wllama copy used to retry a collapsed WebGPU piece. About +0.6GB.
 * Kept only while a page is still translating, then dropped so a healthy GPU
 * session does not pin two model copies for the full `idleMinutes`. Reloading
 * it on a later hit costs a few seconds; reusing the loaded CPU runtime avoids
 * the copy entirely.
 */
export const RETRY_RUNTIME_IDLE_MS = 60_000;

interface RuntimePrefs {
  idleMinutes: IdleMinutes;
  tier: TierPreference;
  targetLanguage: TargetLanguage;
  form: Formality;
  glossary: GlossaryEntry[];
  consented: boolean;
}

function idleHoldMs(minutes: IdleMinutes): number {
  return minutes === 0 ? 0 : minutes * 60_000;
}

/**
 * True when the loaded runtime can retry a collapsed piece itself. A second
 * wllama instance is only created while WebGPU is still the live backend.
 */
export function canReuseLoadedRuntimeForRetry(
  loaded: LoadedModel | null,
  activeModelId: ModelId,
): boolean {
  return loaded !== null && loaded.id === activeModelId && loaded.runtime.backend !== 'webgpu';
}

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
  disposeRetryRuntime?: () => Promise<void>;
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

export async function warmup(
  runtime: LlamaRuntime,
  tgt: string,
  signal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort);
  let output = '';

  try {
    if (signal?.aborted) throw abortError();
    const language = canonicalLanguage(tgt) ?? 'ja';
    const result = await runtime.complete({
      prompt: buildTranslationPrompt({
        text: 'Hello.',
        src: language === 'ja' ? 'en' : 'ja',
        tgt: language,
        ...(language === 'ja' ? { form: 'polite' } : {}),
      }),
      maxTokens: 16,
      signal: controller.signal,
      onToken: (token) => {
        output += token;
      },
    });
    const hitMaxTokens = result?.hitMaxTokens === true;
    const broken =
      isBrokenTranslation('Hello.', output, hitMaxTokens) ||
      isBrokenTranslation('Hello.', cleanModelOutput(output), hitMaxTokens);
    if (broken) {
      throw new EngineError(
        runtime.backend === 'webgpu' ? 'gpu-unavailable' : 'model-load-failed',
        'The model repeated one token during warm-up.',
        { detail: 'degenerate warmup', retryable: runtime.backend === 'webgpu' },
      );
    }
  } catch (error) {
    if (signal?.aborted) throw abortError();
    // The timer gave up. Translation still runs, and a repeated token there is rejected.
    if (isAbortError(error)) return;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function isDegenerateWarmup(error: unknown): boolean {
  return isEngineError(error) && error.detail === 'degenerate warmup';
}

/**
 * Adapter/device/WGSL failures will not be fixed by asking for fewer slots; skip straight
 * to CPU so the model is not loaded and discarded twice (10–24 s on a failed GPU path).
 */
export function skipRemainingWebGpuAttempts(error: unknown): boolean {
  if (!isEngineError(error)) return false;
  if (error.code === 'gpu-unavailable') return true;
  const text = `${error.detail ?? ''}\n${error.message}`;
  return /Failed to get an adapter|adapter lacks shader-f16|no adapter with shader-f16|Failed to get a device after retries|giving up on WebGPU|Error while parsing WGSL|extension 'subgroups' is not allowed|correctness probe failed|WebGPU backend disabled|degenerate warmup/iu.test(
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
  private readonly ports = new Set<Browser.runtime.Port>();
  private activeModelId: ModelId = DEFAULT_MODEL_ID;
  /** Set by `model-set` before services exist, so the first restore uses the saved id. */
  private preferredModelId: ModelId | null = null;
  /** Present only when this document can read `chrome.storage` (Firefox's engine frame). */
  private storedModelId: ModelId | null = null;
  private runtimePrefs: RuntimePrefs | null = null;
  private selectionChain: Promise<void> = Promise.resolve();
  private modelFallback = false;
  private plamoReady = false;
  private warming = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleGeneration = 0;
  private retryIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private benchmark: AbortController | null = null;
  private prewarmKey: string | null = null;
  /** Resolves when an in-flight model switch has published the new id and finished unload. */
  private switchTask: Promise<void> = Promise.resolve();
  /** The probe offered WebGPU but the model could not be placed on it. */
  private gpuFallback = false;
  private gpuDiagnostic: GpuDiagnostic | null = null;
  private engineSource: EngineSource = 'in-browser';
  private localConfig: LocalServerConfig = localServerConfigFromSettings(null);
  private localScheduler: JobScheduler | null = null;

  constructor(options: EngineHostOptions = {}) {
    this.idleReleaseMs = options.idleReleaseMs ?? IDLE_RELEASE_MS;
    this.openServices = options.createServices ?? (() => this.createServices());

    if (browser.storage?.onChanged) {
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) {
          void this.onSettingsChanged();
        }
      });
    }
  }

  handlePort(port: Browser.runtime.Port): void {
    if (port.name !== ENGINE_HOST_PORT) return;
    if (port.sender?.id !== browser.runtime.id) return;
    if (port.sender?.tab) return;

    this.ports.add(port);
    port.onMessage.addListener((message: unknown) => {
      void this.handleMessage(port, message).catch(() => undefined);
    });

    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
      this.detachPort(port);
    });
  }

  async status(): Promise<EngineStatus> {
    const services = await this.services();
    return this.statusOf(services);
  }

  private services(): Promise<EngineServices> {
    if (!this.servicesTask) {
      const task = this.openServices()
        .then(async (services) => {
          await this.restorePreferred(services);
          return services;
        })
        .catch((error: unknown) => {
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
      sharedMemory: capabilities.crossOriginIsolated,
    };
    const stored = browser.storage?.local ? await loadSettings().catch(() => null) : null;
    // Chrome's offscreen document has no chrome.storage. The service worker pushes
    // engineSource, the selected model, and the idle/prewarm snapshot. A record read
    // here only exists where storage is actually available (Firefox's engine frame).
    if (stored) this.applyStoredSettings(stored);
    this.storedModelId = stored ? normalizeSelectedModelId(stored.selectedModelId) : null;
    const tier = stored?.tier ?? this.runtimePrefs?.tier ?? 'auto';
    const selection = selectionForTier(tier, probe);
    const selectionState = { current: selection };
    const store = await OpfsModelFileStore.open();
    const manager = new ModelManager({ store, createRuntime: createWllamaRuntime });
    const cache = await openCache();
    const chrome = new ChromeTranslatorEngine();
    const load = async (signal: AbortSignal): Promise<LoadedModel> => {
      const result = await loadWithFallback(
        async (selection) => {
          try {
            // Warm-up is not run here. A Hello. completion before the first page
            // changed parallel-slot batching and later greedy decoding (garbled
            // p15 on the second translate of a session). Kernel collapse is
            // caught on the first real piece and by handleWarm.
            return await manager.ensureLoaded(this.activeModelId, selection, { signal });
          } catch (error) {
            this.noteGpuError(error);
            throw error;
          }
        },
        selectionState.current,
        signal,
      );
      if (isGpuLoadFallback(selectionState.current, result.selection)) {
        this.gpuFallback = true;
      }
      selectionState.current = result.selection;
      this.gpuDiagnostic = mergeGpuDiagnostic(
        lastGpuDiagnostic(),
        this.gpuDiagnostic?.error,
        lastWebGpuLoadLog(),
      );

      this.touch();
      return result.loaded;
    };
    let lastGpuLossAt = Number.NEGATIVE_INFINITY;
    let cpuRetryRuntime: LlamaRuntime | null = null;
    let cpuRetryTask: Promise<LlamaRuntime | null> | null = null;
    const disposeCpuRetry = async (): Promise<void> => {
      const runtime = cpuRetryRuntime;
      cpuRetryRuntime = null;
      cpuRetryTask = null;
      if (runtime) await runtime.dispose().catch(() => undefined);
    };
    const loadRetryRuntime = async (signal: AbortSignal): Promise<LlamaRuntime | null> => {
      const loaded = manager.loadedModel;
      if (canReuseLoadedRuntimeForRetry(loaded, this.activeModelId) && loaded) {
        return loaded.runtime;
      }
      if (cpuRetryRuntime) return cpuRetryRuntime;
      if (cpuRetryTask) return cpuRetryTask;
      const cpu = cpuFallback(selectionState.current);
      if (!cpu) return null;
      if (signal.aborted) throw abortError();
      cpuRetryTask = (async () => {
        const blob = await manager.modelBlob(this.activeModelId);
        cpuRetryRuntime = await createWllamaRuntime(blob, cpu);
        return cpuRetryRuntime;
      })().finally(() => {
        cpuRetryTask = null;
      });
      return cpuRetryTask;
    };
    const onGpuLost = async (reason: 'lost' | 'degenerate' = 'lost'): Promise<void> => {
      if (reason === 'degenerate') {
        const next = cpuFallback(selectionState.current);
        if (next && next !== selectionState.current) {
          if (isGpuLoadFallback(selectionState.current, next)) this.gpuFallback = true;
          selectionState.current = next;
        }
        this.gpuDiagnostic = mergeGpuDiagnostic(
          lastGpuDiagnostic(),
          'degenerate output',
          lastWebGpuLoadLog(),
        );
        await disposeCpuRetry();
        await manager.unload();
        return;
      }
      const now = Date.now();
      const next = selectionAfterGpuLoss(selectionState.current, now - lastGpuLossAt);
      lastGpuLossAt = now;
      if (next !== selectionState.current) {
        if (isGpuLoadFallback(selectionState.current, next)) {
          this.gpuFallback = true;
        }
        selectionState.current = next;
      }
      this.gpuDiagnostic = mergeGpuDiagnostic(lastGpuDiagnostic(), this.gpuDiagnostic?.error);
      await disposeCpuRetry();
      await manager.unload();
    };
    const lazy = new LazyInBrowserEngine({ loadRuntime: load, loadRetryRuntime, onGpuLost });
    const localRuntime = new LocalServerRuntime(() => this.localConfig);
    this.localScheduler = new JobScheduler(localRuntime.parallel, false);
    const localEngine = new InBrowserEngine(localRuntime, { scheduler: this.localScheduler });
    const plamo = new PlamoSourceEngine(lazy, localEngine, () => this.engineSource);

    const chromeForCache = chrome.available
      ? new CachingEngine(chrome, cache, 'chrome', 'chrome')
      : null;

    const router = new RoutingEngine({
      plamo: new CachingEngine(
        plamo,
        cache,
        () => this.cacheModelId(),
        () =>
          this.engineSource === 'local-server' ? 'local-server' : selectionState.current.backend,
      ),
      chrome: chromeForCache,
      plamoSupports: (src, tgt) =>
        canonicalLanguage(tgt) !== null &&
        (src === undefined || src.trim().length === 0 || canonicalLanguage(src) !== null),
      chromeSupport: (segments, src, tgt) => this.chromeSupport(chrome, segments, src, tgt),
    });

    const model = await manager.status(this.activeModelId);
    this.plamoReady = modelCanTranslate(model);

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
        await disposeCpuRetry();
        await manager.unload();
      },
      disposeRetryRuntime: disposeCpuRetry,
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
      case 'source-set':
        void this.handleSource(port, message);
        return;
      case 'model-set':
        void this.handleModelSet(port, message);
        return;
      case 'runtime-set':
        this.handleRuntime(port, message);
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
    await this.switchTask;
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

      if (controller.signal.aborted) return;
      this.post(port, { type: 'done', requestId: request.requestId });
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
    await this.switchTask;
    const controller = new AbortController();
    this.requests.set(requestId, { controller, port, kind: 'warm' });
    this.warming = true;
    this.touch();

    try {
      const services = await this.services();
      if (controller.signal.aborted) return;
      if (this.engineSource === 'local-server') {
        this.plamoReady = true;
        this.respond(port, requestId, await services.manager.status(this.activeModelId));
        return;
      }
      let loaded = services.manager.loadedModel;
      if (!loaded || loaded.id !== this.activeModelId) {
        loaded = await services.load(controller.signal);
      }
      if (controller.signal.aborted) return;
      try {
        await warmup(loaded.runtime, 'ja', controller.signal);
      } catch (error) {
        if (isDegenerateWarmup(error) || controller.signal.aborted) throw error;
      }
      if (controller.signal.aborted) return;
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
        this.plamoReady = modelCanTranslate(status);
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
        await this.applyResolvedModel(services.manager, this.activeModelId, true);
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
        this.abortLiveRequest(id, request);
      }

      services.lazy.reset();
      await services.disposeRetryRuntime?.();
      await services.manager.unload();
      this.activeModelId = modelId;
      this.modelFallback = false;
      await this.persistActiveModel();

      const status = await services.manager.status(modelId);
      this.plamoReady = modelCanTranslate(status);
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

    this.plamoReady = modelCanTranslate(model);
    const loaded = services.manager.loadedModel;
    const selection = loaded?.selection ?? services.selection;
    const local = this.engineSource === 'local-server';

    return {
      model,
      backend: local ? 'local-server' : selection.backend,
      tier: local ? null : selection.tier,
      threads: local ? 1 : selection.nThreads,
      parallel: local ? this.localConfig.parallel : selection.nParallel,
      gpuFallback: this.gpuFallback && selection.backend === 'cpu-wasm',
      ...(this.gpuDiagnostic ? { gpuDiagnostic: this.gpuDiagnostic } : {}),
      plamoReady: local ? true : this.plamoReady,
      chromeSupported: services.chrome.available,
      active: services.router.activeEngine,
      engineSource: this.engineSource,
      ...(this.modelFallback ? { modelFallback: true } : {}),
    };
  }

  private cacheModelId(): string {
    if (this.engineSource !== 'local-server') return this.activeModelId;
    return `local:${this.localConfig.model.length > 0 ? this.localConfig.model : 'default'}`;
  }

  private applyStoredSettings(stored: Settings | null): void {
    this.applySource(stored?.engineSource ?? 'in-browser', localServerConfigFromSettings(stored));
  }

  private applySource(source: EngineSource, config: LocalServerConfig): void {
    const previous = this.engineSource;
    this.engineSource = source;
    this.localConfig = config;
    this.localScheduler?.setConcurrency(config.parallel);
    if (previous === 'in-browser' && source === 'local-server' && this.servicesTask) {
      void this.unloadInBrowserRuntime();
    }
  }

  private async unloadInBrowserRuntime(): Promise<void> {
    try {
      const services = await this.services();
      services.lazy.reset();
      await services.disposeRetryRuntime?.();
      await services.manager.unload();
    } catch {
      // Unloading the in-browser runtime is best effort when switching away.
    }
  }

  private async handleSource(port: Browser.runtime.Port, request: SourceSetRequest): Promise<void> {
    this.applySource(request.engineSource, {
      baseUrl: request.localServer.url,
      model: request.localServer.model,
      apiKey: request.localServer.apiKey,
      timeoutMs: request.localServer.timeoutMs,
      allowRemote: request.localServer.allowRemote,
      parallel: request.localServer.parallel,
    });
    this.respond(port, request.requestId, null);
    this.touch();
  }

  private async handleModelSet(
    port: Browser.runtime.Port,
    request: ModelSetRequest,
  ): Promise<void> {
    this.preferredModelId = request.modelId;
    try {
      // A document that is already running must switch now, including dropping the
      // loaded runtime so the next translation cannot keep the old weights while
      // status and cache keys already name the new id. A new document records
      // the id and applies it when services() first opens, which is after this
      // response, so connecting does not wait on the GPU probe.
      if (this.servicesTask) {
        const services = await this.services();
        if (this.preferredModelId === request.modelId) {
          await this.applyResolvedModel(services.manager, request.modelId, false, services);
        }
      }
      this.respond(port, request.requestId, null);
    } catch (error) {
      this.respondError(port, request.requestId, error);
    }
  }

  private handleRuntime(port: Browser.runtime.Port, request: RuntimeSetRequest): void {
    // Idle, tier, and prewarm inputs only. The selected model is pushed separately
    // with `model-set`; a settings change must not restore a stale id over it.
    this.runtimePrefs = {
      idleMinutes: request.idleMinutes,
      tier: request.tier,
      targetLanguage: request.targetLanguage,
      form: request.form,
      glossary: request.glossary.map((entry) => ({ source: entry.source, target: entry.target })),
      consented: request.consented,
    };
    this.respond(port, request.requestId, null);
    this.touch();
  }

  private async onSettingsChanged(): Promise<void> {
    const stored = await loadSettings().catch(() => null);
    this.applyStoredSettings(stored);
    this.touch();
  }

  private async restorePreferred(services: EngineServices): Promise<void> {
    const preferred = this.preferredModelId ?? this.storedModelId ?? DEFAULT_MODEL_ID;
    await this.applyResolvedModel(services.manager, preferred, false);
  }

  private applyResolvedModel(
    manager: ModelManager,
    preferred: ModelId,
    persist: boolean,
    runtime?: EngineServices,
  ): Promise<void> {
    const run = this.selectionChain.then(() =>
      this.resolveAndApply(manager, preferred, persist, runtime),
    );
    this.selectionChain = run.catch(() => undefined);
    return run;
  }

  private async resolveAndApply(
    manager: ModelManager,
    preferred: ModelId,
    persist: boolean,
    runtime?: EngineServices,
  ): Promise<void> {
    const statuses = await Promise.all(
      SELECTABLE_MODEL_IDS.map((modelId) => manager.status(modelId)),
    );
    const resolved = resolveActiveModel(preferred, statuses);
    const changed = resolved.modelId !== this.activeModelId;
    if (changed && runtime) {
      const switchRun = this.runModelSwitch(runtime, resolved, statuses, persist);
      this.switchTask = switchRun.catch(() => undefined);
      await switchRun;
      return;
    }
    this.activeModelId = resolved.modelId;
    this.modelFallback = resolved.fallback;
    const active = statuses.find((status) => status.id === resolved.modelId);
    this.plamoReady = active ? modelCanTranslate(active) : false;
    if (persist || resolved.fallback) await this.persistActiveModel();
  }

  /**
   * Abort in-flight controllers, drop the lazy runtime, publish the new id, then
   * tell callers the previous work is gone (`model-changed`). Unload may yield;
   * `handleTranslate` waits on `switchTask` so a retry cannot snapshot the old
   * id or call `ensureLoaded(old)` after `lazy.reset()`.
   */
  private async runModelSwitch(
    runtime: EngineServices,
    resolved: { modelId: ModelId; fallback: boolean },
    statuses: readonly ModelStatus[],
    persist: boolean,
  ): Promise<void> {
    const live: Array<[string, HostRequest]> = [];
    this.abortBenchmark();
    this.warming = false;
    this.prewarmKey = null;
    for (const [id, request] of this.requests) {
      if (request.kind === 'download') continue;
      request.controller.abort();
      live.push([id, request]);
    }

    runtime.lazy.reset();
    await runtime.disposeRetryRuntime?.();
    this.activeModelId = resolved.modelId;
    this.modelFallback = resolved.fallback;
    const active = statuses.find((status) => status.id === resolved.modelId);
    this.plamoReady = active ? modelCanTranslate(active) : false;

    for (const [id, request] of live) this.failLiveForModelChange(id, request);
    if (persist || resolved.fallback) await this.persistActiveModel();
    await runtime.manager.unload();
  }

  /**
   * Drop in-flight translate/warm work before the loaded runtime is replaced.
   * The caller still has a ChunkStream (or a pending warm round-trip) open, so
   * each request gets an `error` / failed response; a silent abort would hang
   * the client. A client-initiated cancel already ended its stream and ignores
   * a late error.
   */
  private abortLiveRequest(id: string, request: HostRequest): void {
    request.controller.abort();
    this.failLiveForModelChange(id, request);
  }

  private failLiveForModelChange(id: string, request: HostRequest): void {
    if (request.port) {
      const error = modelChangedError();
      if (request.kind === 'translate') {
        this.post(request.port, {
          type: 'error',
          requestId: id,
          error: errorPayload(error),
        });
      } else if (request.kind === 'warm') {
        this.respondError(request.port, id, error);
      }
    }
    this.requests.delete(id);
  }

  /**
   * Chrome's offscreen document has no `chrome.storage`. Post the choice on the
   * engine port so the service worker, which does have storage, can save it.
   * Firefox's engine frame writes directly.
   */
  private async persistActiveModel(): Promise<void> {
    if (browser.storage?.local) {
      await saveSettings({ selectedModelId: this.activeModelId }).catch(() => undefined);
      return;
    }
    for (const port of this.ports) {
      this.post(port, { type: 'model-persist', modelId: this.activeModelId });
    }
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

  private async prewarmSnapshot(): Promise<RuntimePrefs | null> {
    if (browser.storage?.local) {
      const stored = await loadSettings().catch(() => null);
      if (stored) {
        return {
          idleMinutes: stored.idleMinutes,
          tier: stored.tier,
          targetLanguage: stored.targetLanguage,
          form: stored.form,
          glossary: stored.glossary,
          consented: hasLicenseConsent(stored),
        };
      }
    }
    return this.runtimePrefs;
  }

  private async prewarmFrequent(services: EngineServices): Promise<void> {
    const settings = await this.prewarmSnapshot();
    if (!settings?.consented) return;

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
      if (controller.signal.aborted) this.prewarmKey = null;
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
    this.armRetryIdle();

    void this.resolveIdleMs().then((ms) => {
      if (generation !== this.idleGeneration || ms <= 0) return;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        void this.releaseIdle();
      }, ms);
    });
  }

  private armRetryIdle(): void {
    if (this.retryIdleTimer) {
      clearTimeout(this.retryIdleTimer);
      this.retryIdleTimer = null;
    }
    this.retryIdleTimer = setTimeout(() => {
      this.retryIdleTimer = null;
      void this.releaseRetryRuntime();
    }, RETRY_RUNTIME_IDLE_MS);
  }

  private async releaseRetryRuntime(): Promise<void> {
    if (this.requests.size > 0) {
      this.armRetryIdle();
      return;
    }
    try {
      const services = await this.services();
      await services.disposeRetryRuntime?.();
    } catch {
      // Dropping the extra CPU copy is best effort; the next retry loads again.
    }
  }

  private resolveIdleMs(): Promise<number> {
    if (browser.storage?.local) {
      return loadSettings()
        .then((settings) => idleHoldMs(settings.idleMinutes))
        .catch(() => this.idleFromPush());
    }
    return Promise.resolve(this.idleFromPush());
  }

  private idleFromPush(): number {
    if (!this.runtimePrefs) return this.idleReleaseMs;
    return idleHoldMs(this.runtimePrefs.idleMinutes);
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
      await services.disposeRetryRuntime?.();
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
