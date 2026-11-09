/**
 * Shape of `amo-metadata.json` as posted by `web-ext sign --amo-metadata` to the
 * AMO v5 add-on create/put API. web-ext does not rewrite the file.
 *
 * Listed create requires version.license (or custom_license), add-on name,
 * summary, and categories for each compatible app. Categories are an object
 * keyed by app (`firefox`), not a slug list. Translated fields are locale maps;
 * AMO's default locale is `en-US` (the WebExtension catalog uses `en`).
 *
 * @see https://mozilla.github.io/addons-server/topics/api/addons.html#create
 */

const ADDON_KEYS = new Set([
  'categories',
  'contributions_url',
  'default_locale',
  'description',
  'developer_comments',
  'homepage',
  'is_disabled',
  'is_experimental',
  'name',
  'requires_payment',
  'slug',
  'summary',
  'support_email',
  'support_url',
  'tags',
  'version',
]);

const VERSION_KEYS = new Set([
  'approval_notes',
  'compatibility',
  'custom_license',
  'is_disabled',
  'license',
  'release_notes',
  'source',
  'upload',
]);

const FIREFOX_EXTENSION_CATEGORIES = new Set([
  'alerts-updates',
  'appearance',
  'bookmarks',
  'download-management',
  'feeds-news-blogging',
  'games-entertainment',
  'language-support',
  'photos-music-videos',
  'privacy-security',
  'search-tools',
  'shopping',
  'social-communication',
  'tabs',
  'web-development',
  'other',
]);

const AMO_LOCALE = /^(?:[a-z]{2}|[a-z]{2,3}-[A-Z]{2})$/;
const AMO_SUMMARY_LIMIT = 250;
const LISTED_LICENSE = 'MIT';
const LISTED_CATEGORY = 'privacy-security';
const DEFAULT_LOCALE = 'en-US';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(record: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(record).filter((key) => !allowed.has(key));
}

function localeMapProblems(label: string, value: unknown, urlValues = false): string[] {
  if (!isRecord(value)) return [`${label} must be a locale map`];
  const problems: string[] = [];
  const locales = Object.keys(value);
  if (!locales.includes(DEFAULT_LOCALE)) {
    problems.push(`${label} must include ${DEFAULT_LOCALE}`);
  }
  for (const [locale, text] of Object.entries(value)) {
    if (locale === 'en' || !AMO_LOCALE.test(locale)) {
      problems.push(`${label} locale ${locale} is not an AMO locale code`);
    }
    if (typeof text !== 'string' || text.trim() === '') {
      problems.push(`${label}.${locale} must be a non-empty string`);
      continue;
    }
    if (urlValues && !text.startsWith('https://')) {
      problems.push(`${label}.${locale} must be an https URL`);
    }
  }
  return problems;
}

function categoryProblems(value: unknown): string[] {
  if (Array.isArray(value)) {
    return ['categories must be {"firefox": ["privacy-security"]}, not a slug list'];
  }
  if (!isRecord(value)) return ['categories must be an object keyed by app'];
  const problems: string[] = [];
  for (const app of Object.keys(value)) {
    if (app !== 'firefox') problems.push(`categories.${app} is not a compatible app`);
  }
  const firefox = value.firefox;
  if (!Array.isArray(firefox) || firefox.length === 0) {
    return [...problems, 'categories.firefox must be a non-empty list of slugs'];
  }
  if (firefox.length > 1 && firefox.includes('other')) {
    problems.push('categories.firefox cannot combine other with another category');
  }
  for (const slug of firefox) {
    if (typeof slug !== 'string' || !FIREFOX_EXTENSION_CATEGORIES.has(slug)) {
      problems.push(`categories.firefox has unknown slug ${String(slug)}`);
    }
  }
  if (!firefox.includes(LISTED_CATEGORY)) {
    problems.push(`categories.firefox must include ${LISTED_CATEGORY}`);
  }
  return problems;
}

function versionProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['version must be an object'];
  const problems = unknownKeys(value, VERSION_KEYS).map(
    (key) => `version.${key} is not an AMO version field`,
  );
  if (value.license !== undefined && value.custom_license !== undefined) {
    problems.push('version cannot set both license and custom_license');
  }
  if (value.license !== LISTED_LICENSE) {
    problems.push(`version.license must be ${LISTED_LICENSE}`);
  }
  return problems;
}

export function amoMetadataProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['metadata must be a JSON object'];
  const problems = unknownKeys(value, ADDON_KEYS).map((key) => `${key} is not an AMO add-on field`);
  if ('license' in value) {
    problems.push('license belongs under version.license, not at the top level');
  }
  problems.push(...localeMapProblems('name', value.name));
  problems.push(...localeMapProblems('summary', value.summary));
  problems.push(...localeMapProblems('description', value.description));
  problems.push(...localeMapProblems('homepage', value.homepage, true));
  problems.push(...categoryProblems(value.categories));
  problems.push(...versionProblems(value.version));
  if (value.default_locale !== DEFAULT_LOCALE) {
    problems.push(`default_locale must be ${DEFAULT_LOCALE}`);
  }
  if (isRecord(value.summary)) {
    for (const [locale, text] of Object.entries(value.summary)) {
      if (typeof text !== 'string') continue;
      if (text.length > AMO_SUMMARY_LIMIT) {
        problems.push(`summary.${locale} exceeds ${String(AMO_SUMMARY_LIMIT)} characters`);
      }
      if (/https?:\/\//u.test(text)) {
        problems.push(`summary.${locale} cannot contain a URL`);
      }
    }
  }
  return problems;
}
