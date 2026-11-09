import { describe, expect, it } from 'vitest';
import { DEFAULT_UI_LOCALE, UI_LOCALES, localeTag, matchUiLocale } from '@/shared/locales';

describe('matchUiLocale', () => {
  it('resolves an exact catalog tag', () => {
    expect(matchUiLocale('en')).toBe('en');
    expect(matchUiLocale('ja')).toBe('ja');
    expect(matchUiLocale('ko')).toBe('ko');
    expect(matchUiLocale('zh_CN')).toBe('zh_CN');
    expect(matchUiLocale('zh_TW')).toBe('zh_TW');
  });

  it('drops a regional subtag once the exact tag misses', () => {
    expect(matchUiLocale('de-AT')).toBe('de');
    expect(matchUiLocale('de-CH')).toBe('de');
    expect(matchUiLocale('es-419')).toBe('es');
    expect(matchUiLocale('es-MX')).toBe('es');
    expect(matchUiLocale('fr-CA')).toBe('fr');
    expect(matchUiLocale('it-CH')).toBe('it');
    expect(matchUiLocale('vi-VN')).toBe('vi');
    expect(matchUiLocale('id-ID')).toBe('id');
  });

  /**
   * Chrome reports Chinese by script, not by catalog name. `zh-Hant` and `zh-TW` are the same
   * request for the traditional catalog; everything else in `zh` is simplified.
   */
  it('routes Chinese by script', () => {
    expect(matchUiLocale('zh')).toBe('zh_CN');
    expect(matchUiLocale('zh-Hans')).toBe('zh_CN');
    expect(matchUiLocale('zh-Hans-CN')).toBe('zh_CN');
    expect(matchUiLocale('zh-SG')).toBe('zh_CN');
    expect(matchUiLocale('zh-Hant')).toBe('zh_TW');
    expect(matchUiLocale('zh-Hant-HK')).toBe('zh_TW');
    expect(matchUiLocale('zh-TW')).toBe('zh_TW');
    expect(matchUiLocale('zh-HK')).toBe('zh_TW');
    expect(matchUiLocale('zh-MO')).toBe('zh_TW');
  });

  /** Portugal speaks Portuguese too, and the catalogs differ only by spelling and register. */
  it('routes both Portuguese spellings to the one catalog', () => {
    expect(matchUiLocale('pt')).toBe('pt_BR');
    expect(matchUiLocale('pt-BR')).toBe('pt_BR');
    expect(matchUiLocale('pt-PT')).toBe('pt_BR');
  });

  it('falls back to the default catalog for a language it ships none for', () => {
    for (const tag of ['', '  ', 'sv', 'nl', 'uk', 'tr', 'cs', 'ar', 'tlh']) {
      expect(matchUiLocale(tag), tag).toBe(DEFAULT_UI_LOCALE);
    }
  });

  it('accepts an underscore tag from a caller that spelled it that way', () => {
    expect(matchUiLocale('pt_BR')).toBe('pt_BR');
    expect(matchUiLocale('zh_HK')).toBe('zh_TW');
  });
});

describe('localeTag', () => {
  it('spells a catalog name the way an HTML lang attribute wants', () => {
    expect(localeTag('en')).toBe('en');
    expect(localeTag('zh_CN')).toBe('zh-CN');
    expect(localeTag('zh_TW')).toBe('zh-TW');
    expect(localeTag('pt_BR')).toBe('pt-BR');
  });
});

describe('UI_LOCALES', () => {
  it('has no duplicate catalog names', () => {
    expect(new Set(UI_LOCALES).size).toBe(UI_LOCALES.length);
  });

  it('includes the default locale', () => {
    expect(UI_LOCALES).toContain(DEFAULT_UI_LOCALE);
  });
});
