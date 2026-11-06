import { describe, expect, it } from 'vitest';
import { EngineError } from '@/engine/errors';
import { RoutingEngine, type PairSupport } from '@/engine/router';
import type { TranslateOptions, TranslationChunk } from '@/engine/types';
import { collectChunks, fakeEngine } from './support/fakes';

function options(overrides: Partial<TranslateOptions> = {}): TranslateOptions {
  return {
    tgt: 'ja',
    form: 'polite',
    priority: 10,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const CHUNK: TranslationChunk = { id: 'a', final: 'translated', engine: 'plamo' };

interface Setup {
  plamoSupports?: boolean;
  chromeSupport?: PairSupport;
  plamoChunks?: TranslationChunk[];
  chromeChunks?: TranslationChunk[];
  plamoError?: unknown;
}

function setup(config: Setup = {}) {
  const plamoChunks = config.plamoChunks ?? [CHUNK];
  const chromeChunks = config.chromeChunks ?? [{ id: 'a', final: 'chrome', engine: 'chrome' }];
  const plamo = fakeEngine('plamo', plamoChunks, { error: config.plamoError });
  const chrome = fakeEngine('chrome', chromeChunks);
  let chromeProbes = 0;

  const router = new RoutingEngine({
    plamo,
    chrome,
    plamoSupports: (_src, tgt) => config.plamoSupports ?? tgt === 'ja',
    chromeSupport: async () => {
      chromeProbes += 1;
      return config.chromeSupport ?? 'available';
    },
  });

  return {
    router,
    plamo,
    chrome,
    get chromeProbes() {
      return chromeProbes;
    },
  };
}

describe('RoutingEngine', () => {
  it('uses PLaMo when it supports the pair, without asking the built-in translator', async () => {
    const { router, plamo, chrome, chromeProbes } = setup();

    const chunks = await collectChunks(router.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(chromeProbes).toBe(0);

    expect(chunks).toEqual([CHUNK]);
    expect(router.activeEngine).toBe('plamo');
    expect(plamo.calls).toBe(1);
    expect(chrome.calls).toBe(0);
  });

  it('never paints built-in text for a pair PLaMo supports, even before the model loads', async () => {
    // A cold start is exactly when a Chrome draft used to appear. The router must send the
    // request to PLaMo, which waits for the runtime, instead of answering from Chrome.
    const { router, plamo, chrome } = setup({ plamoSupports: true });

    const chunks = await collectChunks(router.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(chunks).toEqual([{ id: 'a', final: 'translated', engine: 'plamo' }]);
    expect(plamo.calls).toBe(1);
    expect(chrome.calls).toBe(0);
  });

  it('routes languages PLaMo does not support to the built-in translator', async () => {
    const { router } = setup({ plamoSupports: false });
    const chunks = await collectChunks(
      router.translate([{ id: 'a', text: 'Hello.' }], options({ tgt: 'cs' })),
    );

    expect(chunks).toEqual([{ id: 'a', final: 'chrome', engine: 'chrome' }]);
    expect(router.activeEngine).toBe('chrome');
  });

  it('throws for a pair neither engine can handle', async () => {
    const { router } = setup({ plamoSupports: false, chromeSupport: 'unavailable' });

    await expect(
      collectChunks(router.translate([{ id: 'a', text: 'Hello.' }], options({ tgt: 'cs' }))),
    ).rejects.toMatchObject({ code: 'unsupported-language' });
  });

  it('does not overwrite the engine recorded on a cached chunk', async () => {
    const { router } = setup({
      plamoChunks: [{ id: 'a', final: '簡易訳', engine: 'chrome' }],
    });

    const chunks = await collectChunks(router.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(chunks).toEqual([{ id: 'a', final: '簡易訳', engine: 'chrome' }]);
  });

  it('fails rather than falling back to Chrome when PLaMo cannot start', async () => {
    // The page keeps its source text in this case. A Chrome draft would turn a visible
    // paragraph into a translation the reader never asked for.
    const { router, chrome } = setup({
      plamoError: new EngineError('model-load-failed', 'load failed'),
    });

    await expect(
      collectChunks(router.translate([{ id: 'a', text: 'Hello.' }], options())),
    ).rejects.toMatchObject({ code: 'model-load-failed' });
    expect(chrome.calls).toBe(0);
    expect(router.activeEngine).toBe('plamo');
  });

  it('does not fall back when the request is aborted', async () => {
    const { router, chrome } = setup({ plamoError: new EngineError('aborted', 'aborted') });

    const chunks = await collectChunks(router.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(chunks).toEqual([]);
    expect(chrome.calls).toBe(0);
  });

  it('does not fall back after text has already been shown', async () => {
    const chrome = fakeEngine('chrome', [{ id: 'a', final: 'chrome', engine: 'chrome' }]);
    const plamo = {
      kind: 'plamo' as const,
      async *translate(): AsyncIterable<TranslationChunk> {
        yield { id: 'a', textDelta: 'partial', engine: 'plamo' };
        throw new EngineError('model-load-failed', 'model crashed');
      },
    };

    const router = new RoutingEngine({
      plamo,
      chrome,
      plamoSupports: () => true,
      chromeSupport: async () => 'available',
    });

    const iterator = router
      .translate([{ id: 'a', text: 'Hello.' }], options())
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: 'a', textDelta: 'partial', engine: 'plamo' },
    });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'model-load-failed' });
    expect(chrome.calls).toBe(0);
  });
});
