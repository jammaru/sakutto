import { describe, expect, it } from 'vitest';
import {
  CONTEXT_TOKENS,
  cpuFallback,
  selectBackend,
  selectionForTier,
  WEBGPU_ALL_LAYERS,
} from '@/engine/in-browser/backend';
import { DEFAULT_MODEL_ID, getModel, isModelId, MODEL_CATALOG } from '@/engine/model/catalog';

describe('backend selection', () => {
  it('uses every GPU layer and two slots when WebGPU is available', () => {
    expect(selectBackend({ webgpu: true, hardwareConcurrency: 4 })).toEqual({
      tier: 'g',
      backend: 'webgpu',
      nGpuLayers: WEBGPU_ALL_LAYERS,
      nThreads: 4,
      nParallel: 2,
      nCtx: CONTEXT_TOKENS * 2,
    });
  });

  it('runs eight threads sequentially on a CPU tier with enough cores', () => {
    expect(selectBackend({ webgpu: false, hardwareConcurrency: 12 })).toEqual({
      tier: 'c8',
      backend: 'cpu-wasm',
      nGpuLayers: 0,
      nThreads: 8,
      nParallel: 1,
      nCtx: CONTEXT_TOKENS,
    });
  });

  it('caps a small CPU at four threads', () => {
    expect(selectBackend({ webgpu: false, hardwareConcurrency: 4 })).toMatchObject({
      tier: 'c4',
      backend: 'cpu-wasm',
      nThreads: 4,
      nParallel: 1,
    });
    expect(selectBackend({ webgpu: false, hardwareConcurrency: 1 }).nThreads).toBe(1);
    expect(selectBackend({ webgpu: false, hardwareConcurrency: 0 }).nThreads).toBe(1);
  });

  it('falls back from WebGPU to a matching CPU tier', () => {
    expect(cpuFallback(selectBackend({ webgpu: true, hardwareConcurrency: 12 }))).toMatchObject({
      tier: 'c8',
      backend: 'cpu-wasm',
      nGpuLayers: 0,
      nThreads: 8,
    });
    expect(cpuFallback(selectBackend({ webgpu: true, hardwareConcurrency: 4 }))).toMatchObject({
      tier: 'c4',
      backend: 'cpu-wasm',
      nThreads: 4,
    });
    expect(cpuFallback(selectBackend({ webgpu: false, hardwareConcurrency: 8 }))).toBeNull();
  });

  it('lets a saved preference force the CPU tier on a GPU machine', () => {
    const probe = { webgpu: true, hardwareConcurrency: 12 };
    expect(selectionForTier('auto', probe).tier).toBe('g');
    expect(selectionForTier('c4', probe)).toMatchObject({
      tier: 'c4',
      backend: 'cpu-wasm',
      nThreads: 4,
      nParallel: 1,
    });
    expect(selectionForTier('c8', { webgpu: false, hardwareConcurrency: 4 })).toMatchObject({
      tier: 'c8',
      nThreads: 4,
    });
  });
});

describe('model catalog', () => {
  it('pins the default model commit, size and digest', () => {
    const entry = getModel(DEFAULT_MODEL_ID);

    expect(entry.repository).toBe('pfnet/plamo-3-translate-0.8b-GGUF');
    expect(entry.file).toBe('plamo-3-translate-0.8b-Q4_K_M.gguf');
    expect(entry.commit).toBe('03891e907db8a43c97d3a7c75add125cc6d1f96a');
    expect(entry.size).toBe(573_116_288);
    expect(entry.sha256).toBe('3dbb09295bfd3350231ba0dba92bc72cb14111ef1b034e37dad39d581bd86b9c');
    expect(entry.url).toBe(
      'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/03891e907db8a43c97d3a7c75add125cc6d1f96a/plamo-3-translate-0.8b-Q4_K_M.gguf',
    );
  });

  it('pins the optional 2B model with the same verification data', () => {
    const entry = MODEL_CATALOG['plamo-3-translate-2b-q4_k_m'];

    expect(entry.repository).toBe('pfnet/plamo-3-translate-2b-GGUF');
    expect(entry.commit).toBe('f2b4599dff9b3e45c62567eac15e83186b4cb64e');
    expect(entry.size).toBe(1_807_192_480);
    expect(entry.sha256).toBe('2c288ecc7ebfe60c3561726580da3583767f3c41ca3ef5c6825bf6c4cc060787');
  });

  it('validates model identifiers', () => {
    expect(isModelId(DEFAULT_MODEL_ID)).toBe(true);
    expect(isModelId('plamo-3-translate-2b-q4_k_m')).toBe(true);
    expect(isModelId('plamo-3-translate-8b-q4_k_m')).toBe(false);
    expect(isModelId(null)).toBe(false);
  });
});
