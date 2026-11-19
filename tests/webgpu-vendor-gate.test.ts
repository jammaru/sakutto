import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diagnosticFromAdapter, nvidiaMeasuredFastPaths } from '@/shared/webgpu-adapter';

// The wasm gate is patch 0015; these assertions keep the TypeScript mirror honest.
const PATCH = readFileSync(
  new URL('../scripts/wllama/patches/0015-webgpu-wave64-vendor-gate.patch', import.meta.url),
  'utf8',
);

function adapter(
  overrides: {
    vendor?: string;
    architecture?: string;
    description?: string;
    features?: string[];
    subgroupMinSize?: number;
    subgroupMaxSize?: number;
  } = {},
) {
  return {
    features: new Set(overrides.features ?? ['shader-f16', 'subgroups']),
    limits: {
      maxBufferSize: 2_147_483_644,
      maxStorageBufferBindingSize: 2_147_483_644,
      maxComputeWorkgroupStorageSize: 32_768,
      maxComputeInvocationsPerWorkgroup: 1_024,
    },
    info: {
      vendor: overrides.vendor ?? 'amd',
      architecture: overrides.architecture ?? 'gfx902',
      device: 'Vega 8',
      description: overrides.description ?? 'AMD Radeon(TM) Vega 8 Graphics',
      subgroupMinSize: overrides.subgroupMinSize ?? 32,
      subgroupMaxSize: overrides.subgroupMaxSize ?? 32,
    },
  };
}

describe('WebGPU vendor gate for wave64 fast paths', () => {
  it('keeps a Vega iGPU that probes a 32-wide subgroup on the safe path', () => {
    // A Dawn D3D12 path can report 32 while the hardware runs wave64, so the vendor
    // gate must not depend on the probed width.
    const diagnostic = diagnosticFromAdapter(adapter({}));
    expect(diagnostic.vendor).toBe('amd');
    expect(diagnostic.subgroups).toBe(true);
    expect(diagnostic.shaderF16).toBe(true);

    expect(nvidiaMeasuredFastPaths(diagnostic.vendor)).toBe(false);
    expect(PATCH).toContain('ctx->webgpu_global_ctx->vendor != "nvidia"');
    expect(PATCH).toContain('caps.flash_attn_vec        = false;');
    expect(PATCH).toContain('caps.wide_subgroup_shuffle = false;');
  });

  it('keeps a Vega iGPU that probes a 64-wide subgroup on the safe path too', () => {
    const diagnostic = diagnosticFromAdapter(adapter({ subgroupMinSize: 32, subgroupMaxSize: 64 }));
    expect(diagnostic.subgroupMaxSize).toBe(64);

    expect(nvidiaMeasuredFastPaths(diagnostic.vendor)).toBe(false);
    // The 0009 width gate stays in place; the vendor gate only removes the
    // "a probed 32 keeps vec on" hole for vendors that were never measured.
    expect(PATCH).not.toContain('-        if (subgroup_size > 32u');
  });

  it('keeps the NVIDIA fast path unchanged when the probe allows it', () => {
    const diagnostic = diagnosticFromAdapter(
      adapter({
        vendor: 'nvidia',
        architecture: 'turing',
        description: 'NVIDIA GeForce RTX 4090',
        subgroupMinSize: 32,
        subgroupMaxSize: 32,
      }),
    );
    expect(diagnostic.vendor).toBe('nvidia');
    expect(diagnostic.subgroups).toBe(true);
    expect(diagnostic.shaderF16).toBe(true);

    // NVIDIA is excluded by the gate, so its probe result decides as before.
    expect(nvidiaMeasuredFastPaths(diagnostic.vendor)).toBe(true);
    expect(PATCH).toContain('if (ctx->webgpu_global_ctx->vendor != "nvidia") {');
    // No new probe kernel and no shader edit: nothing extra runs on NVIDIA at startup.
    const addedLines = PATCH.split('\n').filter((line) => line.startsWith('+'));
    expect(addedLines.some((line) => line.includes('static const char * ggml_webgpu_probe'))).toBe(
      false,
    );
    expect(PATCH).not.toContain('.wgsl');
  });

  it('gates the backend argmax the same way, so other vendors scan logits on the CPU', () => {
    const diagnostic = diagnosticFromAdapter(adapter({ vendor: 'intel' }));
    expect(nvidiaMeasuredFastPaths(diagnostic.vendor)).toBe(false);
    expect(nvidiaMeasuredFastPaths('nvidia')).toBe(true);
    expect(nvidiaMeasuredFastPaths(null)).toBe(false);
    expect(nvidiaMeasuredFastPaths(undefined)).toBe(false);

    expect(PATCH).toContain(
      'GGML_BACKEND_API bool ggml_backend_webgpu_dev_is_nvidia(ggml_backend_dev_t dev);',
    );
    expect(PATCH).toContain('bool ggml_backend_webgpu_dev_is_nvidia(ggml_backend_dev_t dev) {');
    expect(PATCH).toContain('ctx->webgpu_global_ctx->vendor == "nvidia"');
    expect(PATCH).toContain('ggml_backend_webgpu_dev_is_nvidia(model.dev_output())');
  });

  it('logs the vendor next to the vec decision and leaves the #63 safety net alone', () => {
    expect(PATCH).toContain('ok vendor=%s subgroups=%s subgroup_size=%u');
    expect(PATCH).toContain('wide_shuffle=%s vec=%s');
    // The detector and the per-piece CPU retry are untouched: the patch only
    // changes which shaders a vendor may run, so a broken decode still falls back.
    expect(PATCH).not.toContain('src/engine/');
    expect(PATCH).not.toContain('collapse');
    expect(PATCH).not.toContain('retryOnCpu');
  });
});
