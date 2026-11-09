import { afterEach, describe, expect, it } from 'vitest';
import {
  AMD_RDNA3_SIMULATED_LIMITS,
  applyDebugOverlay,
  EMPTY_GPU_DIAGNOSTIC,
  formatGpuDiagnostic,
  gpuFailureExcerpt,
  isGpuDiagnostic,
  mergeGpuDiagnostic,
  resetWebGpuDebugProfile,
  setWebGpuDebugProfile,
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
    expect(overlay.subgroupMaxSize).toBe(64);
    expect(overlay.debugProfile).toBe('amd-rdna3');
  });

  it('overlays a missing shader-f16 and a wave64 subgroup', () => {
    setWebGpuDebugProfile('no-f16');
    expect(
      applyDebugOverlay({ ...EMPTY_GPU_DIAGNOSTIC, shaderF16: true, features: ['shader-f16'] })
        .shaderF16,
    ).toBe(false);

    setWebGpuDebugProfile('subgroup-64');
    const wave = applyDebugOverlay({
      ...EMPTY_GPU_DIAGNOSTIC,
      subgroupMinSize: 32,
      subgroupMaxSize: 32,
    });
    expect(wave.subgroupMinSize).toBe(64);
    expect(wave.subgroupMaxSize).toBe(64);
  });

  it('keeps an existing error when merging a later adapter snapshot', () => {
    const merged = mergeGpuDiagnostic(amdLike, 'ggml_webgpu: adapter lacks shader-f16');
    expect(merged.vendor).toBe('amd');
    expect(merged.error).toBe('ggml_webgpu: adapter lacks shader-f16');
  });
});
