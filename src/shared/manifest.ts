import {
  FIREFOX_EXTENSION_ID,
  FIREFOX_STRICT_MIN_VERSION,
  type ExtensionBrowser,
} from './browser.ts';
import { defaultShortcutsFor, SHORTCUT_COMMANDS } from './shortcuts.ts';

export const CHROME_PERMISSIONS = [
  'offscreen',
  'storage',
  'unlimitedStorage',
  'activeTab',
  'scripting',
  'contextMenus',
] as const;

export const FIREFOX_PERMISSIONS = [
  'storage',
  'unlimitedStorage',
  'activeTab',
  'scripting',
  'contextMenus',
] as const;

export const OPTIONAL_HOST_PERMISSIONS = ['https://*/*', 'http://*/*'] as const;

const COMMAND_MESSAGES = {
  'translate-page': '__MSG_commandTranslate__',
  'toggle-bilingual': '__MSG_commandBilingual__',
  'translate-selection': '__MSG_commandSelection__',
  'translate-compose': '__MSG_commandCompose__',
} as const;

export function commandSuggestions(
  browser: ExtensionBrowser,
): Record<
  (typeof SHORTCUT_COMMANDS)[number],
  { suggested_key: { default: string }; description: string }
> {
  const shortcuts = defaultShortcutsFor(browser);
  return {
    'translate-page': {
      suggested_key: { default: shortcuts['translate-page'] },
      description: COMMAND_MESSAGES['translate-page'],
    },
    'toggle-bilingual': {
      suggested_key: { default: shortcuts['toggle-bilingual'] },
      description: COMMAND_MESSAGES['toggle-bilingual'],
    },
    'translate-selection': {
      suggested_key: { default: shortcuts['translate-selection'] },
      description: COMMAND_MESSAGES['translate-selection'],
    },
    'translate-compose': {
      suggested_key: { default: shortcuts['translate-compose'] },
      description: COMMAND_MESSAGES['translate-compose'],
    },
  };
}

export function firefoxGeckoSettings(): {
  id: string;
  strict_min_version: string;
  data_collection_permissions: { required: ['none'] };
} {
  return {
    id: FIREFOX_EXTENSION_ID,
    strict_min_version: FIREFOX_STRICT_MIN_VERSION,
    data_collection_permissions: { required: ['none'] },
  };
}
