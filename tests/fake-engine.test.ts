import { describe, expect, it } from 'vitest';
import { fakeMarker, fakeTranslate, fakeTranslateText } from '@/dom/fake-engine';

describe('fake page engine', () => {
  it('marks text and keeps placeholder tags in order', () => {
    expect(fakeTranslateText('詳細は<i0>ドキュメント</i0>です。', 'en')).toBe(
      `${fakeMarker('en')}詳細は<i0>${fakeMarker('en')}ドキュメント</i0>${fakeMarker('en')}です。`,
    );
  });

  it('yields one final chunk per segment', async () => {
    const chunks = [];
    for await (const chunk of fakeTranslate([{ id: 'a', text: 'こんにちは' }], {
      tgt: 'en',
      form: 'polite',
      priority: 0,
      signal: new AbortController().signal,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ id: 'a', final: '§en§こんにちは', engine: 'plamo' }]);
  });
});
