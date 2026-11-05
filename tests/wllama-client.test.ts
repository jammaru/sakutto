import { describe, expect, it, vi } from 'vitest';
import type {
  Wllama,
  WllamaAssets,
  WllamaCompletionChunk,
  WllamaCompletionParams,
  WllamaConfig,
  WllamaLoadParams,
} from '@/engine/wllama/module';

const mocks = vi.hoisted(() => ({
  origin: 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef',
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      getURL: (path: string) => `${mocks.origin}/${path}`,
    },
  },
}));

const { createWllama } = await import('@/engine/wllama/client');

const EXPECTED_ASSETS: WllamaAssets = {
  default: `${mocks.origin}/vendor/wllama/wllama.wasm`,
  'wllama.worker.js': `${mocks.origin}/vendor/wllama/wllama-worker.js`,
  'wllama.module.js': `${mocks.origin}/vendor/wllama/wllama-module.js`,
  'wllama.pthread.js': `${mocks.origin}/vendor/wllama/wllama-pthread.js`,
  'wllama.compat.js': `${mocks.origin}/vendor/wllama/wllama-compat-module.js`,
  'wllama.compat.pthread.js': `${mocks.origin}/vendor/wllama/wllama-compat-pthread.js`,
  'wllama.compat.wasm': `${mocks.origin}/vendor/wllama/wllama-compat.wasm`,
};

describe('wllama client', () => {
  it('passes every packaged asset url to the Wllama constructor', async () => {
    const calls: { assets: WllamaAssets; config?: WllamaConfig }[] = [];

    class FakeWllama implements Wllama {
      constructor(assets: WllamaAssets, config?: WllamaConfig) {
        calls.push(config === undefined ? { assets } : { assets, config });
      }
      isModelLoaded(): boolean {
        return false;
      }
      async loadModel(blobs: Blob[], params?: WllamaLoadParams): Promise<void> {
        void blobs;
        void params;
      }
      async createCompletion(
        params: WllamaCompletionParams & {
          stream: true;
          onData: (chunk: WllamaCompletionChunk) => void;
        },
      ): Promise<void> {
        void params;
      }
      async exit(): Promise<void> {}
    }

    const loader = vi.fn(async () => ({ Wllama: FakeWllama }));
    const instance = await createWllama({
      suppressNativeLog: true,
      allowOffline: true,
      parallelDownloads: 2,
      loadModule: loader,
    });

    expect(instance).toBeInstanceOf(FakeWllama);
    expect(loader).toHaveBeenCalledWith(`${mocks.origin}/vendor/wllama/wllama.js`);
    expect(calls).toEqual([
      {
        assets: EXPECTED_ASSETS,
        config: { suppressNativeLog: true, allowOffline: true, parallelDownloads: 2 },
      },
    ]);
  });
});
