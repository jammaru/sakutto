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

/** Brave-only explanatory copy; never use this to gate folder availability. */
export function isBraveBrowser(
  nav: { readonly brave?: unknown } | undefined = globalThis.navigator as
    { readonly brave?: unknown } | undefined,
): boolean {
  return Boolean(nav?.brave);
}

/**
 * Chrome's Translator / LanguageDetector APIs. Firefox has neither, so the
 * Chrome-only language list and onboarding note stay hidden there.
 */
export function hasBuiltInTranslatorUi(): boolean {
  return !isFirefoxBuild();
}

interface UserAgentBrand {
  brand: string;
  version?: string;
}

/**
 * Chromium Edge (`Edg/…`, brand "Microsoft Edge"), not legacy EdgeHTML (`Edge/`).
 * Used when copy or a default should differ; the shared-folder offer still stays
 * available because Chrome↔Edge sharing is the point of the folder.
 */
export function isMicrosoftEdge(
  input: { userAgent?: string; brands?: readonly UserAgentBrand[] } = {},
): boolean {
  const brands = input.brands ?? navigatorUserAgentBrands();
  if (brands.some((brand) => brand.brand === 'Microsoft Edge')) return true;
  const userAgent =
    input.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  return /\bEdg\//.test(userAgent);
}

function navigatorUserAgentBrands(): readonly UserAgentBrand[] {
  if (typeof navigator === 'undefined') return [];
  const uaData = (navigator as Navigator & { userAgentData?: { brands?: UserAgentBrand[] } })
    .userAgentData;
  return uaData?.brands ?? [];
}

export interface PlatformNavigator {
  readonly userAgentData?: { readonly platform?: string | undefined } | undefined;
  readonly platform?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * True on a Linux desktop, including Chrome's X11 and Wayland sessions. Android reports
 * Linux as its kernel in `navigator.platform` but runs Chrome for Android, so it is not a
 * desktop and gets no Linux-only hint.
 */
export function isLinuxPlatform(
  nav: PlatformNavigator | undefined = globalThis.navigator as PlatformNavigator | undefined,
): boolean {
  if (!nav) return false;
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  if (!/linux/i.test(platform)) return false;
  return !/android/i.test(nav.userAgent ?? platform);
}
