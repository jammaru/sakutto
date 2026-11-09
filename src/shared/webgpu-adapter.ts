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

type RequestAdapterPreference = 'high-performance' | 'low-power' | 'default';

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

/**
 * Ask for a discrete GPU first. Chrome's default pick on a machine with an AMD iGPU and
 * a Radeon dGPU can miss shader-f16 (ggml-org/llama.cpp#21744).
 */
export async function requestAdapterWithPreferences(
  gpu: NavigatorGpu,
): Promise<{ adapter: AdapterSnapshot | null; attempts: string[]; error: string | null }> {
  const attempts: string[] = [];
  let first: AdapterSnapshot | null = null;
  let firstWithF16: AdapterSnapshot | null = null;
  let error: string | null = null;

  for (const preference of ADAPTER_PREFERENCES) {
    attempts.push(preference);
    try {
      const adapter = (await gpu.requestAdapter(
        preferenceOptions(preference),
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
