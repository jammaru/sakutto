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
  it('uses every GPU layer and one slot when WebGPU is available', () => {
    expect(selectBackend({ webgpu: true, hardwareConcurrency: 4 })).toEqual({
      tier: 'g',
      backend: 'webgpu',
      nGpuLayers: WEBGPU_ALL_LAYERS,
      nThreads: 4,
      nParallel: 1,
      nCtx: CONTEXT_TOKENS,
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
    expect(entry.commit).toBe('dbeb0856cb0b004b484f190bb71dd65876297013');
    expect(entry.size).toBe(573_123_200);
    expect(entry.sha256).toBe('923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd');
    expect(entry.url).toBe(
      'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/dbeb0856cb0b004b484f190bb71dd65876297013/plamo-3-translate-0.8b-Q4_K_M.gguf',
    );
  });

  it('pins the optional 2B model with the same verification data', () => {
    const entry = MODEL_CATALOG['plamo-3-translate-2b-q4_k_m'];

    expect(entry.repository).toBe('pfnet/plamo-3-translate-2b-GGUF');
    expect(entry.commit).toBe('232fbd7916519edecddfdae0beae7e76fe70453f');
    expect(entry.size).toBe(1_807_199_392);
    expect(entry.sha256).toBe('f36d0813dd95573a852ab5d76e374c543632d9e292929e922bcdbf7e53b494e0');
  });

  it('validates model identifiers', () => {
    expect(isModelId(DEFAULT_MODEL_ID)).toBe(true);
    expect(isModelId('plamo-3-translate-2b-q4_k_m')).toBe(true);
    expect(isModelId('plamo-3-translate-8b-q4_k_m')).toBe(false);
    expect(isModelId(null)).toBe(false);
  });
});
