export type ExtensionBrowser = 'chrome' | 'firefox';

/** Add-on ID for AMO. It cannot change after the first listed upload. */
export const FIREFOX_EXTENSION_ID = 'sakutto@jammaru';

export const FIREFOX_STRICT_MIN_VERSION = '153.0';

interface BrowserEnv {
  BROWSER?: string;
  FIREFOX?: boolean;
}

function readEnv(): BrowserEnv {
  return ((import.meta as { env?: BrowserEnv }).env ?? {}) as BrowserEnv;
}

/** The browser this bundle was compiled for. Tests without WXT env are Chrome. */
export function extensionBrowser(): ExtensionBrowser {
  const env = readEnv();
  if (env.FIREFOX === true || env.BROWSER === 'firefox') return 'firefox';
  return 'chrome';
}

export function isFirefoxBuild(): boolean {
  return extensionBrowser() === 'firefox';
}

/**
 * Chrome's Translator / LanguageDetector APIs. Firefox has neither, so the
 * Chrome-only language list and onboarding note stay hidden there.
 */
export function hasBuiltInTranslatorUi(): boolean {
  return !isFirefoxBuild();
}
