import { describe, expect, it } from 'vitest';
import {
  CHROME_ONLY_LANGUAGES,
  CHROME_SUPPORTED_LANGUAGES,
  canonicalLanguage,
  chooseTargetLanguage,
  resolvePageTarget,
  fromChromeLanguage,
  isChromeLanguage,
  isChromeOnlyLanguage,
  toChromeLanguage,
} from '@/shared/languages';

describe('language normalization', () => {
  it('drops regional and script subtags', () => {
    expect(canonicalLanguage('en-US')).toBe('en');
    expect(canonicalLanguage('de-DE')).toBe('de');
    expect(canonicalLanguage('pt-BR')).toBeNull();
    expect(canonicalLanguage('sr-Latn')).toBe('sr');
    expect(canonicalLanguage('JA_jp')).toBe('ja');
    expect(canonicalLanguage('ceb-PH')).toBe('ceb');
    expect(canonicalLanguage('not-a-language')).toBeNull();
    expect(canonicalLanguage('')).toBeNull();
  });

  it('maps every Chinese variant to a script', () => {
    expect(canonicalLanguage('zh')).toBe('zh-hans');
    expect(canonicalLanguage('zh-CN')).toBe('zh-hans');
    expect(canonicalLanguage('zh-TW')).toBe('zh-hant');
    expect(canonicalLanguage('zh-HK')).toBe('zh-hant');
    expect(canonicalLanguage('zh-MO')).toBe('zh-hant');
    expect(canonicalLanguage('zh-Hant')).toBe('zh-hant');
    expect(canonicalLanguage('zh-Hans')).toBe('zh-hans');
  });
});

describe('Chrome translator languages', () => {
  it('lists the 39 supported codes without duplicates', () => {
    expect(CHROME_SUPPORTED_LANGUAGES).toHaveLength(39);
    expect(new Set(CHROME_SUPPORTED_LANGUAGES).size).toBe(39);
    expect(CHROME_ONLY_LANGUAGES).toHaveLength(11);
  });

  it('recognizes both shared and Chrome-only languages', () => {
    expect(isChromeLanguage('ja')).toBe(true);
    expect(isChromeLanguage('zh-Hant')).toBe(true);
    expect(isChromeLanguage('cs')).toBe(true);
    expect(isChromeLanguage('en-US')).toBe(true);
    expect(isChromeLanguage('pt-BR')).toBe(true);
    expect(isChromeLanguage('sr-Latn')).toBe(false);
    expect(isChromeLanguage('ceb')).toBe(false);
    expect(isChromeLanguage('az')).toBe(false);
    expect(isChromeLanguage(null)).toBe(false);
    expect(isChromeOnlyLanguage('pt')).toBe(true);
    expect(isChromeOnlyLanguage('ja')).toBe(false);
  });

  it('maps the internal Chinese codes to Chrome language tags', () => {
    expect(toChromeLanguage('zh-hans')).toBe('zh');
    expect(toChromeLanguage('zh-hant')).toBe('zh-Hant');
    expect(toChromeLanguage('ZH_HANT')).toBe('zh-Hant');
    expect(toChromeLanguage('zh-cn')).toBe('zh');
    expect(toChromeLanguage('zh-tw')).toBe('zh-Hant');
    expect(toChromeLanguage('ja')).toBe('ja');
    expect(toChromeLanguage('en-US')).toBe('en');
    expect(fromChromeLanguage('zh')).toBe('zh-hans');
    expect(fromChromeLanguage('zh-Hant')).toBe('zh-hant');
    expect(fromChromeLanguage('zh-TW')).toBe('zh-hant');
    expect(fromChromeLanguage('en-US')).toBe('en');
    expect(isChromeLanguage('zh-CN')).toBe(true);
  });
});

describe('default target language', () => {
  it('picks another language when the page already matches the preference', () => {
    expect(chooseTargetLanguage('en', 'en', false)).toBe('ja');
    expect(chooseTargetLanguage('en-US', 'en', false)).toBe('ja');
    expect(chooseTargetLanguage('ja', 'ja', false)).toBe('en');
    expect(chooseTargetLanguage('ja', 'en', false)).toBe('en');
    expect(chooseTargetLanguage('en', 'de', false)).toBe('de');
    expect(chooseTargetLanguage('en', 'en', true)).toBe('en');
    expect(chooseTargetLanguage(null, 'en', false)).toBe('en');
  });

  it('shows Japanese for an English page unless the site chose a language', () => {
    expect(resolvePageTarget('en', 'en', false)).toBe('ja');
    expect(resolvePageTarget('en', 'ja', false)).toBe('ja');
    expect(resolvePageTarget('ja', 'ja', false)).toBe('en');
    expect(resolvePageTarget(null, 'en', false)).toBe('en');
    expect(resolvePageTarget('en', 'pt', true)).toBe('pt');
    expect(resolvePageTarget('en', 'en', true)).toBe('en');
  });
});
