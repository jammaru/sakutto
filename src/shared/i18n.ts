import { browser } from 'wxt/browser';
import enMessages from '../../public/_locales/en/messages.json';
import { isFirefoxBuild } from './browser';
import { localeTag, matchUiLocale, type UiLocale } from './locales';

export type { UiLocale } from './locales';

export type MessageKey = keyof typeof enMessages;

function formatFallback(message: string, substitutions: string | string[] | undefined): string {
  if (substitutions === undefined) return message;

  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  return message.replace(
    /\$(\d+)\$/g,
    (match, index: string) => values[Number(index) - 1] ?? match,
  );
}

export function t(key: MessageKey, substitutions?: string | string[]): string {
  const message = browser.i18n.getMessage(key, substitutions);
  if (message) return message;
  return formatFallback(enMessages[key].message, substitutions);
}

/** Chrome copy stays in the Chrome build; Firefox builds use the Firefox key. */
export function tForBrowser(
  chromeKey: MessageKey,
  firefoxKey: MessageKey,
  substitutions?: string | string[],
): string {
  return t(isFirefoxBuild() ? firefoxKey : chromeKey, substitutions);
}

export function currentUiLanguage(): string {
  return browser.i18n.getUILanguage() || 'en';
}

/**
 * The catalog Chrome resolves for the browser's UI language. Chrome itself only consults the
 * `_locales` it was given, but the pages set `<html lang>` and pick a default target language
 * from the same answer.
 */
export function uiLocale(): UiLocale {
  return matchUiLocale(currentUiLanguage());
}

/** The `<html lang>` value for the resolved catalog, e.g. `zh-TW`. */
export function uiLocaleTag(): string {
  return localeTag(uiLocale());
}
