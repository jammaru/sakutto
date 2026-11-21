import { browser } from 'wxt/browser';
import { resolveTwimgCaptionUrl } from './x';

export const TIMEDTEXT_MAX_ATTEMPTS = 3;
export const TIMEDTEXT_BACKOFF_MS = [1_000, 4_000] as const;

/**
 * Caps empty timedtext GETs per video+track. DOM mutations must not fetch; retries
 * use exponential backoff and stop after {@link TIMEDTEXT_MAX_ATTEMPTS}.
 */
export class TimedtextFetchGuard {
  private readonly attempts = new Map<string, { count: number; nextAt: number }>();
  private readonly inflight = new Set<string>();

  allow(key: string, now: number): boolean {
    if (this.inflight.has(key)) return false;
    const state = this.attempts.get(key);
    if (!state) return true;
    if (state.count >= TIMEDTEXT_MAX_ATTEMPTS) return false;
    return now >= state.nextAt;
  }

  begin(key: string): boolean {
    if (this.inflight.has(key)) return false;
    this.inflight.add(key);
    return true;
  }

  succeed(key: string): void {
    this.inflight.delete(key);
    this.attempts.delete(key);
  }

  fail(key: string, now: number): void {
    this.inflight.delete(key);
    const count = (this.attempts.get(key)?.count ?? 0) + 1;
    const delayIndex = Math.min(count - 1, TIMEDTEXT_BACKOFF_MS.length - 1);
    const delay = TIMEDTEXT_BACKOFF_MS[delayIndex] ?? 4_000;
    this.attempts.set(key, {
      count,
      nextAt: count >= TIMEDTEXT_MAX_ATTEMPTS ? Number.POSITIVE_INFINITY : now + delay,
    });
  }

  reset(key?: string): void {
    if (key) {
      this.attempts.delete(key);
      this.inflight.delete(key);
      return;
    }
    this.attempts.clear();
    this.inflight.clear();
  }
}

/**
 * Same-origin GET of a caption URL the player already embedded on the page.
 * No body: this is not a request that carries page text to a server.
 *
 * Injected into the page world (`world: 'MAIN'`) so the GET is the watch tab's
 * origin. Isolated-world `fetch` is the extension origin and YouTube will not CORS it.
 */
export async function pageFetchTimedtext(url: string): Promise<string> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) return '';
  return response.text();
}

export function resolveCaptionFetchUrl(pageUrl: string, captionUrl: string): string | null {
  return (
    resolveSameOriginCaptionUrl(pageUrl, captionUrl) ?? resolveTwimgCaptionUrl(pageUrl, captionUrl)
  );
}

export function resolveSameOriginCaptionUrl(pageUrl: string, captionUrl: string): string | null {
  try {
    const page = new URL(pageUrl);
    if (page.protocol !== 'http:' && page.protocol !== 'https:') return null;
    const request = new URL(captionUrl, page);
    if (request.protocol !== page.protocol) return null;
    if (request.origin !== page.origin) return null;
    return request.toString();
  } catch {
    return null;
  }
}

export async function readTimedtext(url: string): Promise<string> {
  try {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (response.ok) {
      const body = await response.text();
      if (body.length > 0) return body;
    }
  } catch {
    // Isolated-world fetch is treated as the extension origin.
  }
  try {
    const href = globalThis.location?.href;
    const absolute = href ? new URL(url, href).toString() : url;
    const response: unknown = await browser.runtime.sendMessage({
      type: 'captions:timedtext',
      url: absolute,
    });
    return typeof response === 'string' ? response : '';
  } catch {
    return '';
  }
}
