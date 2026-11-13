import { t } from '@/shared/i18n';
import { displayLanguage, isPlamoOnlyTarget } from '@/shared/languages';

/**
 * The label for a translation target. Easy Japanese has no locale of its own for
 * `Intl.DisplayNames`, so it comes from the message catalog with a PLaMo-only suffix.
 */
export function displayTargetLanguage(tag: string, uiLanguage: string): string {
  if (isPlamoOnlyTarget(tag)) return `${t('jaEasyName')}${t('plamoOnlySuffix')}`;
  return displayLanguage(tag, uiLanguage);
}
