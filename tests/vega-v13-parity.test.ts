import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTranslationPrompt } from '@/engine/prompt/pfml3';
import { warmup } from '@/engine/offscreen/host';
import { amdWave64SafePath } from '@/shared/webgpu-adapter';
import { FakeRuntime } from './support/fakes';

const RUNTIME_SOURCE = readFileSync(
  new URL('../src/engine/in-browser/runtime.ts', import.meta.url),
  'utf8',
);
const PATCH_0015 = readFileSync(
  new URL('../scripts/wllama/patches/0015-webgpu-wave64-vendor-gate.patch', import.meta.url),
  'utf8',
);
const PATCH_0016 = readFileSync(
  new URL(
    '../scripts/wllama/patches/0016-webgpu-masked-tile-skip-vendor-gate.patch',
    import.meta.url,
  ),
  'utf8',
);
const PATCH_0010 = readFileSync(
  new URL('../scripts/wllama/patches/0010-webgpu-mat-vec-workgroup.patch', import.meta.url),
  'utf8',
);
const PATCH_0014 = readFileSync(
  new URL(
    '../scripts/wllama/patches/0014-webgpu-flash-attn-skip-masked-tiles.patch',
    import.meta.url,
  ),
  'utf8',
);

/**
 * The exact prompt the v1.3.0 warm-up built for a ja target. AMD/ATI WebGPU must keep
 * feeding the model the same bytes: that build is the reference for correct AMD decode.
 */
const V13_JA_WARMUP_PROMPT =
  '<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en' +
  '<|plamo:msg|>Hello.<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form' +
  '<|plamo:val|>polite<|plamo:msg|>';

describe('v1.3.0 WebGPU inference parity on AMD/ATI adapters', () => {
  it('warm-up sends the v1.3.0 prompt with the same 16-token budget', async () => {
    const runtime = new FakeRuntime(() => 'こんにちは。');
    await warmup(runtime, 'ja');

    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.maxTokens).toBe(16);
    expect(runtime.requests[0]?.prompt).toBe(V13_JA_WARMUP_PROMPT);
    expect(buildTranslationPrompt({ text: 'Hello.', src: 'en', tgt: 'ja', form: 'polite' })).toBe(
      V13_JA_WARMUP_PROMPT,
    );
  });

  it('still rejects a collapsed warm-up, so a broken GPU decode cannot ship', async () => {
    const gpu = new FakeRuntime(() => ',3'.repeat(200), 1, 'webgpu');
    gpu.fillBudget = true;
    await expect(warmup(gpu, 'ja')).rejects.toMatchObject({
      code: 'gpu-unavailable',
      detail: 'degenerate warmup',
    });
  });

  it('keeps greedy sampling and the v1.3.0 model-load parameters', () => {
    expect(RUNTIME_SOURCE).toContain('temperature: 0');
    expect(RUNTIME_SOURCE).not.toMatch(/temperature:\s*[1-9]/);
    expect(RUNTIME_SOURCE).not.toContain('top_p');
    expect(RUNTIME_SOURCE).not.toContain('top_k');

    // The loadModel option block every vendor sends, unchanged since v1.3.0.
    for (const marker of [
      'n_ctx: selection.nCtx,',
      'n_gpu_layers: selection.nGpuLayers,',
      'n_parallel: selection.nParallel,',
      'swa_full: true,',
      'ctx_shift: false,',
    ]) {
      expect(RUNTIME_SOURCE).toContain(marker);
    }
  });

  it('gates the wave64-risk kernel paths so AMD keeps the v1.3.0 shaders', () => {
    // 0015: vec flash-attn off and the GPU argmax off for AMD/ATI adapters only.
    expect(PATCH_0015).toContain('ggml_webgpu_adapter_is_amd(ctx->webgpu_global_ctx->vendor');
    expect(PATCH_0015).toContain('!ggml_backend_webgpu_dev_is_amd(model.dev_output())');
    // 0016: the masked-tile skip needs its define, and the define is off AMD only.
    expect(PATCH_0016).toContain('#if defined(MASK) && defined(SKIP_MASKED_TILES)');
    expect(PATCH_0016).toContain(
      '!ggml_webgpu_adapter_is_amd(context.vendor, context.architecture)',
    );
    expect(PATCH_0016).toContain('defines.push_back("SKIP_MASKED_TILES");');
    // 0014 keeps a no-skip fallback branch, and 0016 routes AMD into it: each tile
    // staged and scored, a row bounded only by its own row_active, the v1.3.0 decode.
    expect(PATCH_0014).toContain('+        let live_row = row_active;');
    expect(PATCH_0014).toContain('+        let live_tile = true;');
    // 0010 already keeps the smaller mat-vec workgroup off other vendors.
    expect(PATCH_0010).toContain('context.vendor == "nvidia"');

    // The TypeScript mirror agrees on which vendors take the safe path.
    expect(amdWave64SafePath('amd')).toBe(true);
    expect(amdWave64SafePath('ati')).toBe(true);
    expect(amdWave64SafePath('nvidia')).toBe(false);
    expect(amdWave64SafePath('apple')).toBe(false);
    expect(amdWave64SafePath('intel')).toBe(false);
    expect(amdWave64SafePath(null)).toBe(false);
  });
});
