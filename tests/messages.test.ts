import { describe, expect, it } from 'vitest';
import { isEngineCapabilities } from '@/shared/capabilities';
import { isEngineStatus } from '@/shared/engine-status';
import {
  isEngineProbeResponse,
  isEngineStatusRequest,
  isModelCancelRequest,
  isModelDeleteRequest,
  isModelDownloadRequest,
  isModelProgressMessage,
  isModelUseRequest,
  isPageInfo,
  isPageInfoRequest,
  isPageViewState,
  isShortcutSnapshot,
} from '@/shared/messages';

const capabilities = {
  crossOriginIsolated: true,
  webgpu: 'ready',
  hardwareConcurrency: 8,
};

const modelStatus = {
  id: 'plamo-3-translate-0.8b-q4_k_m',
  state: 'downloading',
  received: 10,
  total: 20,
  progress: 0.5,
};

describe('message validation', () => {
  it('accepts well-formed page info and rejects other shapes', () => {
    expect(isPageInfo({ lang: 'en', translatableBlocks: 3 })).toBe(true);
    expect(isPageInfo({ lang: 'en', translatableBlocks: '3' })).toBe(false);
    expect(isPageInfo({ lang: 'en' })).toBe(false);
    expect(isPageInfo(null)).toBe(false);
    expect(isPageInfo([])).toBe(false);
  });

  it('validates the shortcut snapshot a page reads', () => {
    expect(
      isShortcutSnapshot({
        'translate-page': 'Alt+A',
        'toggle-bilingual': '⌥⇧B',
        'translate-selection': '',
        'translate-compose': 'Alt+T',
      }),
    ).toBe(true);
    // `null` is a command Chrome did not list; `''` is one the user unbound.
    expect(
      isShortcutSnapshot({
        'translate-page': null,
        'toggle-bilingual': '',
        'translate-selection': 'Alt+S',
        'translate-compose': null,
      }),
    ).toBe(true);
    expect(
      isShortcutSnapshot({
        'translate-page': 'Alt+A',
        'toggle-bilingual': 'Alt+B',
        'translate-selection': 'Alt+S',
      }),
    ).toBe(false);
    expect(
      isShortcutSnapshot({
        'translate-page': 'Alt+A',
        'toggle-bilingual': 1,
        'translate-selection': 'Alt+S',
        'translate-compose': 'Alt+T',
      }),
    ).toBe(false);
    expect(isShortcutSnapshot(null)).toBe(false);
  });

  it('matches only the page info request type', () => {
    expect(isPageInfoRequest({ type: 'page:info' })).toBe(true);
    expect(isPageInfoRequest({ type: 'page:other' })).toBe(false);
    expect(isPageInfoRequest(['page:info'])).toBe(false);
  });

  it('validates engine capabilities', () => {
    expect(isEngineCapabilities(capabilities)).toBe(true);
    expect(isEngineCapabilities({ ...capabilities, webgpu: 'maybe' })).toBe(false);
    expect(isEngineCapabilities({ ...capabilities, hardwareConcurrency: '8' })).toBe(false);
    expect(isEngineCapabilities({ ...capabilities, crossOriginIsolated: 'yes' })).toBe(false);
  });

  it('requires the offscreen source on probe responses', () => {
    expect(isEngineProbeResponse({ source: 'offscreen', capabilities })).toBe(true);
    expect(isEngineProbeResponse({ source: 'popup', capabilities })).toBe(false);
    expect(isEngineProbeResponse(capabilities)).toBe(false);
    expect(isEngineProbeResponse(null)).toBe(false);
  });

  it('validates the engine status request and payload', () => {
    expect(isEngineStatusRequest({ type: 'engine:status' })).toBe(true);
    expect(isEngineStatusRequest({ type: 'engine:status', extra: true })).toBe(true);
    expect(isEngineStatusRequest({ type: 'engine:probe' })).toBe(false);

    expect(
      isEngineStatus({
        model: modelStatus,
        backend: 'cpu-wasm',
        tier: 'c8',
        threads: 8,
        parallel: 1,
        plamoReady: false,
        chromeSupported: true,
        active: 'chrome',
      }),
    ).toBe(true);
    expect(
      isEngineStatus({
        model: modelStatus,
        backend: 'unknown',
        tier: 'c8',
        threads: 8,
        parallel: 1,
        plamoReady: false,
        chromeSupported: true,
        active: null,
      }),
    ).toBe(false);
    expect(
      isEngineStatus({
        model: { ...modelStatus, id: 'other-model' },
        backend: 'cpu-wasm',
        tier: 'c8',
        threads: 8,
        parallel: 1,
        plamoReady: false,
        chromeSupported: true,
        active: null,
      }),
    ).toBe(false);
  });

  it('validates model commands and progress broadcasts', () => {
    expect(
      isModelDownloadRequest({ type: 'model:download', modelId: 'plamo-3-translate-2b-q4_k_m' }),
    ).toBe(true);
    expect(isModelDownloadRequest({ type: 'model:download', modelId: 'nope' })).toBe(false);
    expect(isModelDownloadRequest({ type: 'model:download' })).toBe(false);

    expect(isModelCancelRequest({ type: 'model:cancel', modelId: modelStatus.id })).toBe(true);
    expect(isModelCancelRequest({ type: 'model:cancel', modelId: 1 })).toBe(false);

    expect(isModelDeleteRequest({ type: 'model:delete', modelId: modelStatus.id })).toBe(true);
    expect(isModelDeleteRequest({ type: 'model:delete' })).toBe(false);

    expect(isModelUseRequest({ type: 'model:use', modelId: modelStatus.id })).toBe(true);
    expect(isModelUseRequest({ type: 'model:use' })).toBe(false);

    expect(isModelProgressMessage({ type: 'model:progress', status: modelStatus })).toBe(true);
    expect(
      isModelProgressMessage({ type: 'model:progress', status: { ...modelStatus, state: 'nope' } }),
    ).toBe(false);
  });
});

describe('page view state contract', () => {
  const base = {
    active: true,
    display: 'replace',
    engine: 'plamo',
    pending: 0,
    done: 3,
    total: 3,
    host: 'example.com',
    auto: 'ask',
    targetLanguage: 'ja',
    pageLanguage: 'en',
    targetAdjusted: false,
    sameLanguage: false,
    tokensPerSecond: 12.5,
    segmentsPerSecond: 1.5,
  };

  it('carries the skipped-prose count the popup reports', () => {
    expect(isPageViewState({ ...base, skipped: 0 })).toBe(true);
    expect(isPageViewState({ ...base, skipped: 2 })).toBe(true);
    // Older content scripts do not send it; the popup must still accept their state.
    expect(isPageViewState(base)).toBe(true);
    expect(isPageViewState({ ...base, skipped: -1 })).toBe(false);
    expect(isPageViewState({ ...base, skipped: '2' })).toBe(false);
  });

  it('rejects a state that is missing a required field', () => {
    const { total, ...missing } = base;
    expect(total).toBe(3);
    expect(isPageViewState({ ...missing, skipped: 0 })).toBe(false);
  });
});
