// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetWebGpuDebugProfile,
  setWebGpuDebugProfile,
  subgroupShadersEnabled,
} from '@/shared/gpu-diagnostic';
import {
  diagnosticFromAdapter,
  infoFromAdapter,
  requestAdapterWithPreferences,
  supportsFastBatches,
} from '@/shared/webgpu-adapter';

afterEach(() => {
  resetWebGpuDebugProfile();
});

function adapter(
  overrides: {
    vendor?: string;
    features?: string[];
    limits?: Record<string, number>;
    subgroupMinSize?: number;
    subgroupMaxSize?: number;
    isFallbackAdapter?: boolean;
  } = {},
) {
  const features = new Set(overrides.features ?? ['shader-f16', 'subgroups']);
  return {
    features,
    limits: {
      maxBufferSize: 2_147_483_644,
      maxStorageBufferBindingSize: 2_147_483_644,
      maxComputeWorkgroupStorageSize: 32_768,
      maxComputeInvocationsPerWorkgroup: 1_024,
      ...overrides.limits,
    },
    info: {
      vendor: overrides.vendor ?? 'amd',
      architecture: 'rdna3',
      description: 'AMD Radeon RX 7800 XT',
      subgroupMinSize: overrides.subgroupMinSize ?? 32,
      subgroupMaxSize: overrides.subgroupMaxSize ?? 64,
      ...(overrides.isFallbackAdapter !== undefined
        ? { isFallbackAdapter: overrides.isFallbackAdapter }
        : {}),
    },
    ...(overrides.isFallbackAdapter !== undefined
      ? { isFallbackAdapter: overrides.isFallbackAdapter }
      : {}),
  };
}

describe('WebGPU adapter selection', () => {
  it('asks for high-performance first and keeps a shader-f16 adapter', async () => {
    const amd = adapter();
    const requestAdapter = vi.fn(async (options?: { powerPreference?: string }) => {
      if (options?.powerPreference === 'high-performance') return amd;
      return null;
    });

    const result = await requestAdapterWithPreferences({ requestAdapter });

    expect(result.adapter).toBe(amd);
    expect(result.attempts).toEqual(['high-performance']);
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
  });

  it('falls through to default then low-power when high-performance has no f16', async () => {
    const iGpu = adapter({ vendor: 'amd', features: [], isFallbackAdapter: false });
    const dGpu = adapter({ vendor: 'amd', features: ['shader-f16'] });
    const requestAdapter = vi.fn(async (options?: { powerPreference?: string }) => {
      if (options?.powerPreference === 'high-performance') return iGpu;
      if (options === undefined || Object.keys(options).length === 0) return dGpu;
      return null;
    });

    const result = await requestAdapterWithPreferences({ requestAdapter });

    expect(result.adapter).toBe(dGpu);
    expect(result.attempts).toEqual(['high-performance', 'default']);
  });

  it('skips a fallback adapter', async () => {
    const fallback = adapter({ isFallbackAdapter: true, features: ['shader-f16'] });
    const real = adapter({ vendor: 'intel', features: ['shader-f16'] });
    const requestAdapter = vi.fn(async (options?: { powerPreference?: string }) => {
      if (options?.powerPreference === 'high-performance') return fallback;
      return real;
    });

    const result = await requestAdapterWithPreferences({ requestAdapter });
    expect(result.adapter).toBe(real);
  });

  it('records AMD-like limits, wave64, and missing shader-f16', () => {
    const diagnostic = diagnosticFromAdapter(
      adapter({
        features: ['subgroups'],
        subgroupMinSize: 32,
        subgroupMaxSize: 64,
        limits: { maxStorageBufferBindingSize: 2_147_483_644 },
      }),
    );
    expect(diagnostic.vendor).toBe('amd');
    expect(diagnostic.shaderF16).toBe(false);
    expect(diagnostic.subgroupMaxSize).toBe(64);
    expect(diagnostic.maxStorageBufferBindingSize).toBe(2_147_483_644);

    expect(infoFromAdapter(adapter({ vendor: 'amd' }), true).fastBatches).toBe(false);
    expect(infoFromAdapter(adapter({ vendor: 'nvidia' }), true).fastBatches).toBe(true);
    expect(infoFromAdapter(adapter({ vendor: 'intel' }), true).fastBatches).toBe(false);
  });

  it('does not invent a subgroup size when the adapter reports 0', () => {
    const diagnostic = diagnosticFromAdapter(
      adapter({
        subgroupMinSize: 0,
        subgroupMaxSize: 0,
      }),
    );
    expect(diagnostic.subgroupMinSize).toBe(0);
    expect(diagnostic.subgroupMaxSize).toBe(0);
    expect(
      subgroupShadersEnabled(
        diagnostic.subgroups,
        diagnostic.subgroupMinSize,
        diagnostic.subgroupMaxSize,
      ),
    ).toBe(false);
  });

  it('does not treat NVIDIA as fast batches under an AMD debug profile', () => {
    setWebGpuDebugProfile('amd-rdna3');
    expect(supportsFastBatches('nvidia', true)).toBe(false);
    expect(infoFromAdapter(adapter({ vendor: 'nvidia' }), true).fastBatches).toBe(false);
  });
});
