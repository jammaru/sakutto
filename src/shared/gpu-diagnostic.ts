import { isRecord } from './object';

export type WebGpuDebugProfile = 'off' | 'amd-rdna3' | 'intel-arc' | 'no-f16' | 'reject-max-limits';

export type CorrectnessProbeStatus = 'ok' | 'failed' | 'subgroups-disabled';

export const WEBGPU_DEBUG_STORAGE_KEY = 'sakuttoWebGpuDebug';
export const WEBGPU_DEBUG_QUERY_PARAM = 'webgpuDebug';
export const WEBGPU_DEBUG_MESSAGE_TYPE = 'engine:webgpu-debug';

const DEBUG_PROFILES: ReadonlySet<string> = new Set<WebGpuDebugProfile>([
  'off',
  'amd-rdna3',
  'intel-arc',
  'no-f16',
  'reject-max-limits',
]);

const REJECT_MAX_NOTE = 'debug: reject adapter-max requestDevice';

/**
 * Shader specialization may only use a size the adapter actually reported.
 * Unknown, zero, or inverted ranges mean the non-subgroup (workgroup) path.
 */
export function reportedSubgroupRange(
  min: number | null | undefined,
  max: number | null | undefined,
): { min: number; max: number } | null {
  if (typeof min !== 'number' || typeof max !== 'number') return null;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min <= 0 || max <= 0 || max < min) return null;
  return { min, max };
}

export function subgroupShadersEnabled(
  hasFeature: boolean | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
): boolean {
  return hasFeature === true && reportedSubgroupRange(min, max) !== null;
}

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
  deviceStage: string | null;
  deviceFeatures: string[];
  deviceMaxBufferSize: number | null;
  deviceMaxStorageBufferBindingSize: number | null;
  hint: string | null;
  error: string | null;
  debugProfile: WebGpuDebugProfile | null;
  correctnessProbe: CorrectnessProbeStatus | null;
  correctnessProbeMs: number | null;
  correctnessProbeSubgroupSize: number | null;
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
  deviceStage: null,
  deviceFeatures: [],
  deviceMaxBufferSize: null,
  deviceMaxStorageBufferBindingSize: null,
  hint: null,
  error: null,
  debugProfile: null,
  correctnessProbe: null,
  correctnessProbeMs: null,
  correctnessProbeSubgroupSize: null,
};

/**
 * Typical D3D12 grant on AMD RDNA3 / Intel Arc: 2 GiB − 4.
 * `subgroupMinSize` / `MaxSize` here are documentation (RDNA3 wave32/wave64).
 * The debug overlay does not apply them: C++ only caps buffer limits, and a
 * guessed shader size silently mistranslates.
 */
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

export const INTEGRATED_GPU_HINT =
  'Windows Chrome ignores powerPreference (crbug 369219127). If this adapter looks integrated, try chrome://flags/#force-high-performance-gpu.';

let profileOverride: WebGpuDebugProfile | null = null;
let storageTask: Promise<WebGpuDebugProfile> | null = null;

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

export function webGpuDebugProfileFromUrl(href: string): WebGpuDebugProfile | null {
  try {
    const url = new URL(href, 'https://sakutto.invalid/');
    const value = url.searchParams.get(WEBGPU_DEBUG_QUERY_PARAM);
    return isWebGpuDebugProfile(value) ? value : null;
  } catch {
    return null;
  }
}

export function applyWebGpuDebugProfileFromHref(href: string): WebGpuDebugProfile | null {
  const profile = webGpuDebugProfileFromUrl(href);
  if (profile) setWebGpuDebugProfile(profile);
  return profile;
}

/** Offscreen createDocument path, with the debug profile in the query string when set. */
export function offscreenDocumentUrl(page: string, profile: WebGpuDebugProfile | null): string {
  if (!profile || profile === 'off') return page;
  const join = page.includes('?') ? '&' : '?';
  return `${page}${join}${WEBGPU_DEBUG_QUERY_PARAM}=${encodeURIComponent(profile)}`;
}

export function offscreenDocumentMatches(documentUrl: string, pageUrl: string): boolean {
  return documentUrl === pageUrl || documentUrl.startsWith(`${pageUrl}?`);
}

type StorageLocal = { get: (key: string) => Promise<Record<string, unknown>> };

function chromeLike(): {
  storage?: { local?: StorageLocal };
  runtime?: { sendMessage?: (message: unknown) => Promise<unknown> };
} {
  return (globalThis as { chrome?: ReturnType<typeof chromeLike> }).chrome ?? {};
}

export async function resolveWebGpuDebugProfile(options?: {
  href?: string;
  storage?: StorageLocal | null;
  askHost?: () => Promise<unknown>;
}): Promise<WebGpuDebugProfile> {
  const href = options?.href ?? (typeof location !== 'undefined' ? location.href : '');
  const fromUrl = webGpuDebugProfileFromUrl(href);
  if (fromUrl) {
    setWebGpuDebugProfile(fromUrl);
    return fromUrl;
  }
  if (profileOverride) return profileOverride;

  const chrome = chromeLike();
  const storage =
    options?.storage !== undefined ? options.storage : (chrome.storage?.local ?? null);
  if (storage?.get) {
    try {
      const stored = await storage.get(WEBGPU_DEBUG_STORAGE_KEY);
      const value = stored[WEBGPU_DEBUG_STORAGE_KEY];
      if (isWebGpuDebugProfile(value)) {
        setWebGpuDebugProfile(value);
        return value;
      }
    } catch {
      // Offscreen documents often have chrome.runtime but no chrome.storage.
    }
  }

  const ask =
    options?.askHost ??
    (typeof chrome.runtime?.sendMessage === 'function' && !chrome.storage
      ? () => chrome.runtime!.sendMessage!({ type: WEBGPU_DEBUG_MESSAGE_TYPE })
      : null);
  if (ask) {
    try {
      const value = await ask();
      if (isWebGpuDebugProfile(value)) {
        setWebGpuDebugProfile(value);
        return value;
      }
    } catch {
      // The service worker may not be listening yet.
    }
  }

  return webGpuDebugProfile();
}

export function loadWebGpuDebugProfileFromStorage(): Promise<WebGpuDebugProfile> {
  if (!storageTask) {
    storageTask = resolveWebGpuDebugProfile().catch(() => webGpuDebugProfile());
  }
  return storageTask;
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

function isStringOrNull(value: unknown): boolean {
  return value === null || value === undefined || typeof value === 'string';
}

function isBooleanOrNull(value: unknown): boolean {
  return value === null || value === undefined || typeof value === 'boolean';
}

function isNumberOrNull(value: unknown): boolean {
  return value === null || value === undefined || typeof value === 'number';
}

function isCorrectnessProbeStatus(value: unknown): value is CorrectnessProbeStatus {
  return value === 'ok' || value === 'failed' || value === 'subgroups-disabled';
}

export function isGpuDiagnostic(value: unknown): value is GpuDiagnostic {
  if (!isRecord(value)) return false;
  if (!isStringOrNull(value.vendor)) return false;
  if (!isStringOrNull(value.architecture)) return false;
  if (!isStringOrNull(value.device)) return false;
  if (!isStringOrNull(value.description)) return false;
  if (!isBooleanOrNull(value.fallbackAdapter)) return false;
  if (!isBooleanOrNull(value.shaderF16)) return false;
  if (!isBooleanOrNull(value.subgroups)) return false;
  if (!isNumberOrNull(value.subgroupMinSize)) return false;
  if (!isNumberOrNull(value.subgroupMaxSize)) return false;
  if (!Array.isArray(value.features) || value.features.some((item) => typeof item !== 'string')) {
    return false;
  }
  if (!isNumberOrNull(value.maxBufferSize)) return false;
  if (!isNumberOrNull(value.maxStorageBufferBindingSize)) return false;
  if (!isNumberOrNull(value.maxComputeWorkgroupStorageSize)) return false;
  if (!isNumberOrNull(value.maxComputeInvocationsPerWorkgroup)) return false;
  if (
    !Array.isArray(value.adapterAttempts) ||
    value.adapterAttempts.some((item) => typeof item !== 'string')
  ) {
    return false;
  }
  if (!isStringOrNull(value.deviceStage)) return false;
  if (
    value.deviceFeatures !== undefined &&
    (!Array.isArray(value.deviceFeatures) ||
      value.deviceFeatures.some((item) => typeof item !== 'string'))
  ) {
    return false;
  }
  if (!isNumberOrNull(value.deviceMaxBufferSize)) return false;
  if (!isNumberOrNull(value.deviceMaxStorageBufferBindingSize)) return false;
  if (!isStringOrNull(value.hint)) return false;
  if (!isStringOrNull(value.error)) return false;
  if (
    value.debugProfile !== null &&
    value.debugProfile !== undefined &&
    !isWebGpuDebugProfile(value.debugProfile)
  ) {
    return false;
  }
  if (
    value.correctnessProbe !== null &&
    value.correctnessProbe !== undefined &&
    !isCorrectnessProbeStatus(value.correctnessProbe)
  ) {
    return false;
  }
  if (!isNumberOrNull(value.correctnessProbeMs)) return false;
  if (!isNumberOrNull(value.correctnessProbeSubgroupSize)) return false;
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
    deviceStage: optionalString(value.deviceStage),
    deviceFeatures: stringList(value.deviceFeatures),
    deviceMaxBufferSize: optionalNumber(value.deviceMaxBufferSize),
    deviceMaxStorageBufferBindingSize: optionalNumber(value.deviceMaxStorageBufferBindingSize),
    hint: optionalString(value.hint),
    error: optionalString(value.error),
    debugProfile: isWebGpuDebugProfile(value.debugProfile) ? value.debugProfile : null,
    correctnessProbe: isCorrectnessProbeStatus(value.correctnessProbe)
      ? value.correctnessProbe
      : null,
    correctnessProbeMs: optionalNumber(value.correctnessProbeMs),
    correctnessProbeSubgroupSize: optionalNumber(value.correctnessProbeSubgroupSize),
  };
}

const INTERESTING_LOG = /ggml_webgpu:|using device WebGPU|offloaded \d+\/\d+ layers to GPU/iu;
const EXCERPT_HEAD = 8;
const EXCERPT_TAIL = 8;

/** Lines from llama.cpp that explain why WebGPU did or did not take the model. */
export function gpuFailureExcerpt(lines: readonly string[]): string | null {
  const interesting = lines.filter((line) => INTERESTING_LOG.test(line));
  if (interesting.length === 0) return null;
  if (interesting.length <= EXCERPT_HEAD + EXCERPT_TAIL) return interesting.join('\n');
  const head = interesting.slice(0, EXCERPT_HEAD);
  const tail = interesting.slice(-EXCERPT_TAIL);
  return [...head, '...', ...tail].join('\n');
}

export function parseWebGpuLog(text: string | readonly string[] | null | undefined): {
  deviceStage: string | null;
  deviceFeatures: string[];
  deviceMaxBufferSize: number | null;
  deviceMaxStorageBufferBindingSize: number | null;
  correctnessProbe: CorrectnessProbeStatus | null;
  correctnessProbeMs: number | null;
  correctnessProbeSubgroupSize: number | null;
} {
  const joined = typeof text === 'string' ? text : Array.isArray(text) ? text.join('\n') : '';
  const ready = /ggml_webgpu: device ready \(([^)]+)\)/iu.exec(joined);
  const feat =
    /ggml_webgpu: device features: shader-f16=(true|false) subgroups=(true|false)/iu.exec(joined);
  const limits =
    /ggml_webgpu: device limits: maxBufferSize=(\d+) maxStorageBufferBindingSize=(\d+)/iu.exec(
      joined,
    );
  const probeOk =
    /ggml_webgpu: correctness probe: ok subgroups=(true|false) subgroup_size=(\d+) add=\d+ ms=([0-9.]+)/iu.exec(
      joined,
    );
  const probeFailed = /ggml_webgpu: correctness probe failed/iu.test(joined);
  const probeDisabled = /ggml_webgpu: correctness probe: disabling subgroups/iu.test(joined);
  const deviceFeatures: string[] = [];
  if (feat?.[1] === 'true') deviceFeatures.push('shader-f16');
  if (feat?.[2] === 'true' && !probeDisabled && probeOk?.[1] !== 'false') {
    deviceFeatures.push('subgroups');
  }
  let correctnessProbe: CorrectnessProbeStatus | null = null;
  if (probeFailed) correctnessProbe = 'failed';
  else if (probeDisabled || probeOk?.[1] === 'false') correctnessProbe = 'subgroups-disabled';
  else if (probeOk) correctnessProbe = 'ok';
  return {
    deviceStage: ready?.[1] ?? null,
    deviceFeatures,
    deviceMaxBufferSize: limits ? Number(limits[1]) : null,
    deviceMaxStorageBufferBindingSize: limits ? Number(limits[2]) : null,
    correctnessProbe,
    correctnessProbeMs: probeOk ? Number(probeOk[3]) : null,
    correctnessProbeSubgroupSize: probeOk ? Number(probeOk[2]) : null,
  };
}

/** Intel UHD/Iris and AMD "Radeon Graphics" iGPUs, not Arc / RX discrete cards. */
export function looksIntegratedGpu(
  diagnostic: Pick<GpuDiagnostic, 'vendor' | 'architecture' | 'description' | 'fallbackAdapter'>,
): boolean {
  if (diagnostic.fallbackAdapter === true) return true;
  const vendor = (diagnostic.vendor ?? '').toLowerCase();
  const arch = (diagnostic.architecture ?? '').toLowerCase();
  const desc = (diagnostic.description ?? '').toLowerCase();
  const blob = `${arch} ${desc}`;
  if (/\brx\s*\d|radeon\s+pro|\barc\b|xe-hpg|alchemist/.test(blob)) return false;
  if (vendor.includes('intel')) return true;
  if (vendor.includes('amd') || vendor.includes('ati')) {
    return /radeon(?:\(tm\))? graphics/.test(desc) && !/\brx\s*\d/.test(desc);
  }
  return false;
}

export function mergeGpuDiagnostic(
  adapter: GpuDiagnostic | null | undefined,
  error: string | null | undefined,
  logLines?: readonly string[] | null,
): GpuDiagnostic {
  const base = adapter
    ? {
        ...adapter,
        features: [...adapter.features],
        deviceFeatures: [...adapter.deviceFeatures],
        adapterAttempts: [...adapter.adapterAttempts],
      }
    : { ...EMPTY_GPU_DIAGNOSTIC };
  const parsed = parseWebGpuLog(logLines ?? error ?? '');
  if (parsed.deviceStage) base.deviceStage = parsed.deviceStage;
  if (parsed.deviceFeatures.length > 0) base.deviceFeatures = parsed.deviceFeatures;
  if (parsed.deviceMaxBufferSize !== null) base.deviceMaxBufferSize = parsed.deviceMaxBufferSize;
  if (parsed.deviceMaxStorageBufferBindingSize !== null) {
    base.deviceMaxStorageBufferBindingSize = parsed.deviceMaxStorageBufferBindingSize;
  }
  if (parsed.correctnessProbe) base.correctnessProbe = parsed.correctnessProbe;
  if (parsed.correctnessProbeMs !== null) base.correctnessProbeMs = parsed.correctnessProbeMs;
  if (parsed.correctnessProbeSubgroupSize !== null) {
    base.correctnessProbeSubgroupSize = parsed.correctnessProbeSubgroupSize;
  }
  if (error && error.length > 0) base.error = error;
  if (looksIntegratedGpu(base)) base.hint = INTEGRATED_GPU_HINT;
  return applyDebugOverlay(base);
}

export function applyDebugOverlay(diagnostic: GpuDiagnostic): GpuDiagnostic {
  const profile = webGpuDebugProfile();
  if (profile === 'off') return { ...diagnostic, debugProfile: diagnostic.debugProfile };
  const next = {
    ...diagnostic,
    features: [...diagnostic.features],
    deviceFeatures: [...diagnostic.deviceFeatures],
    adapterAttempts: [...diagnostic.adapterAttempts],
    debugProfile: profile,
  };
  if (profile === 'amd-rdna3') {
    next.vendor = AMD_RDNA3_SIMULATED_LIMITS.vendor;
    next.architecture = AMD_RDNA3_SIMULATED_LIMITS.architecture;
    next.description = AMD_RDNA3_SIMULATED_LIMITS.description;
    next.maxBufferSize = AMD_RDNA3_SIMULATED_LIMITS.maxBufferSize;
    next.maxStorageBufferBindingSize = AMD_RDNA3_SIMULATED_LIMITS.maxStorageBufferBindingSize;
    next.maxComputeWorkgroupStorageSize = AMD_RDNA3_SIMULATED_LIMITS.maxComputeWorkgroupStorageSize;
    next.maxComputeInvocationsPerWorkgroup =
      AMD_RDNA3_SIMULATED_LIMITS.maxComputeInvocationsPerWorkgroup;
    next.shaderF16 = AMD_RDNA3_SIMULATED_LIMITS.shaderF16;
    next.subgroups = AMD_RDNA3_SIMULATED_LIMITS.subgroups;
    // Subgroup min/max stay the adapter's reported values. C++ only caps buffer
    // limits for this profile; a fake 32–64 range would lie in the diagnostic
    // (and must not reach shaders — a wrong size silently mistranslates).
  } else if (profile === 'intel-arc') {
    next.vendor = INTEL_ARC_SIMULATED_LIMITS.vendor;
    next.architecture = INTEL_ARC_SIMULATED_LIMITS.architecture;
    next.description = INTEL_ARC_SIMULATED_LIMITS.description;
    next.maxBufferSize = INTEL_ARC_SIMULATED_LIMITS.maxBufferSize;
    next.maxStorageBufferBindingSize = INTEL_ARC_SIMULATED_LIMITS.maxStorageBufferBindingSize;
    next.maxComputeWorkgroupStorageSize = INTEL_ARC_SIMULATED_LIMITS.maxComputeWorkgroupStorageSize;
    next.maxComputeInvocationsPerWorkgroup =
      INTEL_ARC_SIMULATED_LIMITS.maxComputeInvocationsPerWorkgroup;
    next.shaderF16 = INTEL_ARC_SIMULATED_LIMITS.shaderF16;
    next.subgroups = INTEL_ARC_SIMULATED_LIMITS.subgroups;
  } else if (profile === 'no-f16') {
    next.shaderF16 = false;
    next.features = next.features.filter((name) => name !== 'shader-f16');
  } else if (profile === 'reject-max-limits') {
    if (!next.description?.includes(REJECT_MAX_NOTE)) {
      next.description = next.description
        ? `${next.description} (${REJECT_MAX_NOTE})`
        : REJECT_MAX_NOTE;
    }
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
    line('deviceStage', diagnostic.deviceStage),
    diagnostic.deviceFeatures.length > 0
      ? `deviceFeatures: ${diagnostic.deviceFeatures.join(', ')}`
      : null,
    line('deviceMaxBufferSize', diagnostic.deviceMaxBufferSize),
    line('deviceMaxStorageBufferBindingSize', diagnostic.deviceMaxStorageBufferBindingSize),
    line('debugProfile', diagnostic.debugProfile),
    line('correctnessProbe', diagnostic.correctnessProbe),
    line('correctnessProbeMs', diagnostic.correctnessProbeMs),
    line('correctnessProbeSubgroupSize', diagnostic.correctnessProbeSubgroupSize),
    diagnostic.hint ? `hint: ${diagnostic.hint}` : null,
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
    diagnostic.adapterAttempts.length === 0 &&
    diagnostic.deviceStage === null &&
    diagnostic.hint === null
  );
}
