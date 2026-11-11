import { browser } from 'wxt/browser';
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

export function isCaptionAutoHost(host: string): boolean {
  return isYouTubeHost(host) || isXHost(host);
}

/** Origins requested when the reader turns caption translation on. */
export function captionPermissionOrigins(): string[] {
  const origins: string[] = [];
  for (const host of CAPTION_AUTO_HOSTS) {
    origins.push(`https://${host}/*`, `http://${host}/*`);
  }
  return origins;
}

export function shouldAutoInjectCaptions(options: {
  settingOn: boolean;
  host: string;
  originAllowed: boolean;
}): boolean {
  return options.settingOn && options.originAllowed && isCaptionAutoHost(options.host);
}

/** Optional host access for youtube.com / x.com, requested when the setting is turned on. */
export async function requestCaptionHostAccess(): Promise<boolean> {
  const origins = captionPermissionOrigins();
  const already = await browser.permissions.contains({ origins }).catch(() => false);
  if (already) return true;
  return browser.permissions.request({ origins }).catch(() => false);
}

export interface CaptionToggleDecision {
  on: boolean;
  denied: boolean;
}

/**
 * Turns caption translation on only after optional host access is granted in this click.
 * A denial leaves the setting off so the switch can revert.
 */
export async function resolveCaptionToggle(
  nextOn: boolean,
  requestAccess: () => Promise<boolean> = requestCaptionHostAccess,
): Promise<CaptionToggleDecision> {
  if (!nextOn) return { on: false, denied: false };
  const granted = await requestAccess();
  if (!granted) return { on: false, denied: true };
  return { on: true, denied: false };
}
