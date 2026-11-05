import { browser } from 'wxt/browser';
import enMessages from '../../public/_locales/en/messages.json';

export type MessageKey = keyof typeof enMessages;

export type UiLocale = 'ja' | 'en';

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

export function currentUiLanguage(): string {
  return browser.i18n.getUILanguage() || 'en';
}

export function uiLocale(): UiLocale {
  return currentUiLanguage().trim().toLowerCase().startsWith('ja') ? 'ja' : 'en';
}
