import {
  applyDebugOverlay,
  gpuDiagnosticFromUnknown,
  loadWebGpuDebugProfileFromStorage,
  type GpuDiagnostic,
} from './gpu-diagnostic';
import { isRecord } from './object';
import {
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

interface NavigatorWithGpu extends Navigator {
  readonly gpu?: NavigatorGpu;
}

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
const GPU_PROBE_TIMEOUT_MS = 4000;

let adapterNoiseInstalled = false;
let probeTask: Promise<EngineCapabilities> | null = null;
let adapterTask: Promise<WebGpuAdapterInfo> | null = null;
let lastAdapterInfo: WebGpuAdapterInfo | null = null;

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
  await loadWebGpuDebugProfileFromStorage();
  const gpu = (navigator as NavigatorWithGpu).gpu;
  if (!gpu) {
    lastAdapterInfo = infoFromAdapter(null, false, { error: 'navigator.gpu is missing' });
    lastAdapterInfo.present = false;
    return lastAdapterInfo;
  }
  installAdapterNoiseFilter();
  if (extensionPage()) {
    const quiet = await requestAdapterInQuietFrame();
    if (quiet) {
      lastAdapterInfo = quiet;
      return quiet;
    }
  }
  try {
    const { adapter, attempts, error } = await requestAdapterWithPreferences(gpu);
    const info = infoFromAdapter(adapter, wgslDotProduct(gpu), { attempts, error });
    lastAdapterInfo = info;
    return info;
  } catch (error) {
    if (isAdapterNoise([error])) {
      lastAdapterInfo = infoFromAdapter(null, false, {
        error: error instanceof Error ? error.message : String(error),
      });
      return lastAdapterInfo;
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
  if (!probeTask) {
    probeTask = Promise.resolve()
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
        probeTask = null;
        throw error;
      });
  }
  return probeTask;
}
