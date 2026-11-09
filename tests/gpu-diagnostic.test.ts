import { afterEach, describe, expect, it } from 'vitest';
import {
  AMD_RDNA3_SIMULATED_LIMITS,
  applyDebugOverlay,
  EMPTY_GPU_DIAGNOSTIC,
  formatGpuDiagnostic,
  gpuFailureExcerpt,
  INTEGRATED_GPU_HINT,
  isGpuDiagnostic,
  isWebGpuDebugProfile,
  looksIntegratedGpu,
  mergeGpuDiagnostic,
  offscreenDocumentMatches,
  offscreenDocumentUrl,
  parseWebGpuLog,
  reportedSubgroupRange,
  resetWebGpuDebugProfile,
  resolveWebGpuDebugProfile,
  setWebGpuDebugProfile,
  subgroupShadersEnabled,
} from '@/shared/gpu-diagnostic';

const amdLike = {
  ...EMPTY_GPU_DIAGNOSTIC,
  vendor: 'amd',
  architecture: 'rdna3',
  description: 'AMD Radeon RX 7800 XT',
  fallbackAdapter: false,
  shaderF16: true,
  subgroups: true,
  subgroupMinSize: 32,
  subgroupMaxSize: 64,
  features: ['shader-f16', 'subgroups'],
  maxBufferSize: 2_147_483_644,
  maxStorageBufferBindingSize: 2_147_483_644,
  maxComputeWorkgroupStorageSize: 32_768,
  maxComputeInvocationsPerWorkgroup: 1_024,
  adapterAttempts: ['high-performance'],
};

afterEach(() => {
  resetWebGpuDebugProfile();
});

describe('gpu diagnostic', () => {
  it('formats a compact report without sending it anywhere', () => {
    const text = formatGpuDiagnostic({
      ...amdLike,
      error:
        'ggml_webgpu: Failed to get a device (adapter-max-limits optional-features): Limit maxBufferSize',
    });
    expect(text).toContain('Sakutto WebGPU diagnostic');
    expect(text).toContain('vendor: amd');
    expect(text).toContain('architecture: rdna3');
    expect(text).toContain('shader-f16: true');
    expect(text).toContain('subgroupMaxSize: 64');
    expect(text).toContain('maxStorageBufferBindingSize: 2147483644');
    expect(text).toContain('Failed to get a device');
    expect(text).not.toMatch(/https?:\/\//u);
  });

  it('accepts a well-formed payload and rejects a broken one', () => {
    expect(isGpuDiagnostic(amdLike)).toBe(true);
    expect(isGpuDiagnostic({ ...amdLike, vendor: 1 })).toBe(false);
    expect(isGpuDiagnostic({ ...amdLike, features: ['shader-f16', 1] })).toBe(false);
  });

  it('keeps llama.cpp WebGPU lines and drops the rest', () => {
    expect(
      gpuFailureExcerpt([
        'llama_context: n_ctx = 4096',
        'ggml_webgpu: Failed to get a device (capped-limits shader-f16): Limit exceeded',
        'load_tensors: offloaded 0/29 layers to GPU',
      ]),
    ).toBe(
      [
        'ggml_webgpu: Failed to get a device (capped-limits shader-f16): Limit exceeded',
        'load_tensors: offloaded 0/29 layers to GPU',
      ].join('\n'),
    );
    expect(gpuFailureExcerpt(['llama_context: n_ctx = 4096'])).toBeNull();
  });

  it('overlays AMD-like limits for the debug profile', () => {
    setWebGpuDebugProfile('amd-rdna3');
    const overlay = applyDebugOverlay({
      ...EMPTY_GPU_DIAGNOSTIC,
      vendor: 'nvidia',
      maxBufferSize: 4_294_967_296,
      shaderF16: true,
    });
    expect(overlay.vendor).toBe('amd');
    expect(overlay.maxStorageBufferBindingSize).toBe(
      AMD_RDNA3_SIMULATED_LIMITS.maxStorageBufferBindingSize,
    );
    expect(overlay.debugProfile).toBe('amd-rdna3');
  });

  it('keeps the adapter subgroup size under amd-rdna3 (C++ only caps buffers)', () => {
    setWebGpuDebugProfile('amd-rdna3');
    const overlay = applyDebugOverlay({
      ...EMPTY_GPU_DIAGNOSTIC,
      vendor: 'nvidia',
      subgroupMinSize: 32,
      subgroupMaxSize: 32,
    });
    expect(overlay.vendor).toBe('amd');
    expect(overlay.subgroupMinSize).toBe(32);
    expect(overlay.subgroupMaxSize).toBe(32);
  });

  it('overlays a missing shader-f16 without inventing a subgroup size', () => {
    setWebGpuDebugProfile('no-f16');
    expect(
      applyDebugOverlay({ ...EMPTY_GPU_DIAGNOSTIC, shaderF16: true, features: ['shader-f16'] })
        .shaderF16,
    ).toBe(false);

    expect(isWebGpuDebugProfile('subgroup-64')).toBe(false);
    const wave = applyDebugOverlay({
      ...EMPTY_GPU_DIAGNOSTIC,
      subgroupMinSize: 32,
      subgroupMaxSize: 32,
    });
    expect(wave.subgroupMinSize).toBe(32);
    expect(wave.subgroupMaxSize).toBe(32);
  });

  it('does not double the reject-max-limits description', () => {
    setWebGpuDebugProfile('reject-max-limits');
    const once = applyDebugOverlay({
      ...EMPTY_GPU_DIAGNOSTIC,
      description: 'NVIDIA GeForce RTX 4070 Ti SUPER',
    });
    const twice = applyDebugOverlay(once);
    expect(twice.description).toBe(
      'NVIDIA GeForce RTX 4070 Ti SUPER (debug: reject adapter-max requestDevice)',
    );
    expect(twice.description?.match(/debug: reject adapter-max requestDevice/gu)).toHaveLength(1);
  });

  it('treats an unknown or zero subgroup size as no subgroups', () => {
    expect(reportedSubgroupRange(0, 64)).toBeNull();
    expect(reportedSubgroupRange(32, 0)).toBeNull();
    expect(reportedSubgroupRange(null, 32)).toBeNull();
    expect(reportedSubgroupRange(64, 32)).toBeNull();
    expect(reportedSubgroupRange(32, 32)).toEqual({ min: 32, max: 32 });
    expect(subgroupShadersEnabled(true, 0, 64)).toBe(false);
    expect(subgroupShadersEnabled(true, 32, 32)).toBe(true);
    expect(subgroupShadersEnabled(false, 32, 32)).toBe(false);
  });

  it('keeps an existing error when merging a later adapter snapshot', () => {
    const merged = mergeGpuDiagnostic(amdLike, 'ggml_webgpu: adapter lacks shader-f16');
    expect(merged.vendor).toBe('amd');
    expect(merged.error).toBe('ggml_webgpu: adapter lacks shader-f16');
  });

  it('keeps the first and last llama.cpp WebGPU lines', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `ggml_webgpu: line ${index + 1}`);
    const excerpt = gpuFailureExcerpt(lines);
    expect(excerpt).toContain('ggml_webgpu: line 1');
    expect(excerpt).toContain('ggml_webgpu: line 20');
    expect(excerpt).toContain('...');
    expect(excerpt).not.toContain('ggml_webgpu: line 10');
  });

  it('reads granted device stage, features and limits from the wasm log', () => {
    const parsed = parseWebGpuLog([
      'ggml_webgpu: Failed to get a device (adapter-max-limits optional-features): Limit exceeded',
      'ggml_webgpu: device ready (capped-limits optional-features)',
      'ggml_webgpu: device features: shader-f16=true subgroups=true',
      'ggml_webgpu: device limits: maxBufferSize=2147483648 maxStorageBufferBindingSize=2147483644 maxComputeWorkgroupStorageSize=32768 maxComputeInvocationsPerWorkgroup=1024 min_subgroup_size=32 max_subgroup_size=64',
    ]);
    expect(parsed.deviceStage).toBe('capped-limits optional-features');
    expect(parsed.deviceFeatures).toEqual(['shader-f16', 'subgroups']);
    expect(parsed.deviceMaxStorageBufferBindingSize).toBe(2_147_483_644);
    const merged = mergeGpuDiagnostic(amdLike, null, [
      'ggml_webgpu: device ready (capped-limits optional-features)',
      'ggml_webgpu: device features: shader-f16=true subgroups=true',
      'ggml_webgpu: device limits: maxBufferSize=2147483648 maxStorageBufferBindingSize=2147483644',
    ]);
    expect(merged.deviceStage).toBe('capped-limits optional-features');
    expect(formatGpuDiagnostic(merged)).toContain('deviceStage: capped-limits optional-features');
  });

  it('reads the correctness probe and its cost from the wasm log', () => {
    const parsed = parseWebGpuLog([
      'ggml_webgpu: correctness probe: ok subgroups=true subgroup_size=32 add=136 ms=12.4',
    ]);
    expect(parsed.correctnessProbe).toBe('ok');
    expect(parsed.correctnessProbeMs).toBe(12.4);
    expect(parsed.correctnessProbeSubgroupSize).toBe(32);
    const disabled = parseWebGpuLog([
      'ggml_webgpu: correctness probe: disabling subgroups (hardware subgroup_size=32 not in [64,64])',
      'ggml_webgpu: correctness probe: ok subgroups=false subgroup_size=32 add=136 ms=8.1',
      'ggml_webgpu: device features: shader-f16=true subgroups=true',
    ]);
    expect(disabled.correctnessProbe).toBe('subgroups-disabled');
    expect(disabled.deviceFeatures).toEqual(['shader-f16']);
    expect(
      parseWebGpuLog(['ggml_webgpu: correctness probe failed; add sum 0 != 136']).correctnessProbe,
    ).toBe('failed');
    const merged = mergeGpuDiagnostic(amdLike, null, [
      'ggml_webgpu: correctness probe: ok subgroups=true subgroup_size=32 add=136 ms=12.4',
    ]);
    expect(formatGpuDiagnostic(merged)).toContain('correctnessProbe: ok');
    expect(formatGpuDiagnostic(merged)).toContain('correctnessProbeMs: 12.4');
  });

  it('treats Intel UHD and AMD Radeon Graphics as integrated', () => {
    expect(
      looksIntegratedGpu({
        vendor: 'intel',
        architecture: 'gen-12lp',
        description: 'Intel(R) UHD Graphics 770',
        fallbackAdapter: false,
      }),
    ).toBe(true);
    expect(
      looksIntegratedGpu({
        vendor: 'amd',
        architecture: '',
        description: 'AMD Radeon(TM) Graphics',
        fallbackAdapter: false,
      }),
    ).toBe(true);
    expect(
      looksIntegratedGpu({
        vendor: 'amd',
        architecture: 'rdna3',
        description: 'AMD Radeon RX 7800 XT',
        fallbackAdapter: false,
      }),
    ).toBe(false);
    const merged = mergeGpuDiagnostic(
      {
        ...EMPTY_GPU_DIAGNOSTIC,
        vendor: 'intel',
        description: 'Intel(R) UHD Graphics',
      },
      null,
    );
    expect(merged.hint).toBe(INTEGRATED_GPU_HINT);
  });

  it('puts the debug profile on the offscreen URL', () => {
    expect(offscreenDocumentUrl('offscreen.html', 'off')).toBe('offscreen.html');
    expect(offscreenDocumentUrl('offscreen.html', 'reject-max-limits')).toBe(
      'offscreen.html?webgpuDebug=reject-max-limits',
    );
    expect(
      offscreenDocumentMatches(
        'chrome-extension://id/offscreen.html?webgpuDebug=amd-rdna3',
        'chrome-extension://id/offscreen.html',
      ),
    ).toBe(true);
  });

  it('reads the debug profile from the host when chrome.storage is missing', async () => {
    const askHost = async () => 'reject-max-limits';
    await expect(
      resolveWebGpuDebugProfile({
        href: 'chrome-extension://id/offscreen.html',
        storage: null,
        askHost,
      }),
    ).resolves.toBe('reject-max-limits');
    expect((globalThis as { chrome?: unknown }).chrome).toBeUndefined();
  });

  it('prefers the offscreen URL param over storage', async () => {
    await expect(
      resolveWebGpuDebugProfile({
        href: 'chrome-extension://id/offscreen.html?webgpuDebug=no-f16',
        storage: { get: async () => ({ sakuttoWebGpuDebug: 'amd-rdna3' }) },
        askHost: async () => 'reject-max-limits',
      }),
    ).resolves.toBe('no-f16');
  });
});
