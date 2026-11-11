import { pageHost } from '@/dom/sites';
import { canonicalLanguage } from '@/shared/languages';
import { CAPTION_OVERLAY_HOST } from './overlay';
import { stripTargetLanguageFromCaption } from './youtube';

const X_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com']);

const TWIMG_HOST = /^video\.twimg\.com$/iu;
const TWIMG_CAPTION_PATH = /\.(?:vtt|m3u8)$/iu;
const TWIMG_SUBTITLE = /^https:\/\/video\.twimg\.com\/subtitles\/[^?\s#]+\.vtt(?:[?#].*)?$/iu;

export const X_PLAYER_SELECTOR = '[data-testid="videoPlayer"], [data-testid="videoComponent"]';

export interface XSubtitleRendition {
  uri: string;
  language?: string | undefined;
  name?: string | undefined;
  isDefault: boolean;
}

export function isXHost(host: string): boolean {
  const normalized = host.replace(/^www\./, '').toLowerCase();
  return X_HOSTS.has(normalized);
}

export function isTwimgSubtitleUrl(url: string): boolean {
  try {
    return TWIMG_SUBTITLE.test(new URL(url, 'https://x.com/').toString());
  } catch {
    return false;
  }
}

/** Page-world GETs: twimg WebVTT or HLS subtitle playlists, never video segments. */
export function isTwimgCaptionAssetUrl(url: string): boolean {
  try {
    const parsed = new URL(url, 'https://x.com/');
    if (parsed.protocol !== 'https:') return false;
    if (!TWIMG_HOST.test(parsed.hostname)) return false;
    return TWIMG_CAPTION_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * X pages embed many feed videos. Translate only the one that is actually playing.
 * Fullscreen wins, then the video that just received `play` (inline / expanded), then
 * an audible player, then the largest visible playing video.
 * If nothing is playing, return null so the overlay stays off — no fake captions.
 */
export function pickPlayingXVideo(
  doc: Document,
  preferred?: HTMLVideoElement | null,
): HTMLVideoElement | null {
  const view = doc.defaultView;
  const fullscreen = view?.document.fullscreenElement ?? doc.fullscreenElement;
  if (fullscreen) {
    const video =
      fullscreen instanceof HTMLVideoElement ? fullscreen : fullscreen.querySelector('video');
    if (video && isPlayingVideo(video)) return video;
  }

  if (preferred && preferred.isConnected && isPlayingVideo(preferred, false)) return preferred;

  const playing = [...doc.querySelectorAll('video')].filter((video) => isPlayingVideo(video));
  if (playing.length === 0) return null;
  const audible = playing.filter((video) => !video.muted && video.volume > 0);
  const pool = audible.length > 0 ? audible : playing;
  return pool.reduce((best, video) => (visibleArea(video) > visibleArea(best) ? video : best));
}

export function listXSubtitleUrls(video: HTMLVideoElement): string[] {
  const urls: string[] = [];
  for (const track of video.querySelectorAll('track')) {
    const src = track.getAttribute('src') ?? ('src' in track ? String(track.src) : '');
    if (isTwimgSubtitleUrl(src) && !urls.includes(src)) urls.push(src);
  }
  return urls;
}

/** Track src, HLS currentSrc, published twimg VTT, and resource-timing entries. */
export function listXCaptionSourceUrls(video: HTMLVideoElement): string[] {
  const urls: string[] = [];
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || !isTwimgCaptionAssetUrl(trimmed) || urls.includes(trimmed)) return;
    urls.push(trimmed);
  };
  for (const url of listXSubtitleUrls(video)) add(url);
  add(video.currentSrc);
  add(video.src);
  for (const source of video.querySelectorAll('source')) {
    add(source.getAttribute('src') ?? '');
  }
  const scope =
    video.closest(X_PLAYER_SELECTOR) ?? video.ownerDocument.documentElement ?? video.ownerDocument;
  if (scope && 'querySelectorAll' in scope) {
    for (const node of scope.querySelectorAll('[src], [href]')) {
      add(node.getAttribute('src') ?? '');
      add(node.getAttribute('href') ?? '');
    }
  }
  const view = video.ownerDocument.defaultView;
  if (urls.length > 0) {
    try {
      const entries = view?.performance?.getEntriesByType?.('resource') ?? [];
      for (const entry of entries) add(entry.name);
    } catch {
      // performance.resource timing is optional.
    }
  }
  return urls;
}

export function resolveTwimgCaptionUrl(pageUrl: string, captionUrl: string): string | null {
  const host = pageHost(pageUrl);
  if (!host || !isXHost(host)) return null;
  try {
    const page = new URL(pageUrl);
    if (page.protocol !== 'http:' && page.protocol !== 'https:') return null;
    const request = new URL(captionUrl, page);
    if (!isTwimgCaptionAssetUrl(request.toString())) return null;
    return request.toString();
  } catch {
    return null;
  }
}

export function parseHlsSubtitleRenditions(
  manifest: string,
  baseUrl: string,
): XSubtitleRendition[] {
  const renditions: XSubtitleRendition[] = [];
  for (const raw of manifest.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const attrs = parseM3u8Attributes(line.slice('#EXT-X-MEDIA:'.length));
    if ((attrs.TYPE ?? '').toUpperCase() !== 'SUBTITLES') continue;
    const uri = attrs.URI;
    if (!uri) continue;
    const absolute = resolveRelativeUrl(baseUrl, uri);
    if (!absolute || !isTwimgCaptionAssetUrl(absolute)) continue;
    renditions.push({
      uri: absolute,
      language: attrs.LANGUAGE,
      name: attrs.NAME,
      isDefault: (attrs.DEFAULT ?? '').toUpperCase() === 'YES',
    });
  }
  return renditions;
}

export function parseHlsMediaSegments(playlist: string, baseUrl: string): string[] {
  const segments: string[] = [];
  for (const raw of playlist.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const absolute = resolveRelativeUrl(baseUrl, line);
    if (absolute && isTwimgCaptionAssetUrl(absolute) && !segments.includes(absolute)) {
      segments.push(absolute);
    }
  }
  return segments;
}

export function pickXSubtitleRendition(
  renditions: readonly XSubtitleRendition[],
  targetLanguage: string,
): XSubtitleRendition | null {
  if (renditions.length === 0) return null;
  const target = canonicalLanguage(targetLanguage);
  const notTarget = renditions.filter((entry) => {
    if (!entry.language) return true;
    const language = canonicalLanguage(entry.language);
    return language === null || language !== target;
  });
  const pool = notTarget.length > 0 ? notTarget : [...renditions];
  return (
    pool.find((entry) => entry.isDefault) ??
    pool.find((entry) => (entry.language ?? '').toLowerCase().startsWith('en')) ??
    pool[0] ??
    null
  );
}

/** One visible X caption line. Never mutates player nodes. */
export function readXCaptionDom(root: ParentNode, targetLanguage = ''): string {
  const scopes = 'querySelectorAll' in root ? [...root.querySelectorAll(X_PLAYER_SELECTOR)] : [];
  const search = scopes.length > 0 ? scopes : [root];
  for (const scope of search) {
    if (!('querySelectorAll' in scope)) continue;
    for (const node of scope.querySelectorAll(
      '[aria-live], [style*="text-shadow"], [class*="caption" i], [class*="subtitle" i]',
    )) {
      if (node.closest(CAPTION_OVERLAY_HOST)) continue;
      if (node.closest('button, [role="button"], a, input, textarea, select')) continue;
      const text = stripTargetLanguageFromCaption(node.textContent ?? '', targetLanguage)
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length >= 2 && text.length <= 240) return text;
    }
  }
  return '';
}

function isPlayingVideo(video: HTMLVideoElement, requireVisible = true): boolean {
  if (video.paused || video.ended) return false;
  // HAVE_METADATA (1) is enough: X MSE streams often play before HAVE_CURRENT_DATA.
  if (video.readyState < 1) return false;
  if (!requireVisible) return true;
  return visibleArea(video) > 0;
}

function visibleArea(video: HTMLVideoElement): number {
  const rect = video.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const root = video.ownerDocument.documentElement;
  const view = video.ownerDocument.defaultView;
  const viewportWidth = root.clientWidth || view?.innerWidth || 0;
  const viewportHeight = root.clientHeight || view?.innerHeight || 0;
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    return rect.width * rect.height;
  }
  const width = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  return width * height;
}

function parseM3u8Attributes(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=("(?:[^"]*)"|[^,]*)/giu;
  for (const match of body.matchAll(pattern)) {
    const key = match[1];
    if (!key) continue;
    const raw = match[2] ?? '';
    attrs[key.toUpperCase()] = raw.replace(/^"|"$/gu, '');
  }
  return attrs;
}

function resolveRelativeUrl(baseUrl: string, value: string): string | null {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}
