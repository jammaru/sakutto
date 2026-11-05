// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isAlreadyTargetLanguage, languageOf } from '@/dom/detect';

describe('block language', () => {
  it('keeps a Japanese paragraph when the document language is English', () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>これは日本語です</p><p>Read the documentation</p>';
    const [japanese, english] = [...document.querySelectorAll('p')];
    if (!japanese || !english) throw new Error('missing paragraphs');

    expect(languageOf(japanese, 'en')).toBe('ja');
    expect(isAlreadyTargetLanguage(japanese, 'en', 'en')).toBe(false);
    expect(languageOf(english, 'en')).toBe('en');
    expect(isAlreadyTargetLanguage(english, 'en', 'en')).toBe(true);
    expect(isAlreadyTargetLanguage(english, 'ja', 'en')).toBe(false);
  });

  it('keeps an English sentence that only mentions a few kanji', () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>By the Edo period, 大坂 (Ōsaka) was the city.</p>';
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');

    expect(languageOf(block, 'en')).toBe('en');
    expect(isAlreadyTargetLanguage(block, 'ja', 'en')).toBe(false);
  });

  it('skips a block whose own language tag matches the target', () => {
    document.body.innerHTML = '<p lang="ja">これは日本語です</p>';
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    expect(isAlreadyTargetLanguage(block, 'ja', 'en')).toBe(true);
  });
});
