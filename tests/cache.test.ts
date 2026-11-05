import { describe, expect, it } from 'vitest';
import { CachingEngine } from '@/engine/cache/caching-engine';
import { TranslationCache } from '@/engine/cache/cache';
import { buildTranslationCacheKey, glossaryVersion } from '@/engine/cache/key';
import { MemoryTranslationCacheStore } from '@/engine/cache/store';
import type { TranslateOptions } from '@/engine/types';
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

describe('translation cache keys', () => {
  it('changes when the model, direction, form, glossary or text changes', () => {
    const base = {
      model: 'plamo-0.8b',
      tgt: 'ja',
      form: 'polite' as const,
      text: 'Sign in to continue',
      src: 'en',
    };
    const key = buildTranslationCacheKey(base);

    expect(buildTranslationCacheKey({ ...base })).toBe(key);
    expect(buildTranslationCacheKey({ ...base, model: 'chrome' })).not.toBe(key);
    expect(buildTranslationCacheKey({ ...base, tgt: 'en' })).not.toBe(key);
    expect(buildTranslationCacheKey({ ...base, form: 'plain' })).not.toBe(key);
    expect(buildTranslationCacheKey({ ...base, src: undefined })).not.toBe(key);
    expect(buildTranslationCacheKey({ ...base, text: 'Sign in' })).not.toBe(key);
    expect(buildTranslationCacheKey({ ...base, src: 'en-US', tgt: 'ja-JP' })).toBe(key);
    expect(
      buildTranslationCacheKey({
        ...base,
        glossary: [{ source: 'Runner', target: 'ランナー機能' }],
      }),
    ).not.toBe(key);
  });

  it('includes a SHA-256 hash of the source text', () => {
    const key = buildTranslationCacheKey({
      model: 'model',
      tgt: 'ja',
      form: 'polite',
      text: 'Hello.',
    });
    const segments = key.split('|');

    expect(segments).toHaveLength(7);
    expect(segments.at(-1)).toMatch(/^[0-9a-f]{64}$/);
    expect(segments.slice(0, 3)).toEqual(['v1', 'model', 'auto']);
  });

  it('fingerprints the glossary independently of the cache key', () => {
    expect(glossaryVersion(undefined)).toBe('none');
    expect(glossaryVersion([])).toBe('none');
    expect(glossaryVersion([{ source: 'a', target: 'b' }])).toBe(
      glossaryVersion([{ source: 'a', target: 'b' }]),
    );
    expect(glossaryVersion([{ source: 'a', target: 'b' }])).not.toBe(
      glossaryVersion([{ source: 'b', target: 'a' }]),
    );
    expect(glossaryVersion([{ source: 'a', target: 'b' }])).not.toBe(
      glossaryVersion([
        { source: 'a', target: 'b' },
        { source: 'c', target: 'd' },
      ]),
    );
  });
});

describe('TranslationCache', () => {
  it('removes the least recently used rows beyond the limit', async () => {
    const store = new MemoryTranslationCacheStore();
    let now = 100;
    const cache = new TranslationCache(store, { maxEntries: 2, now: () => now });

    await cache.put('a', 'A', 'plamo');
    now = 200;
    await cache.put('b', 'B', 'plamo');
    now = 300;
    await cache.get('a');
    now = 400;
    await cache.put('c', 'C', 'plamo');
    await cache.prune();

    expect(store.size).toBe(2);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toEqual({ text: 'A', engine: 'plamo' });
    expect(await cache.get('c')).toEqual({ text: 'C', engine: 'plamo' });
  });
});

describe('CachingEngine', () => {
  it('serves a repeated segment from the cache without touching the inner engine', async () => {
    const store = new MemoryTranslationCacheStore();
    const inner = fakeEngine('plamo', [{ id: 'a', final: 'サインイン', engine: 'plamo' }]);
    const engine = new CachingEngine(inner, new TranslationCache(store), 'plamo-0.8b');
    const segments = [{ id: 'a', text: 'Sign in' }];

    const first = await collectChunks(engine.translate(segments, options()));
    expect(first).toEqual([{ id: 'a', final: 'サインイン', engine: 'plamo' }]);

    const second = await collectChunks(engine.translate(segments, options()));
    expect(second).toEqual([{ id: 'a', final: 'サインイン', engine: 'plamo' }]);
    expect(inner.calls).toBe(1);
  });

  it('keeps cached engine provenance and only sends misses to the inner engine', async () => {
    const store = new MemoryTranslationCacheStore();
    const cache = new TranslationCache(store);
    const key = buildTranslationCacheKey({
      model: 'plamo-0.8b',
      tgt: 'ja',
      form: 'polite',
      text: 'Sign in',
    });
    await cache.put(key, '簡易訳', 'chrome');

    const inner = fakeEngine('plamo', [{ id: 'b', final: '設定', engine: 'plamo' }]);
    const engine = new CachingEngine(inner, cache, 'plamo-0.8b');

    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'Sign in' },
          { id: 'b', text: 'Settings' },
        ],
        options(),
      ),
    );

    expect(chunks).toEqual([
      { id: 'a', final: '簡易訳', engine: 'chrome' },
      { id: 'b', final: '設定', engine: 'plamo' },
    ]);
    expect(inner.calls).toBe(1);
  });

  it('translates repeated misses once and fans the result out', async () => {
    const store = new MemoryTranslationCacheStore();
    const inner = fakeEngine('plamo', [
      { id: 'a', textDelta: 'サ', engine: 'plamo' },
      { id: 'a', final: 'サインイン', engine: 'plamo' },
    ]);
    const engine = new CachingEngine(inner, new TranslationCache(store), 'plamo-0.8b');

    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'Sign in' },
          { id: 'b', text: 'Sign in' },
        ],
        options(),
      ),
    );

    expect(inner.calls).toBe(1);
    expect(chunks).toEqual([
      { id: 'a', textDelta: 'サ', engine: 'plamo' },
      { id: 'b', textDelta: 'サ', engine: 'plamo' },
      { id: 'a', final: 'サインイン', engine: 'plamo' },
      { id: 'b', final: 'サインイン', engine: 'plamo' },
    ]);
  });

  it('isolates cache entries by target language and form', async () => {
    const store = new MemoryTranslationCacheStore();
    const inner = fakeEngine('plamo', [{ id: 'a', final: 'Hello.', engine: 'plamo' }]);
    const engine = new CachingEngine(inner, new TranslationCache(store), 'plamo-0.8b');
    const segments = [{ id: 'a', text: 'こんにちは。' }];

    await collectChunks(engine.translate(segments, options({ tgt: 'en', src: 'ja' })));
    await collectChunks(
      engine.translate(segments, options({ tgt: 'en', src: 'ja', form: 'plain' })),
    );

    expect(inner.calls).toBe(2);
  });
});
