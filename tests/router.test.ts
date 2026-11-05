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
  plamoReady?: boolean;
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
    plamoReady: () => config.plamoReady ?? true,
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
  it('uses PLaMo when it is ready and supports the pair', async () => {
    const { router, plamo, chrome, chromeProbes } = setup();

    const chunks = await collectChunks(router.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(chromeProbes).toBe(0);

    expect(chunks).toEqual([CHUNK]);
    expect(router.activeEngine).toBe('plamo');
    expect(plamo.calls).toBe(1);
    expect(chrome.calls).toBe(0);
  });

  it('shows a built-in draft and then replaces it with PLaMo', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plamo = fakeEngine('plamo', [{ id: 'a', final: '丁寧', engine: 'plamo' }], {
      beforeChunks: () => gate,
    });
    const chrome = fakeEngine('chrome', [{ id: 'a', final: '簡易', engine: 'chrome' }]);
    const router = new RoutingEngine({
      plamo,
      chrome,
      plamoReady: () => true,
      plamoSupports: () => true,
      chromeSupport: async () => 'available',
    });

    const pending = collectChunks(
      router.translate([{ id: 'a', text: 'Hello.' }], options({ draft: true })),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(chrome.calls).toBe(1);
    } finally {
      release();
    }
    const chunks = await pending;

    expect(plamo.calls).toBe(1);
    expect(chunks.map((chunk) => chunk.final)).toEqual(['簡易', '丁寧']);
  });

  it('paints a built-in preview without starting PLaMo', async () => {
    const { router, plamo, chrome } = setup();

    const chunks = await collectChunks(
      router.translate([{ id: 'a', text: 'Hello.' }], options({ preview: true })),
    );

    expect(chunks).toEqual([{ id: 'a', final: 'chrome', engine: 'chrome' }]);
    expect(plamo.calls).toBe(0);
    expect(chrome.calls).toBe(1);
    expect(router.activeEngine).toBeNull();
  });

  it('does not draft when the built-in translator is unavailable', async () => {
    const { router, plamo, chrome } = setup({ chromeSupport: 'unavailable' });

    const chunks = await collectChunks(
      router.translate([{ id: 'a', text: 'Hello.' }], options({ draft: true })),
    );

    expect(chunks).toEqual([CHUNK]);
    expect(plamo.calls).toBe(1);
    expect(chrome.calls).toBe(0);
  });

  it('uses the built-in translator while the model is not ready', async () => {
    const { router, plamo, chrome } = setup({ plamoReady: false });

    const chunks = await collectChunks(router.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(chunks).toEqual([{ id: 'a', final: 'chrome', engine: 'chrome' }]);
    expect(router.activeEngine).toBe('chrome');
    expect(plamo.calls).toBe(0);
    expect(chrome.calls).toBe(1);
  });

  it('throws while the model is downloading and no bridge is ready', async () => {
    const { router } = setup({ plamoReady: false, chromeSupport: 'downloading' });

    await expect(
      collectChunks(router.translate([{ id: 'a', text: 'Hello.' }], options())),
    ).rejects.toMatchObject({ code: 'model-missing' });
  });

  it('routes languages PLaMo does not support to the built-in translator', async () => {
    const { router } = setup({ plamoSupports: false });
    const chunks = await collectChunks(
      router.translate([{ id: 'a', text: 'Hello.' }], options({ tgt: 'cs' })),
    );

    expect(chunks).toEqual([{ id: 'a', final: 'chrome', engine: 'chrome' }]);
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

  it('falls back to the bridge when PLaMo fails before producing text', async () => {
    const { router, chrome } = setup({
      plamoError: new EngineError('model-load-failed', 'load failed'),
    });

    const chunks = await collectChunks(router.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(chunks).toEqual([{ id: 'a', final: 'chrome', engine: 'chrome' }]);
    expect(chrome.calls).toBe(1);
    expect(router.activeEngine).toBe('chrome');
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
      plamoReady: () => true,
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

  it('keeps a built-in draft when PLaMo fails before producing text', async () => {
    const { router } = setup({
      plamoError: new EngineError('model-load-failed', 'load failed'),
      chromeChunks: [{ id: 'a', final: '簡易', engine: 'chrome' }],
    });

    const chunks = await collectChunks(
      router.translate([{ id: 'a', text: 'Hello.' }], options({ draft: true })),
    );

    expect(chunks.map((chunk) => chunk.final)).toEqual(['簡易']);
    expect(router.activeEngine).toBe('chrome');
  });

  it('asks again after the built-in translator was not ready', async () => {
    let probes = 0;
    let plamoCalls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chrome = fakeEngine('chrome', [{ id: 'a', final: '簡易', engine: 'chrome' }]);
    const router = new RoutingEngine({
      plamo: fakeEngine('plamo', [{ id: 'a', final: '丁寧', engine: 'plamo' }], {
        beforeChunks: () => {
          plamoCalls += 1;
          return plamoCalls === 1 ? Promise.resolve() : gate;
        },
      }),
      chrome,
      plamoReady: () => true,
      plamoSupports: () => true,
      chromeSupport: async () => {
        probes += 1;
        return probes === 1 ? 'downloadable' : 'available';
      },
    });

    const first = await collectChunks(
      router.translate([{ id: 'a', text: 'Hello.' }], options({ draft: true })),
    );
    const pending = collectChunks(
      router.translate([{ id: 'a', text: 'Hello.' }], options({ draft: true })),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(chrome.calls).toBe(1);
    } finally {
      release();
    }
    const second = await pending;

    expect(probes).toBe(2);
    expect(first.map((chunk) => chunk.final)).toEqual(['丁寧']);
    expect(second.map((chunk) => chunk.final)).toEqual(['簡易', '丁寧']);
  });
});
