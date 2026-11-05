export const SUPPORTED_LANGUAGES = [
  'ja',
  'en',
  'zh-hans',
  'zh-hant',
  'ko',
  'ar',
  'az',
  'be',
  'bg',
  'bn',
  'ca',
  'ceb',
  'de',
  'es',
  'et',
  'eu',
  'fa',
  'fr',
  'gu',
  'he',
  'hi',
  'hr',
  'hu',
  'hy',
  'id',
  'it',
  'jv',
  'ka',
  'kk',
  'km',
  'lt',
  'lv',
  'ml',
  'mr',
  'ms',
  'my',
  'ne',
  'nl',
  'pa',
  'pl',
  'ru',
  'si',
  'sk',
  'sl',
  'sr',
  'sw',
  'ta',
  'te',
  'th',
  'tl',
  'ur',
  'uz',
  'vi',
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_TARGET_LANGUAGE: LanguageCode = 'en';

const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES);

export const CHROME_ONLY_LANGUAGES = [
  'cs',
  'da',
  'el',
  'fi',
  'kn',
  'no',
  'pt',
  'ro',
  'sv',
  'tr',
  'uk',
] as const;

const CHROME_SHARED_LANGUAGES = [
  'ja',
  'en',
  'zh-hans',
  'zh-hant',
  'ko',
  'ar',
  'bg',
  'bn',
  'de',
  'es',
  'fr',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'lt',
  'mr',
  'nl',
  'pl',
  'ru',
  'sk',
  'sl',
  'ta',
  'te',
  'th',
  'vi',
] as const satisfies readonly LanguageCode[];

export const CHROME_SUPPORTED_LANGUAGES = [
  ...CHROME_SHARED_LANGUAGES,
  ...CHROME_ONLY_LANGUAGES,
] as const;

const CHROME_SET: ReadonlySet<string> = new Set(CHROME_SUPPORTED_LANGUAGES);
const CHROME_ONLY_SET: ReadonlySet<string> = new Set(CHROME_ONLY_LANGUAGES);

const displayNamesCache = new Map<string, Intl.DisplayNames>();

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replaceAll('_', '-');
}

function baseTag(tag: string): string {
  return normalizeTag(tag).split('-')[0] ?? '';
}

/**
 * Reduces a language tag to one of the model's supported codes. Regional and script
 * subtags are dropped, except for Chinese, where the script decides between zh-hans and
 * zh-hant.
 */
export function canonicalLanguage(tag: string): LanguageCode | null {
  const normalized = normalizeTag(tag);
  if (normalized.length === 0) return null;

  const [base, ...subtags] = normalized.split('-');
  if (base === 'zh') {
    if (
      subtags.includes('hant') ||
      subtags.includes('tw') ||
      subtags.includes('hk') ||
      subtags.includes('mo')
    ) {
      return 'zh-hant';
    }
    return 'zh-hans';
  }

  if (base === 'sr' && subtags.includes('latn')) return 'sr';
  return base !== undefined && SUPPORTED_SET.has(base) ? (base as LanguageCode) : null;
}

/**
 * Resolves a tag to a code the built-in translator accepts, including the Chrome-only
 * languages that the on-device model does not support.
 */
export function canonicalChromeLanguage(tag: string): string | null {
  const canonical = canonicalLanguage(tag);
  if (canonical !== null && CHROME_SET.has(canonical)) return canonical;

  const base = baseTag(tag);
  return CHROME_SET.has(base) ? base : null;
}

export function isChromeLanguage(value: unknown): boolean {
  return typeof value === 'string' && canonicalChromeLanguage(value) !== null;
}

export function isChromeOnlyLanguage(value: string): boolean {
  const canonical = canonicalChromeLanguage(value);
  return canonical !== null && CHROME_ONLY_SET.has(canonical);
}

export function toChromeLanguage(code: string): string {
  const normalized = canonicalChromeLanguage(code) ?? normalizeTag(code);
  if (normalized === 'zh-hans') return 'zh';
  if (normalized === 'zh-hant') return 'zh-Hant';
  return normalized;
}

export function fromChromeLanguage(tag: string): string {
  return canonicalChromeLanguage(tag) ?? normalizeTag(tag);
}

function getDisplayNames(locale: string): Intl.DisplayNames | null {
  const key = locale.trim().toLowerCase() || 'en';
  const cached = displayNamesCache.get(key);
  if (cached) return cached;

  try {
    const names = new Intl.DisplayNames([key], { type: 'language', fallback: 'code' });
    displayNamesCache.set(key, names);
    return names;
  } catch {
    return null;
  }
}

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && SUPPORTED_SET.has(value);
}

export type TargetLanguage = LanguageCode | (typeof CHROME_ONLY_LANGUAGES)[number];

/** A translation target the page can request: a PLaMo language, or a Chrome-only one. */
export function isTargetLanguage(value: unknown): value is TargetLanguage {
  return isLanguageCode(value) || (typeof value === 'string' && CHROME_ONLY_SET.has(value));
}

export function resolveTargetLanguage(
  uiLanguage: string,
  fallback: LanguageCode = DEFAULT_TARGET_LANGUAGE,
): LanguageCode {
  return canonicalLanguage(uiLanguage) ?? fallback;
}

/**
 * When the page is already in the preferred language, pick the other side of the
 * main pair so the first translation is not a no-op. An explicit site choice wins.
 */
export function chooseTargetLanguage(
  pageLanguage: string | null,
  preferred: string,
  explicit: boolean,
): LanguageCode {
  const target = canonicalLanguage(preferred) ?? DEFAULT_TARGET_LANGUAGE;
  if (explicit) return target;
  const page = pageLanguage ? canonicalLanguage(pageLanguage) : null;
  if (!page || page !== target) return target;
  return target === 'ja' ? 'en' : 'ja';
}

/**
 * The language shown for a page. An explicit site choice is kept, including a
 * Chrome-only language. Otherwise the page is never translated into itself.
 */
export function resolvePageTarget(
  pageLanguage: string | null,
  preferred: string,
  explicit: boolean,
): string {
  if (explicit && isTargetLanguage(preferred)) return preferred;
  return chooseTargetLanguage(pageLanguage, preferred, false);
}

export function displayLanguage(tag: string, uiLanguage: string): string {
  const normalized = tag.trim();
  if (normalized.length === 0) return '';

  try {
    return getDisplayNames(uiLanguage)?.of(normalized) ?? normalized;
  } catch {
    return normalized;
  }
}
