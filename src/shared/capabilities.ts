import {
  applyDebugOverlay,
  gpuDiagnosticFromUnknown,
  loadWebGpuDebugProfileFromStorage,
  type GpuDiagnostic,
} from './gpu-diagnostic';
import { isRecord } from './object';
import {
  ADAPTER_FIRST_OVERALL_TIMEOUT_MS,
  infoFromAdapter,
  requestAdapterWithPreferences,
  supportsFastBatches,
  wgslDotProduct,
  type NavigatorGpu,
  type WebGpuAdapterInfo,
} from './webgpu-adapter';

export type { WebGpuAdapterInfo } from './webgpu-adapter';
export type WebGpuStatus = 'ready' | 'unsupported' | 'unavailable' | 'failed';

export interface EngineCapabilities {
  crossOriginIsolated: boolean;
  webgpu: WebGpuStatus;
  hardwareConcurrency: number;
  /** The GPU can run a wide batch through ggml's fast integer shaders. */
  gpuFastBatches?: boolean;
}

const WEBGPU_STATUSES: ReadonlySet<string> = new Set<WebGpuStatus>([
  'ready',
  'unsupported',
  'unavailable',
  'failed',
]);

type NavigatorWithGpu = Navigator & {
  readonly gpu?: NavigatorGpu;
};

export function isEngineCapabilities(value: unknown): value is EngineCapabilities {
  return (
    isRecord(value) &&
    typeof value.crossOriginIsolated === 'boolean' &&
    typeof value.webgpu === 'string' &&
    WEBGPU_STATUSES.has(value.webgpu) &&
    typeof value.hardwareConcurrency === 'number' &&
    (value.gpuFastBatches === undefined || typeof value.gpuFastBatches === 'boolean')
  );
}

const ADAPTER_NOISE = /no available adapters/i;

/**
 * `public/gpu-probe.js` runs inside an about:srcdoc frame. Blink logs
 * "No available adapters." on the document that owns requestAdapter(), and
 * Chrome records that warning as an extension error only when the document URL
 * is chrome-extension://. An inline probe would need a CSP hash, which Manifest
 * V3 rejects, so the frame loads this bundled file instead.
 */
const GPU_PROBE_FILE = 'gpu-probe.js';
const GPU_PROBE_SOURCE = 'sakutto-gpu-probe';
/**
 * The iframe gets this long before the probe tries the page's own `navigator.gpu`. It is
 * longer than the old 4 s because a slow iGPU can still be bringing the adapter up; the
 * same-page attempts after it still fit inside the overall bound.
 */
const GPU_PROBE_TIMEOUT_MS = 12_000;
/** Frame plus same-page adapter attempts stay inside this bound. */
const GPU_PROBE_TOTAL_TIMEOUT_MS = ADAPTER_FIRST_OVERALL_TIMEOUT_MS;

let adapterNoiseInstalled = false;
let probeTask: Promise<EngineCapabilities> | null = null;
let adapterTask: Promise<WebGpuAdapterInfo> | null = null;
let lastAdapterInfo: WebGpuAdapterInfo | null = null;
let lastAdapterVendor: string | null = null;

export function lastWebGpuAdapterInfo(): WebGpuAdapterInfo | null {
  return lastAdapterInfo;
}

export function lastGpuDiagnostic(): GpuDiagnostic | null {
  return lastAdapterInfo?.diagnostic ?? null;
}

export function resetCapabilityProbe(): void {
  probeTask = null;
  adapterTask = null;
  lastAdapterInfo = null;
  lastAdapterVendor = null;
}

/**
 * A timeout or an empty negative answer is evidence that the adapter was not ready yet, not
 * that this machine has no WebGPU. Keep the diagnostic, but let the next probe try again.
 * A missing `navigator.gpu`, a confirmed adapter without shader-f16, or a thrown/unsupported
 * error is a hard answer and stays cached.
 */
export function isHardWebGpuFailure(info: WebGpuAdapterInfo | null): boolean {
  if (!info) return false;
  if (info.present) return info.diagnostic.shaderF16 === false;
  const error = info.diagnostic.error?.trim() ?? '';
  return error.length > 0 && !/timed out/i.test(error);
}

function isRetryableAdapterUnavailable(info: WebGpuAdapterInfo | null): boolean {
  return info?.present === false && !isHardWebGpuFailure(info);
}

/** The quiet frame may only short-circuit the direct path with a usable f16 adapter. */
function isPositiveWebGpuOffer(info: WebGpuAdapterInfo | null): info is WebGpuAdapterInfo {
  return info?.present === true && info.diagnostic.shaderF16 === true;
}

function rememberAdapterInfo(info: WebGpuAdapterInfo): WebGpuAdapterInfo {
  lastAdapterInfo = info;
  if (info.diagnostic.vendor) lastAdapterVendor = info.diagnostic.vendor;
  return info;
}

function cachedAdapterInfo(info: WebGpuAdapterInfo): WebGpuAdapterInfo {
  lastAdapterInfo = info;
  return info;
}

function isAdapterNoise(values: readonly unknown[]): boolean {
  return values.some((value) => ADAPTER_NOISE.test(String(value)));
}

/**
 * Chrome records `requestAdapter()` on a machine without a GPU as an extension error.
 * The probe still resolves to "unavailable"; only that log line is dropped.
 */
export function installAdapterNoiseFilter(): () => void {
  if (adapterNoiseInstalled) return () => undefined;
  adapterNoiseInstalled = true;

  const sink = globalThis.console;
  const originalError = sink.error.bind(sink);
  const originalWarn = sink.warn.bind(sink);
  const wrap =
    (original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      if (isAdapterNoise(args)) return;
      original(...args);
    };
  sink.error = wrap(originalError);
  sink.warn = wrap(originalWarn);

  const onError = (event: ErrorEvent): void => {
    if (!isAdapterNoise([event.message, event.error])) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    if (!isAdapterNoise([event.reason])) return;
    event.preventDefault();
  };

  const target = globalThis as typeof globalThis & {
    addEventListener?: (type: string, listener: (event: Event) => void) => void;
    removeEventListener?: (type: string, listener: (event: Event) => void) => void;
  };
  target.addEventListener?.('error', onError as (event: Event) => void);
  target.addEventListener?.('unhandledrejection', onRejection as (event: Event) => void);

  return () => {
    adapterNoiseInstalled = false;
    sink.error = originalError;
    sink.warn = originalWarn;
    target.removeEventListener?.('error', onError as (event: Event) => void);
    target.removeEventListener?.('unhandledrejection', onRejection as (event: Event) => void);
  };
}

function extensionRuntime(): { id?: string; getURL?: (path: string) => string } | null {
  return (
    (globalThis as { chrome?: { runtime?: { id?: string; getURL?: (path: string) => string } } })
      .chrome?.runtime ?? null
  );
}

function extensionPage(): boolean {
  const runtime = extensionRuntime();
  return (
    typeof runtime?.id === 'string' &&
    runtime.id.length > 0 &&
    typeof runtime.getURL === 'function' &&
    typeof document !== 'undefined'
  );
}

export function probeWebGpuAdapter(): Promise<WebGpuAdapterInfo> {
  if (!adapterTask) {
    adapterTask = requestWebGpuAdapter().catch((error: unknown) => {
      adapterTask = null;
      throw error;
    });
  }
  return adapterTask;
}

async function requestWebGpuAdapter(): Promise<WebGpuAdapterInfo> {
  const startedAt = Date.now();
  await loadWebGpuDebugProfileFromStorage();
  const gpu = (navigator as NavigatorWithGpu).gpu;
  if (!gpu) {
    const info = infoFromAdapter(null, false, { error: 'navigator.gpu is missing' });
    info.present = false;
    return cachedAdapterInfo(info);
  }
  installAdapterNoiseFilter();
  if (extensionPage()) {
    const quiet = await requestAdapterInQuietFrame();
    // A quiet empty/rejected/timeout answer is only evidence that this frame could not get
    // the adapter now. Returning it here skipped the retrying same-page search entirely and
    // left Auto on the CPU for the rest of the session (the Radeon Vega regression).
    if (isPositiveWebGpuOffer(quiet)) return rememberAdapterInfo(quiet);
  }
  try {
    const remaining = Math.max(1, GPU_PROBE_TOTAL_TIMEOUT_MS - (Date.now() - startedAt));
    const { adapter, attempts, error } = await requestAdapterWithPreferences(gpu, {
      overallMs: remaining,
      vendor: lastAdapterVendor,
    });
    return rememberAdapterInfo(infoFromAdapter(adapter, wgslDotProduct(gpu), { attempts, error }));
  } catch (error) {
    if (isAdapterNoise([error])) {
      return cachedAdapterInfo(
        infoFromAdapter(null, false, {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    throw error;
  }
}

function requestAdapterInQuietFrame(): Promise<WebGpuAdapterInfo | null> {
  const parent = document.documentElement;
  if (!parent) return Promise.resolve(null);

  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.style.display = 'none';
    let settled = false;
    let timer = 0;
    const finish = (info: WebGpuAdapterInfo | null): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame.remove();
      resolve(info);
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.contentWindow) return;
      // A srcdoc frame on an extension page is an opaque origin, so its
      // location.origin is "null". The source window is the frame we created.
      if (event.origin !== window.location.origin && event.origin !== 'null') return;
      const data = event.data as { source?: unknown };
      if (!data || data.source !== GPU_PROBE_SOURCE) return;
      const diagnostic = applyDebugOverlay(gpuDiagnosticFromUnknown(data));
      const present = (data as { present?: unknown }).present === true;
      finish({
        present,
        maxBufferSize: diagnostic.maxBufferSize,
        fastBatches: supportsFastBatches(
          diagnostic.vendor,
          (data as { dotProduct?: unknown }).dotProduct === true,
        ),
        diagnostic,
      });
    };
    timer = window.setTimeout(() => finish(null), GPU_PROBE_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    const scriptUrl = extensionRuntime()?.getURL?.(GPU_PROBE_FILE);
    if (!scriptUrl) {
      finish(null);
      return;
    }
    frame.srcdoc = `<!doctype html><title></title><script src="${scriptUrl}"></script>`;
    parent.append(frame);
  });
}

async function probeWebGpu(): Promise<WebGpuStatus> {
  const gpu = (navigator as NavigatorWithGpu).gpu;
  if (!gpu) return 'unsupported';

  // A software WebGL context is not a reason to skip the adapter. Machines with a
  // working GPU can still fail that canvas check, and the owner then stays on CPU.
  try {
    const info = await probeWebGpuAdapter();
    if (!info.present) return 'unavailable';
    // ggml-webgpu requires shader-f16. Skip the GPU load when the adapter (or
    // the no-f16 debug overlay) already says it is missing.
    if (info.diagnostic.shaderF16 === false) return 'unavailable';
    return 'ready';
  } catch {
    return 'failed';
  }
}

export function probeCapabilities(): Promise<EngineCapabilities> {
  if (probeTask) return probeTask;

  const task: Promise<EngineCapabilities> = Promise.resolve()
    .then(async () => ({
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      webgpu: await probeWebGpu(),
      hardwareConcurrency: navigator.hardwareConcurrency,
      gpuFastBatches: await probeWebGpuAdapter().then(
        (info) => info.fastBatches,
        () => false,
      ),
    }))
    .catch((error: unknown) => {
      if (probeTask === task) probeTask = null;
      throw error;
    });
  probeTask = task;

  void task.then(
    (capabilities) => {
      if (probeTask !== task) return;
      if (
        capabilities.webgpu !== 'unavailable' ||
        !isRetryableAdapterUnavailable(lastAdapterInfo)
      ) {
        return;
      }
      // Clear after this result's callers have read the diagnostic. `resetCapabilityProbe()`
      // remains available for an explicit retry before then.
      queueMicrotask(() => {
        if (probeTask !== task) return;
        probeTask = null;
        adapterTask = null;
      });
    },
    () => undefined,
  );

  return task;
}
