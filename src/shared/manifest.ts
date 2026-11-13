import {
  FIREFOX_EXTENSION_ID,
  FIREFOX_STRICT_MIN_VERSION,
  type ExtensionBrowser,
} from './browser.ts';
import {
  suggestedKeyFor,
  PDF_COMMAND,
  type PdfCommand,
  type ShortcutCommand,
} from './shortcuts.ts';

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
  'translate-pdf': '__MSG_commandPdf__',
} as const;

export function commandSuggestions(
  browser: ExtensionBrowser,
): Record<
  ShortcutCommand | PdfCommand,
  { suggested_key?: { default: string; mac?: string | undefined }; description: string }
> {
  return {
    'translate-page': {
      suggested_key: suggestedKeyFor(browser, 'translate-page'),
      description: COMMAND_MESSAGES['translate-page'],
    },
    'toggle-bilingual': {
      suggested_key: suggestedKeyFor(browser, 'toggle-bilingual'),
      description: COMMAND_MESSAGES['toggle-bilingual'],
    },
    'translate-selection': {
      suggested_key: suggestedKeyFor(browser, 'translate-selection'),
      description: COMMAND_MESSAGES['translate-selection'],
    },
    'translate-compose': {
      suggested_key: suggestedKeyFor(browser, 'translate-compose'),
      description: COMMAND_MESSAGES['translate-compose'],
    },
    // Chrome's viewer is a browser-internal page, so no content script can reach a PDF. The
    // key goes straight to the background, which opens the document in Sakutto's reader.
    //
    // No `suggested_key`: Chrome allows four, the page commands use all four
    // (`MAX_SUGGESTED_SHORTCUTS`), and a fifth makes the browser refuse the extension
    // outright. The command is still listed in the browser's shortcut editor for a reader
    // who wants to bind one.
    [PDF_COMMAND]: {
      description: COMMAND_MESSAGES['translate-pdf'],
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
