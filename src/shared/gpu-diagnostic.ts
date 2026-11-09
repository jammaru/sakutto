import { isRecord } from './object';

export type WebGpuDebugProfile = 'off' | 'amd-rdna3' | 'intel-arc' | 'no-f16' | 'subgroup-64';

export const WEBGPU_DEBUG_STORAGE_KEY = 'sakuttoWebGpuDebug';

const DEBUG_PROFILES: ReadonlySet<string> = new Set<WebGpuDebugProfile>([
  'off',
  'amd-rdna3',
  'intel-arc',
  'no-f16',
  'subgroup-64',
]);

export function isWebGpuDebugProfile(value: unknown): value is WebGpuDebugProfile {
  return typeof value === 'string' && DEBUG_PROFILES.has(value);
}

/**
 * Compact WebGPU report for the settings page. Nothing here is sent anywhere; the
 * reader copies it into a GitHub issue if they want.
 */
export interface GpuDiagnostic {
  vendor: string | null;
  architecture: string | null;
  device: string | null;
  description: string | null;
  fallbackAdapter: boolean | null;
  shaderF16: boolean | null;
  subgroups: boolean | null;
  subgroupMinSize: number | null;
  subgroupMaxSize: number | null;
  features: string[];
  maxBufferSize: number | null;
  maxStorageBufferBindingSize: number | null;
  maxComputeWorkgroupStorageSize: number | null;
  maxComputeInvocationsPerWorkgroup: number | null;
  adapterAttempts: string[];
  error: string | null;
  debugProfile: WebGpuDebugProfile | null;
}

export const EMPTY_GPU_DIAGNOSTIC: GpuDiagnostic = {
  vendor: null,
  architecture: null,
  device: null,
  description: null,
  fallbackAdapter: null,
  shaderF16: null,
  subgroups: null,
  subgroupMinSize: null,
  subgroupMaxSize: null,
  features: [],
  maxBufferSize: null,
  maxStorageBufferBindingSize: null,
  maxComputeWorkgroupStorageSize: null,
  maxComputeInvocationsPerWorkgroup: null,
  adapterAttempts: [],
  error: null,
  debugProfile: null,
};

/** Typical D3D12 grant on AMD RDNA3 / Intel Arc: 2 GiB − 4, wave32 or wave64. */
export const AMD_RDNA3_SIMULATED_LIMITS = {
  vendor: 'amd',
  architecture: 'rdna3',
  description: 'simulated AMD Radeon RX 7800 XT (RDNA3) limits',
  maxBufferSize: 2_147_483_648,
  maxStorageBufferBindingSize: 2_147_483_644,
  maxComputeWorkgroupStorageSize: 32_768,
  maxComputeInvocationsPerWorkgroup: 1_024,
  subgroupMinSize: 32,
  subgroupMaxSize: 64,
  shaderF16: true,
  subgroups: true,
} as const;

export const INTEL_ARC_SIMULATED_LIMITS = {
  vendor: 'intel',
  architecture: 'gen-12',
  description: 'simulated Intel Arc / iGPU limits',
  maxBufferSize: 2_147_483_648,
  maxStorageBufferBindingSize: 2_147_483_644,
  maxComputeWorkgroupStorageSize: 32_768,
  maxComputeInvocationsPerWorkgroup: 1_024,
  subgroupMinSize: 16,
  subgroupMaxSize: 32,
  shaderF16: true,
  subgroups: true,
} as const;

let profileOverride: WebGpuDebugProfile | null = null;
let storageTask: Promise<void> | null = null;

function debugGlobal(): { __SAKUTTO_WEBGPU_DEBUG__?: unknown } {
  return globalThis as { __SAKUTTO_WEBGPU_DEBUG__?: unknown };
}

export function setWebGpuDebugProfile(profile: WebGpuDebugProfile | null): void {
  profileOverride = profile;
  const target = debugGlobal();
  if (profile && profile !== 'off') target.__SAKUTTO_WEBGPU_DEBUG__ = profile;
  else delete target.__SAKUTTO_WEBGPU_DEBUG__;
}

export function resetWebGpuDebugProfile(): void {
  profileOverride = null;
  delete debugGlobal().__SAKUTTO_WEBGPU_DEBUG__;
  storageTask = null;
}

export function webGpuDebugProfile(): WebGpuDebugProfile {
  if (profileOverride) return profileOverride;
  const fromGlobal = debugGlobal().__SAKUTTO_WEBGPU_DEBUG__;
  return isWebGpuDebugProfile(fromGlobal) ? fromGlobal : 'off';
}

export function loadWebGpuDebugProfileFromStorage(): Promise<void> {
  if (!storageTask) {
    storageTask = readDebugProfileFromStorage().catch(() => undefined);
  }
  return storageTask;
}

async function readDebugProfileFromStorage(): Promise<void> {
  const local = (
    globalThis as {
      chrome?: { storage?: { local?: { get: (key: string) => Promise<Record<string, unknown>> } } };
    }
  ).chrome?.storage?.local;
  if (!local?.get) return;
  const stored = await local.get(WEBGPU_DEBUG_STORAGE_KEY);
  const value = stored[WEBGPU_DEBUG_STORAGE_KEY];
  if (isWebGpuDebugProfile(value) && value !== 'off' && profileOverride === null) {
    setWebGpuDebugProfile(value);
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function isGpuDiagnostic(value: unknown): value is GpuDiagnostic {
  if (!isRecord(value)) return false;
  if (value.vendor !== null && typeof value.vendor !== 'string') return false;
  if (value.architecture !== null && typeof value.architecture !== 'string') return false;
  if (value.device !== null && typeof value.device !== 'string') return false;
  if (value.description !== null && typeof value.description !== 'string') return false;
  if (value.fallbackAdapter !== null && typeof value.fallbackAdapter !== 'boolean') return false;
  if (value.shaderF16 !== null && typeof value.shaderF16 !== 'boolean') return false;
  if (value.subgroups !== null && typeof value.subgroups !== 'boolean') return false;
  if (value.subgroupMinSize !== null && typeof value.subgroupMinSize !== 'number') return false;
  if (value.subgroupMaxSize !== null && typeof value.subgroupMaxSize !== 'number') return false;
  if (!Array.isArray(value.features) || value.features.some((item) => typeof item !== 'string')) {
    return false;
  }
  if (value.maxBufferSize !== null && typeof value.maxBufferSize !== 'number') return false;
  if (
    value.maxStorageBufferBindingSize !== null &&
    typeof value.maxStorageBufferBindingSize !== 'number'
  ) {
    return false;
  }
  if (
    value.maxComputeWorkgroupStorageSize !== null &&
    typeof value.maxComputeWorkgroupStorageSize !== 'number'
  ) {
    return false;
  }
  if (
    value.maxComputeInvocationsPerWorkgroup !== null &&
    typeof value.maxComputeInvocationsPerWorkgroup !== 'number'
  ) {
    return false;
  }
  if (
    !Array.isArray(value.adapterAttempts) ||
    value.adapterAttempts.some((item) => typeof item !== 'string')
  ) {
    return false;
  }
  if (value.error !== null && typeof value.error !== 'string') return false;
  if (value.debugProfile !== null && !isWebGpuDebugProfile(value.debugProfile)) return false;
  return true;
}

export function gpuDiagnosticFromUnknown(value: unknown): GpuDiagnostic {
  if (!isRecord(value)) return { ...EMPTY_GPU_DIAGNOSTIC };
  return {
    vendor: optionalString(value.vendor),
    architecture: optionalString(value.architecture),
    device: optionalString(value.device),
    description: optionalString(value.description),
    fallbackAdapter: optionalBoolean(value.fallbackAdapter),
    shaderF16: optionalBoolean(value.shaderF16),
    subgroups: optionalBoolean(value.subgroups),
    subgroupMinSize: optionalNumber(value.subgroupMinSize),
    subgroupMaxSize: optionalNumber(value.subgroupMaxSize),
    features: stringList(value.features),
    maxBufferSize: optionalNumber(value.maxBufferSize),
    maxStorageBufferBindingSize: optionalNumber(value.maxStorageBufferBindingSize),
    maxComputeWorkgroupStorageSize: optionalNumber(value.maxComputeWorkgroupStorageSize),
    maxComputeInvocationsPerWorkgroup: optionalNumber(value.maxComputeInvocationsPerWorkgroup),
    adapterAttempts: stringList(value.adapterAttempts),
    error: optionalString(value.error),
    debugProfile: isWebGpuDebugProfile(value.debugProfile) ? value.debugProfile : null,
  };
}

/** Lines from llama.cpp that explain why WebGPU did or did not take the model. */
export function gpuFailureExcerpt(lines: readonly string[]): string | null {
  const interesting = lines.filter((line) =>
    /ggml_webgpu:|using device WebGPU|offloaded \d+\/\d+ layers to GPU/iu.test(line),
  );
  if (interesting.length === 0) return null;
  return interesting.slice(-16).join('\n');
}

export function mergeGpuDiagnostic(
  adapter: GpuDiagnostic | null | undefined,
  error: string | null | undefined,
): GpuDiagnostic {
  const base = adapter
    ? { ...adapter, features: [...adapter.features] }
    : { ...EMPTY_GPU_DIAGNOSTIC };
  if (error && error.length > 0) base.error = error;
  return applyDebugOverlay(base);
}

export function applyDebugOverlay(diagnostic: GpuDiagnostic): GpuDiagnostic {
  const profile = webGpuDebugProfile();
  if (profile === 'off') return { ...diagnostic, debugProfile: diagnostic.debugProfile };
  const next = { ...diagnostic, features: [...diagnostic.features], debugProfile: profile };
  if (profile === 'amd-rdna3') {
    next.vendor = AMD_RDNA3_SIMULATED_LIMITS.vendor;
    next.architecture = AMD_RDNA3_SIMULATED_LIMITS.architecture;
    next.description = AMD_RDNA3_SIMULATED_LIMITS.description;
    next.maxBufferSize = AMD_RDNA3_SIMULATED_LIMITS.maxBufferSize;
    next.maxStorageBufferBindingSize = AMD_RDNA3_SIMULATED_LIMITS.maxStorageBufferBindingSize;
    next.maxComputeWorkgroupStorageSize = AMD_RDNA3_SIMULATED_LIMITS.maxComputeWorkgroupStorageSize;
    next.maxComputeInvocationsPerWorkgroup =
      AMD_RDNA3_SIMULATED_LIMITS.maxComputeInvocationsPerWorkgroup;
    next.subgroupMinSize = AMD_RDNA3_SIMULATED_LIMITS.subgroupMinSize;
    next.subgroupMaxSize = AMD_RDNA3_SIMULATED_LIMITS.subgroupMaxSize;
    next.shaderF16 = AMD_RDNA3_SIMULATED_LIMITS.shaderF16;
    next.subgroups = AMD_RDNA3_SIMULATED_LIMITS.subgroups;
  } else if (profile === 'intel-arc') {
    next.vendor = INTEL_ARC_SIMULATED_LIMITS.vendor;
    next.architecture = INTEL_ARC_SIMULATED_LIMITS.architecture;
    next.description = INTEL_ARC_SIMULATED_LIMITS.description;
    next.maxBufferSize = INTEL_ARC_SIMULATED_LIMITS.maxBufferSize;
    next.maxStorageBufferBindingSize = INTEL_ARC_SIMULATED_LIMITS.maxStorageBufferBindingSize;
    next.maxComputeWorkgroupStorageSize = INTEL_ARC_SIMULATED_LIMITS.maxComputeWorkgroupStorageSize;
    next.maxComputeInvocationsPerWorkgroup =
      INTEL_ARC_SIMULATED_LIMITS.maxComputeInvocationsPerWorkgroup;
    next.subgroupMinSize = INTEL_ARC_SIMULATED_LIMITS.subgroupMinSize;
    next.subgroupMaxSize = INTEL_ARC_SIMULATED_LIMITS.subgroupMaxSize;
    next.shaderF16 = INTEL_ARC_SIMULATED_LIMITS.shaderF16;
    next.subgroups = INTEL_ARC_SIMULATED_LIMITS.subgroups;
  } else if (profile === 'no-f16') {
    next.shaderF16 = false;
    next.features = next.features.filter((name) => name !== 'shader-f16');
  } else if (profile === 'subgroup-64') {
    next.subgroupMinSize = 64;
    next.subgroupMaxSize = 64;
  }
  return next;
}

function line(label: string, value: string | number | boolean | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return `${label}: ${value}`;
}

/** Plain text the reader can paste into a GitHub issue. Stays on the device until they copy it. */
export function formatGpuDiagnostic(diagnostic: GpuDiagnostic): string {
  const lines = [
    'Sakutto WebGPU diagnostic',
    line('vendor', diagnostic.vendor),
    line('architecture', diagnostic.architecture),
    line('device', diagnostic.device),
    line('description', diagnostic.description),
    line('fallbackAdapter', diagnostic.fallbackAdapter),
    line('shader-f16', diagnostic.shaderF16),
    line('subgroups', diagnostic.subgroups),
    line('subgroupMinSize', diagnostic.subgroupMinSize),
    line('subgroupMaxSize', diagnostic.subgroupMaxSize),
    diagnostic.features.length > 0 ? `features: ${diagnostic.features.join(', ')}` : null,
    line('maxBufferSize', diagnostic.maxBufferSize),
    line('maxStorageBufferBindingSize', diagnostic.maxStorageBufferBindingSize),
    line('maxComputeWorkgroupStorageSize', diagnostic.maxComputeWorkgroupStorageSize),
    line('maxComputeInvocationsPerWorkgroup', diagnostic.maxComputeInvocationsPerWorkgroup),
    diagnostic.adapterAttempts.length > 0
      ? `adapterAttempts: ${diagnostic.adapterAttempts.join(', ')}`
      : null,
    line('debugProfile', diagnostic.debugProfile),
    diagnostic.error ? `error:\n${diagnostic.error}` : null,
  ].filter((item): item is string => item !== null);
  return lines.join('\n');
}

export function gpuDiagnosticIsEmpty(diagnostic: GpuDiagnostic | null | undefined): boolean {
  if (!diagnostic) return true;
  return (
    diagnostic.vendor === null &&
    diagnostic.architecture === null &&
    diagnostic.device === null &&
    diagnostic.description === null &&
    diagnostic.features.length === 0 &&
    diagnostic.maxBufferSize === null &&
    diagnostic.error === null &&
    diagnostic.adapterAttempts.length === 0
  );
}
