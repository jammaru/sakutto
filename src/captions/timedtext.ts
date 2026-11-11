import { browser } from 'wxt/browser';

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
