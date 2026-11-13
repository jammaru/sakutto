import { describe, expect, it } from 'vitest';
import {
  CHROME_ONLY_LANGUAGES,
  CHROME_SUPPORTED_LANGUAGES,
  canonicalLanguage,
  chooseTargetLanguage,
  effectivePageTarget,
  resolvePageTarget,
  fromChromeLanguage,
  isChromeLanguage,
  isChromeOnlyLanguage,
  isPlamoOnlyTarget,
  isTargetLanguage,
  JA_EASY_TARGET,
  plamoPromptTargetLanguage,
  SUPPORTED_LANGUAGES,
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

  it('uses the saved global target on every site unless that site stored its own', () => {
    expect(effectivePageTarget('ja', undefined)).toBe('ja');
    expect(effectivePageTarget('ja', 'en')).toBe('en');
    expect(effectivePageTarget('en', undefined)).toBe('en');
    expect(effectivePageTarget('xx', undefined)).toBe('en');
  });
});

describe('Easy Japanese', () => {
  it('is a PLaMo target outside the language and Chrome lists', () => {
    expect(JA_EASY_TARGET).toBe('ja-easy');
    expect(SUPPORTED_LANGUAGES).not.toContain(JA_EASY_TARGET);
    expect(CHROME_SUPPORTED_LANGUAGES).not.toContain(JA_EASY_TARGET);
    expect(isTargetLanguage('ja-easy')).toBe(true);
    expect(isTargetLanguage('JA_EASY')).toBe(true);
    expect(isTargetLanguage('ja-easy-extra')).toBe(false);
    expect(isChromeLanguage('ja-easy')).toBe(false);
    expect(isChromeOnlyLanguage('ja-easy')).toBe(false);
    expect(isPlamoOnlyTarget('ja-easy')).toBe(true);
    expect(isPlamoOnlyTarget('JA_EASY')).toBe(true);
    expect(isPlamoOnlyTarget('ja')).toBe(false);
    expect(isPlamoOnlyTarget('en')).toBe(false);
  });

  it('names ja-easy in the PLaMo prompt and keeps other targets canonical', () => {
    expect(plamoPromptTargetLanguage('ja-easy')).toBe('ja-easy');
    expect(plamoPromptTargetLanguage('JA_EASY')).toBe('ja-easy');
    expect(plamoPromptTargetLanguage('en-US')).toBe('en');
    expect(plamoPromptTargetLanguage('zh-TW')).toBe('zh-hant');
    expect(plamoPromptTargetLanguage('pt-BR')).toBe('pt-br');
  });

  it('keeps a Japanese page translating when Easy Japanese is the target', () => {
    expect(chooseTargetLanguage('ja', 'ja-easy', false)).toBe('ja-easy');
    expect(resolvePageTarget('ja', 'ja-easy', true)).toBe('ja-easy');
    expect(effectivePageTarget('ja-easy', undefined)).toBe('ja-easy');
  });
});
