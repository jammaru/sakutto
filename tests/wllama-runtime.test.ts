import { beforeEach, describe, expect, it, vi } from 'vitest';
import { selectBackend } from '@/engine/in-browser/backend';
import { createWllamaRuntime, gpuEvidence } from '@/engine/in-browser/runtime';
import type { WllamaLogger } from '@/engine/wllama/module';

const native = vi.hoisted(() => ({
  log: [] as string[],
  loadModel: vi.fn(),
  exit: vi.fn(async () => undefined),
}));

vi.mock('@/engine/wllama', () => ({
  createWllama: vi.fn(async (options: { logger: WllamaLogger }) => ({
    loadModel: vi.fn(async (...args: unknown[]) => {
      native.loadModel(...args);
      for (const line of native.log) options.logger.log(line);
    }),
    exit: native.exit,
  })),
}));

const gpu = selectBackend({ webgpu: true, hardwareConcurrency: 8 });
const cpu = selectBackend({ webgpu: false, hardwareConcurrency: 8 });

beforeEach(() => {
  native.log = [];
  native.loadModel.mockClear();
  native.exit.mockClear();
});

describe('gpu evidence in the llama.cpp load log', () => {
  it('sees a model that landed on the GPU', () => {
    expect(gpuEvidence(['llama_model_load_from_file_impl: using device WebGPU (Apple M2)'])).toBe(
      'engaged',
    );
    expect(gpuEvidence(['load_tensors: offloaded 29/29 layers to GPU'])).toBe('engaged');
  });

  it('sees a model that stayed on the CPU', () => {
    expect(gpuEvidence(['load_tensors: offloaded 0/29 layers to GPU'])).toBe('missing');
    expect(gpuEvidence(['ggml_webgpu: Failed to get an adapter'])).toBe('missing');
    expect(gpuEvidence(['load_tensors:   CPU_Mapped model buffer size = 500.00 MiB'])).toBe(
      'missing',
    );
  });

  it('leaves a log it cannot read alone', () => {
    expect(gpuEvidence([])).toBe('unknown');
    expect(gpuEvidence(['llama_context: n_ctx = 4096'])).toBe('unknown');
  });
});

describe('wllama runtime load', () => {
  it('asks llama.cpp for the INFO log and keeps the tier settings', async () => {
    native.log = ['load_tensors: offloaded 29/29 layers to GPU'];
    const runtime = await createWllamaRuntime(new Blob(), gpu);

    expect(runtime.backend).toBe('webgpu');
    expect(runtime.parallel).toBe(1);
    expect(native.loadModel).toHaveBeenCalledWith(
      [expect.any(Blob)],
      expect.objectContaining({
        n_ctx: 2048,
        n_parallel: 1,
        ctx_shift: false,
        log_level: 2,
      }),
    );
  });

  it('rejects a WebGPU load that llama.cpp quietly ran on the CPU', async () => {
    native.log = [
      'ggml_webgpu: Failed to get a device',
      'load_tensors: offloaded 0/29 layers to GPU',
    ];

    await expect(createWllamaRuntime(new Blob(), gpu)).rejects.toMatchObject({
      code: 'gpu-unavailable',
    });
    expect(native.exit).toHaveBeenCalled();
  });

  it('does not second-guess a CPU load or a log without device lines', async () => {
    native.log = ['load_tensors: offloaded 0/29 layers to GPU'];
    await expect(createWllamaRuntime(new Blob(), cpu)).resolves.toMatchObject({
      backend: 'cpu-wasm',
      parallel: 1,
    });

    native.log = [];
    await expect(createWllamaRuntime(new Blob(), gpu)).resolves.toMatchObject({
      backend: 'webgpu',
    });
  });
});
