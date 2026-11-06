import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID } from '@/engine/model/catalog';
import type { EngineStatus } from '@/shared/engine-status';
import { runtimeLabel } from '@/ui/runtime-label';

function status(overrides: Partial<EngineStatus> = {}): EngineStatus {
  return {
    model: {
      id: DEFAULT_MODEL_ID,
      state: 'loaded',
      received: 1,
      total: 1,
      progress: 1,
    },
    backend: 'webgpu',
    tier: 'g',
    threads: 8,
    parallel: 2,
    plamoReady: true,
    chromeSupported: true,
    active: 'plamo',
    ...overrides,
  };
}

describe('runtime label', () => {
  it('names the engine the page is actually using', () => {
    expect(runtimeLabel({ status: null, pageSimple: false, targetLanguage: 'ja' }).key).toBe(
      'runtimeChecking',
    );
    expect(
      runtimeLabel({
        status: status({
          model: {
            id: DEFAULT_MODEL_ID,
            state: 'downloading',
            received: 420_000_000,
            total: 1_000_000_000,
            progress: 0.42,
          },
          plamoReady: false,
          active: null,
        }),
        pageSimple: true,
        targetLanguage: 'ja',
      }),
    ).toEqual({ key: 'runtimeDownloading', substitutions: ['42', '420 MB', '1.00 GB'] });
    expect(
      runtimeLabel({
        status: status({
          model: {
            id: DEFAULT_MODEL_ID,
            state: 'verifying',
            received: 0,
            total: 1,
            progress: 0,
          },
        }),
        pageSimple: false,
        targetLanguage: 'ja',
      }).key,
    ).toBe('runtimeVerifying');
    expect(
      runtimeLabel({
        status: status({
          model: {
            id: DEFAULT_MODEL_ID,
            state: 'loading',
            received: 1,
            total: 1,
            progress: 1,
          },
        }),
        pageSimple: false,
        targetLanguage: 'ja',
      }).key,
    ).toBe('runtimeLoading');
    expect(runtimeLabel({ status: status(), pageSimple: false, targetLanguage: 'ja' }).key).toBe(
      'runtimePlamoGpu',
    );
    expect(
      runtimeLabel({
        status: status({ backend: 'cpu-wasm', tier: 'c8' }),
        pageSimple: false,
        targetLanguage: 'ja',
      }).key,
    ).toBe('runtimePlamoCpu');
    expect(
      runtimeLabel({
        status: status({ backend: 'cpu-wasm', tier: 'c8', gpuFallback: true }),
        pageSimple: false,
        targetLanguage: 'ja',
      }).key,
    ).toBe('runtimePlamoGpuFallback');
    expect(runtimeLabel({ status: status(), pageSimple: true, targetLanguage: 'ja' }).key).toBe(
      'runtimeChrome',
    );
    expect(runtimeLabel({ status: status(), pageSimple: false, targetLanguage: 'pt' }).key).toBe(
      'runtimeChrome',
    );
    expect(
      runtimeLabel({
        status: status({
          model: {
            id: DEFAULT_MODEL_ID,
            state: 'absent',
            received: 0,
            total: 1,
            progress: 0,
          },
          plamoReady: false,
          backend: null,
          tier: null,
          active: 'chrome',
        }),
        pageSimple: false,
        targetLanguage: 'pt',
      }).key,
    ).toBe('runtimeChrome');
    expect(
      runtimeLabel({
        status: status({
          model: {
            id: DEFAULT_MODEL_ID,
            state: 'absent',
            received: 0,
            total: 1,
            progress: 0,
          },
          plamoReady: false,
          backend: null,
          tier: null,
          active: null,
        }),
        pageSimple: false,
        targetLanguage: 'jv',
      }).key,
    ).toBe('runtimeWaiting');
  });
});
