/**
 * The UI locales this extension ships a message catalog for, spelled the way Chrome spells a
 * `_locales` directory. Chrome serves `chrome.i18n` from the catalog that matches the browser's
 * UI language and falls back to `default_locale` (`en`) for anything it cannot match.
 *
 * `tests/locales.test.ts` keeps this list and `public/_locales` in step, so adding a catalog
 * without naming it here fails the suite rather than shipping a locale nobody can reach.
 */
export const UI_LOCALES = [
  'en',
  'ja',
  'ko',
  'zh_CN',
  'zh_TW',
  'es',
  'pt_BR',
  'fr',
  'de',
  'it',
  'ru',
  'vi',
  'th',
  'id',
] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export const DEFAULT_UI_LOCALE: UiLocale = 'en';

/** The spelling an HTML `lang` attribute wants: `zh_CN` becomes `zh-CN`. */
export function localeTag(locale: string): string {
  return locale.replaceAll('_', '-');
}

function normalize(tag: string): string {
  return tag.trim().replaceAll('_', '-').toLowerCase();
}

const CATALOG_BY_TAG: ReadonlyMap<string, UiLocale> = new Map(
  UI_LOCALES.map((locale) => [normalize(locale), locale]),
);

/**
 * A browser in Portugal reports `pt-PT`. Chrome would only reach `pt_BR` through its own
 * `pt` alias, so the resolver keeps that alias here rather than shipping a separate catalog
 * for a handful of spellings.
 */
const LOCALE_ALIASES: ReadonlyMap<string, UiLocale> = new Map([['pt', 'pt_BR']]);

/**
 * Reduces a browser UI language to a catalog this extension ships, or to `en` when it ships
 * none. Regional subtags are dropped once the exact tag misses, so `de-AT` and `es-419` reach
 * their catalogs. Chinese is the exception: the two scripts are separate catalogs, and a
 * browser reports the one it means with a subtag other than the catalog name.
 */
export function matchUiLocale(uiLanguage: string): UiLocale {
  const tag = normalize(uiLanguage);
  if (tag.length === 0) return DEFAULT_UI_LOCALE;

  const exact = CATALOG_BY_TAG.get(tag);
  if (exact !== undefined) return exact;

  const [base, ...subtags] = tag.split('-');
  if (base === 'zh') {
    const traditional = subtags.some(
      (subtag) => subtag === 'hant' || subtag === 'tw' || subtag === 'hk' || subtag === 'mo',
    );
    return traditional ? 'zh_TW' : 'zh_CN';
  }
  if (base === undefined) return DEFAULT_UI_LOCALE;

  return CATALOG_BY_TAG.get(base) ?? LOCALE_ALIASES.get(base) ?? DEFAULT_UI_LOCALE;
}
