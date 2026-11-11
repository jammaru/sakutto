import { pageHost } from '@/dom/sites';

const X_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com']);

const TWIMG_SUBTITLE = /^https:\/\/video\.twimg\.com\/subtitles\/[^?\s#]+\.vtt(?:[?#].*)?$/iu;

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

/**
 * X pages embed many feed videos. Translate only the one that is actually playing.
 * Fullscreen wins, then an audible player, then the largest visible playing video.
 * If nothing is playing, return null so the overlay stays off — no fake captions.
 */
export function pickPlayingXVideo(doc: Document): HTMLVideoElement | null {
  const view = doc.defaultView;
  const fullscreen = view?.document.fullscreenElement ?? doc.fullscreenElement;
  if (fullscreen) {
    const video =
      fullscreen instanceof HTMLVideoElement ? fullscreen : fullscreen.querySelector('video');
    if (video && isPlayingVideo(video)) return video;
  }

  const playing = [...doc.querySelectorAll('video')].filter(isPlayingVideo);
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

export function resolveTwimgCaptionUrl(pageUrl: string, captionUrl: string): string | null {
  const host = pageHost(pageUrl);
  if (!host || !isXHost(host)) return null;
  try {
    const page = new URL(pageUrl);
    if (page.protocol !== 'http:' && page.protocol !== 'https:') return null;
    const request = new URL(captionUrl, page);
    if (!isTwimgSubtitleUrl(request.toString())) return null;
    return request.toString();
  } catch {
    return null;
  }
}

function isPlayingVideo(video: HTMLVideoElement): boolean {
  if (video.paused || video.ended) return false;
  if (video.readyState < 2) return false;
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
