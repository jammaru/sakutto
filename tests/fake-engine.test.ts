// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { fakeMarker, fakeTranslate, fakeTranslateText } from '@/dom/fake-engine';
import type { TranslateOptions } from '@/engine/types';

function options(): TranslateOptions {
  return {
    tgt: 'en',
    form: 'polite',
    priority: 0,
    signal: new AbortController().signal,
  };
}

function setPace(pace: { ttfbMs: number; msPerChar: number; deltas: number } | null): void {
  if (pace === null) {
    document.documentElement.removeAttribute('data-bench-pace');
  } else {
    document.documentElement.setAttribute('data-bench-pace', JSON.stringify(pace));
  }
}

afterEach(() => {
  setPace(null);
});

describe('fake page engine', () => {
  it('marks text and keeps placeholder tags in order', () => {
    expect(fakeTranslateText('詳細は<i0>ドキュメント</i0>です。', 'en')).toBe(
      `${fakeMarker('en')}詳細は<i0>${fakeMarker('en')}ドキュメント</i0>${fakeMarker('en')}です。`,
    );
  });

  it('yields one final chunk per segment', async () => {
    const chunks = [];
    for await (const chunk of fakeTranslate([{ id: 'a', text: 'こんにちは' }], options())) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ id: 'a', final: '§en§こんにちは', engine: 'plamo' }]);
  });

  it('streams deltas before the final text when the bench sets a pace', async () => {
    setPace({ ttfbMs: 0, msPerChar: 0, deltas: 2 });

    const chunks = [];
    for await (const chunk of fakeTranslate([{ id: 'a', text: 'abcdefgh' }], options())) {
      chunks.push(chunk);
    }

    // Deltas are partial; the final chunk carries the whole text, the way the session
    // treats a final. Concatenating deltas is not the same as the final text.
    const deltas = chunks.filter((chunk) => chunk.textDelta !== undefined);
    expect(deltas).toHaveLength(2);
    expect(deltas.map((chunk) => chunk.textDelta).join('')).toBe('§en§abcd');
    expect(chunks.at(-1)).toEqual({ id: 'a', final: '§en§abcdefgh', engine: 'plamo' });
  });

  it('takes more time for longer text so scheduling differences stay visible', async () => {
    setPace({ ttfbMs: 1, msPerChar: 3, deltas: 0 });
    const started = Date.now();
    for await (const chunk of fakeTranslate([{ id: 'a', text: 'abcdefghij' }], options())) {
      expect(chunk.id).toBe('a');
    }
    // 1 ms prefill + 10 characters * 3 ms, with a generous floor for timer slack.
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it('stops after the segment in flight when the request is aborted', async () => {
    setPace({ ttfbMs: 0, msPerChar: 1, deltas: 0 });
    const controller = new AbortController();
    const chunks = [];
    for await (const chunk of fakeTranslate(
      [
        { id: 'a', text: 'abcdefghij' },
        { id: 'b', text: 'abcdefghij' },
      ],
      { ...options(), signal: controller.signal },
    )) {
      chunks.push(chunk);
      controller.abort();
    }
    expect(chunks.map((chunk) => chunk.id)).toEqual(['a']);
  });
});
