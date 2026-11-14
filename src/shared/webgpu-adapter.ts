import {
  applyDebugOverlay,
  gpuDiagnosticFromUnknown,
  type GpuDiagnostic,
  webGpuDebugProfile,
} from './gpu-diagnostic';

export interface WebGpuAdapterInfo {
  present: boolean;
  maxBufferSize: number | null;
  fastBatches: boolean;
  diagnostic: GpuDiagnostic;
}

const DOT_PRODUCT_FEATURE = 'packed_4x8_integer_dot_product';
const ADAPTER_PREFERENCES: ReadonlyArray<RequestAdapterPreference> = [
  'high-performance',
  'default',
  'low-power',
];

/** One `requestAdapter()` call gets this long before the next preference is tried. */
export const ADAPTER_ATTEMPT_TIMEOUT_MS = 4000;
/** All preferences together are bounded, so a wedged adapter cannot stall startup. */
export const ADAPTER_OVERALL_TIMEOUT_MS = 8000;

type RequestAdapterPreference = 'high-performance' | 'low-power' | 'default';

export interface AdapterRequestTimeouts {
  attemptMs?: number;
  overallMs?: number;
}

export interface NavigatorGpu {
  requestAdapter(options?: {
    powerPreference?: 'high-performance' | 'low-power';
  }): Promise<unknown | null>;
  readonly wgslLanguageFeatures?: { has(name: string): boolean };
}

interface AdapterSnapshot {
  features?: Iterable<string> | { has(name: string): boolean };
  limits?: {
    maxBufferSize?: number;
    maxStorageBufferBindingSize?: number;
    maxComputeWorkgroupStorageSize?: number;
    maxComputeInvocationsPerWorkgroup?: number;
  };
  info?: {
    vendor?: string;
    architecture?: string;
    device?: string;
    description?: string;
    isFallbackAdapter?: boolean;
    subgroupMinSize?: number;
    subgroupMaxSize?: number;
  };
  isFallbackAdapter?: boolean;
}

// ggml gives AMD and Intel the same shaders, but sixteen slots have only been measured on NVIDIA.
const FAST_BATCH_VENDORS: ReadonlySet<string> = new Set(['nvidia']);

export function supportsFastBatches(vendor: unknown, dotProduct: unknown): boolean {
  if (webGpuDebugProfile() === 'amd-rdna3' || webGpuDebugProfile() === 'intel-arc') return false;
  return dotProduct === true && typeof vendor === 'string' && FAST_BATCH_VENDORS.has(vendor);
}

function featureNames(features: AdapterSnapshot['features']): string[] {
  if (!features) return [];
  try {
    if (typeof (features as Iterable<string>)[Symbol.iterator] === 'function') {
      return [...(features as Iterable<string>)].map(String).sort();
    }
  } catch {
    return [];
  }
  const known = ['shader-f16', 'subgroups', 'timestamp-query', 'float32-filterable'];
  const has = (features as { has(name: string): boolean }).has;
  if (typeof has !== 'function') return [];
  return known.filter((name) => has.call(features, name));
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function diagnosticFromAdapter(
  adapter: AdapterSnapshot | null,
  extras: { attempts?: string[]; error?: string | null; dotProduct?: boolean } = {},
): GpuDiagnostic {
  const features = featureNames(adapter?.features);
  const info = adapter?.info;
  const fallback =
    typeof adapter?.isFallbackAdapter === 'boolean'
      ? adapter.isFallbackAdapter
      : typeof info?.isFallbackAdapter === 'boolean'
        ? info.isFallbackAdapter
        : null;
  const shaderF16 =
    features.includes('shader-f16') ||
    (typeof adapter?.features === 'object' &&
      adapter.features !== null &&
      'has' in adapter.features &&
      adapter.features.has('shader-f16'));
  const subgroups =
    features.includes('subgroups') ||
    (typeof adapter?.features === 'object' &&
      adapter.features !== null &&
      'has' in adapter.features &&
      adapter.features.has('subgroups'));
  return applyDebugOverlay(
    gpuDiagnosticFromUnknown({
      vendor: optionalString(info?.vendor),
      architecture: optionalString(info?.architecture),
      device: optionalString(info?.device),
      description: optionalString(info?.description),
      fallbackAdapter: fallback,
      shaderF16,
      subgroups,
      subgroupMinSize: optionalNumber(info?.subgroupMinSize),
      subgroupMaxSize: optionalNumber(info?.subgroupMaxSize),
      features,
      maxBufferSize: optionalNumber(adapter?.limits?.maxBufferSize),
      maxStorageBufferBindingSize: optionalNumber(adapter?.limits?.maxStorageBufferBindingSize),
      maxComputeWorkgroupStorageSize: optionalNumber(
        adapter?.limits?.maxComputeWorkgroupStorageSize,
      ),
      maxComputeInvocationsPerWorkgroup: optionalNumber(
        adapter?.limits?.maxComputeInvocationsPerWorkgroup,
      ),
      adapterAttempts: extras.attempts ?? [],
      error: extras.error ?? null,
    }),
  );
}

export function infoFromAdapter(
  adapter: AdapterSnapshot | null,
  dotProduct: boolean,
  extras: { attempts?: string[]; error?: string | null } = {},
): WebGpuAdapterInfo {
  const diagnostic = diagnosticFromAdapter(adapter, { ...extras, dotProduct });
  const vendor = diagnostic.vendor ?? adapter?.info?.vendor;
  return {
    present: adapter !== null,
    maxBufferSize: diagnostic.maxBufferSize,
    fastBatches: supportsFastBatches(vendor, dotProduct),
    diagnostic,
  };
}

function preferenceOptions(
  preference: RequestAdapterPreference,
): { powerPreference: 'high-performance' | 'low-power' } | Record<string, never> {
  if (preference === 'default') return {};
  return { powerPreference: preference };
}

function timeoutMessage(ms: number): string {
  return `requestAdapter timed out after ${String(ms)}ms`;
}

/**
 * Chrome on Linux/Wayland has been seen to leave `requestAdapter()` pending forever.
 * A WebGPU call cannot be cancelled, so bound the wait instead of letting the engine
 * host stay in its probe forever.
 */
function requestAdapterWithin(
  gpu: NavigatorGpu,
  preference: RequestAdapterPreference,
  timeoutMs: number,
): Promise<AdapterSnapshot | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        reject(new Error(timeoutMessage(timeoutMs)));
      },
      Math.max(1, timeoutMs),
    );

    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
    };

    let request: Promise<unknown>;
    try {
      request = gpu.requestAdapter(preferenceOptions(preference));
    } catch (caught: unknown) {
      finish();
      reject(caught);
      return;
    }

    request.then(
      (value) => {
        if (settled) return;
        finish();
        resolve(value as AdapterSnapshot | null);
      },
      (caught: unknown) => {
        if (settled) return;
        finish();
        reject(caught);
      },
    );
  });
}

/**
 * Ask for a discrete GPU first. Chrome's default pick on a machine with an AMD iGPU and
 * a Radeon dGPU can miss shader-f16 (ggml-org/llama.cpp#21744).
 *
 * Each request is bounded, and the whole search stops at the overall deadline. A healthy
 * adapter resolves on the first call and pays nothing for these timers.
 */
export async function requestAdapterWithPreferences(
  gpu: NavigatorGpu,
  timeouts: AdapterRequestTimeouts = {},
): Promise<{ adapter: AdapterSnapshot | null; attempts: string[]; error: string | null }> {
  const attempts: string[] = [];
  let first: AdapterSnapshot | null = null;
  let firstWithF16: AdapterSnapshot | null = null;
  let error: string | null = null;
  const attemptMs = timeouts.attemptMs ?? ADAPTER_ATTEMPT_TIMEOUT_MS;
  const overallMs = timeouts.overallMs ?? ADAPTER_OVERALL_TIMEOUT_MS;
  const deadline = Date.now() + overallMs;

  for (const preference of ADAPTER_PREFERENCES) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      error ??= timeoutMessage(overallMs);
      break;
    }
    attempts.push(preference);
    try {
      const adapter = (await requestAdapterWithin(
        gpu,
        preference,
        Math.min(attemptMs, remaining),
      )) as AdapterSnapshot | null;
      if (!adapter) continue;
      if (!first) first = adapter;
      const features = featureNames(adapter.features);
      const hasF16 =
        features.includes('shader-f16') ||
        (typeof adapter.features === 'object' &&
          adapter.features !== null &&
          'has' in adapter.features &&
          adapter.features.has('shader-f16'));
      const fallback =
        adapter.isFallbackAdapter === true || adapter.info?.isFallbackAdapter === true;
      if (fallback) continue;
      if (hasF16) {
        firstWithF16 = adapter;
        break;
      }
    } catch (caught: unknown) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  return { adapter: firstWithF16 ?? first, attempts, error };
}

export function wgslDotProduct(gpu: NavigatorGpu): boolean {
  return gpu.wgslLanguageFeatures?.has(DOT_PRODUCT_FEATURE) === true;
}

export { DOT_PRODUCT_FEATURE, FAST_BATCH_VENDORS, ADAPTER_PREFERENCES };
