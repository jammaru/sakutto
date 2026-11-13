import { browser } from 'wxt/browser';
import { saveSettings } from '@/shared/storage';
import type { VideoCaptionPositionSite } from '@/shared/settings';
import { hostMatchesCaptionCustom } from './custom-hosts';
import { isYouTubeHost } from './youtube';
import { isXHost } from './x';

/** Page hosts where caption translation auto-runs once the setting and origin grant are on. */
export const CAPTION_AUTO_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
] as const;

/** Stored while Chrome's permission prompt is open so a closed popup can finish enabling. */
export const CAPTION_ENABLE_INTENT_KEY = 'captionEnableIntent';

export function isCaptionAutoHost(host: string): boolean {
  return isYouTubeHost(host) || isXHost(host);
}

/**
 * Caption overlay auto-run: YouTube, X, a YouTube player document (fixtures and
 * youtube.com), or a host the reader listed. Random article origins stay off.
 */
export function captionsAllowedOnPage(
  host: string,
  customHosts: readonly string[] = [],
  document?: Document | null,
): boolean {
  if (isCaptionAutoHost(host)) return true;
  if (document?.getElementById('movie_player')) return true;
  return hostMatchesCaptionCustom(host, customHosts);
}

/** Which stored overlay spot this page uses. YouTube and X do not share a position. */
export function videoCaptionPositionSite(host: string): VideoCaptionPositionSite {
  if (isYouTubeHost(host)) return 'youtube';
  if (isXHost(host)) return 'x';
  return 'other';
}

/** Origins requested when the reader turns caption translation on. YouTube/X are https only. */
export function captionPermissionOrigins(): string[] {
  const origins: string[] = [];
  for (const host of CAPTION_AUTO_HOSTS) {
    origins.push(`https://${host}/*`);
  }
  return origins;
}

export function shouldAutoInjectCaptions(options: {
  settingOn: boolean;
  host: string;
  originAllowed: boolean;
  customHosts?: readonly string[];
}): boolean {
  if (!options.settingOn || !options.originAllowed) return false;
  return captionsAllowedOnPage(options.host, options.customHosts);
}

/**
 * Optional host access for youtube.com / x.com. `permissions.request` must be the first
 * awaited extension call in the click that turns the setting on — a prior `await`
 * (including `permissions.contains`) drops the user gesture and Chrome shows no prompt.
 */
export async function requestCaptionHostAccess(): Promise<boolean> {
  const origins = captionPermissionOrigins();
  return browser.permissions.request({ origins }).catch(() => false);
}

export interface CaptionToggleDecision {
  on: boolean;
  denied: boolean;
}

export function captionOriginsOverlap(origins: readonly string[] | undefined): boolean {
  if (!origins || origins.length === 0) return false;
  const wanted = new Set(captionPermissionOrigins());
  return origins.some((origin) => wanted.has(origin));
}

/** Fire-and-forget: must not be awaited before `permissions.request`. */
export function markCaptionEnableIntent(): void {
  void browser.storage.local.set({ [CAPTION_ENABLE_INTENT_KEY]: true });
}

export async function clearCaptionEnableIntent(): Promise<void> {
  await browser.storage.local.remove(CAPTION_ENABLE_INTENT_KEY).catch(() => undefined);
}

export async function captionEnableIntentPending(): Promise<boolean> {
  const stored = (await browser.storage.local.get(CAPTION_ENABLE_INTENT_KEY).catch(() => ({}))) as {
    [CAPTION_ENABLE_INTENT_KEY]?: unknown;
  };
  return stored[CAPTION_ENABLE_INTENT_KEY] === true;
}

export async function hasCaptionHostAccess(): Promise<boolean> {
  const origins = captionPermissionOrigins();
  return browser.permissions.contains({ origins }).catch(() => false);
}

/**
 * Completes a caption-enable click that Chrome aborted by closing the popup.
 * Only turns the setting on when the hosts are already granted. A still-open
 * permission dialog leaves the intent pending instead of treating it as a denial.
 */
export async function settleCaptionEnableIntent(options?: {
  grantedOrigins?: readonly string[];
}): Promise<CaptionToggleDecision & { applied: boolean }> {
  if (!(await captionEnableIntentPending())) {
    return { applied: false, on: false, denied: false };
  }
  const granted = captionOriginsOverlap(options?.grantedOrigins) || (await hasCaptionHostAccess());
  if (!granted) return { applied: false, on: false, denied: false };
  await saveSettings({ translateVideoCaptions: true });
  await clearCaptionEnableIntent();
  return { applied: true, on: true, denied: false };
}

/**
 * Turns caption translation on only after optional host access is granted in this click.
 * A denial leaves the setting off so the switch can revert.
 *
 * Chrome closes the toolbar popup when `permissions.request` opens its prompt, so this
 * records an enable intent *before* the request (no `await`) and writes the setting as
 * soon as the grant lands. `settleCaptionEnableIntent` finishes the same click if the
 * popup never sees the promise resolve.
 */
export async function resolveCaptionToggle(
  nextOn: boolean,
  requestAccess: () => Promise<boolean> = requestCaptionHostAccess,
): Promise<CaptionToggleDecision> {
  if (!nextOn) {
    void clearCaptionEnableIntent();
    return { on: false, denied: false };
  }
  markCaptionEnableIntent();
  const granted = await requestAccess();
  if (!granted) {
    await clearCaptionEnableIntent();
    return { on: false, denied: true };
  }
  await saveSettings({ translateVideoCaptions: true });
  await clearCaptionEnableIntent();
  return { on: true, denied: false };
}
