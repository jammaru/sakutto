import { browser } from 'wxt/browser';
import {
  isPdfContentType,
  looksLikePdfUrl,
  pdfDocumentLooksLikePdf,
  tabLooksLikePdf,
  type PdfDocumentProbe,
} from '@/shared/pdf';

/**
 * True when the tab is showing a PDF, even if the URL does not end in `.pdf`.
 *
 * Chrome's built-in viewer is not scriptable, so a path that only looks at `.pdf` misses
 * every document served at `/_pdf/…` or `?type=pdf`. The URL heuristic runs first; if it
 * is silent we read `document.contentType` / `<embed type>` when scripting is allowed, and
 * fall back to a HEAD/GET of `Content-Type` when it is not.
 */
export async function tabServesPdf(tab: {
  id?: number | undefined;
  url?: string | undefined;
}): Promise<boolean> {
  if (looksLikePdfUrl(tab.url)) return true;
  if (tab.id === undefined) return false;
  const document = await probePdfDocument(tab.id);
  let contentType: string | null = null;
  if (document === null && tab.url !== undefined && canProbeHeaders(tab.url)) {
    contentType = await probePdfContentType(tab.url);
  }
  return tabLooksLikePdf({ url: tab.url, document, contentType });
}

function canProbeHeaders(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
  } catch {
    return false;
  }
}

async function probePdfDocument(tabId: number): Promise<PdfDocumentProbe | null> {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: (): PdfDocumentProbe => {
        const node = document.querySelector('embed[type], object[type]');
        return {
          contentType: document.contentType,
          embedType: node?.getAttribute('type') ?? '',
          embedSrc: node?.getAttribute('src') ?? '',
        };
      },
    });
    const value = results[0]?.result;
    if (!value || typeof value !== 'object')
      return { contentType: '', embedType: '', embedSrc: '' };
    return {
      contentType: typeof value.contentType === 'string' ? value.contentType : '',
      embedType: typeof value.embedType === 'string' ? value.embedType : '',
      embedSrc: typeof value.embedSrc === 'string' ? value.embedSrc : '',
    };
  } catch {
    return null;
  }
}

async function probePdfContentType(url: string): Promise<string | null> {
  try {
    const head = await fetch(url, { method: 'HEAD', credentials: 'include' });
    const type = head.headers.get('content-type');
    if (isPdfContentType(type)) return type;
  } catch {
    // Some hosts refuse HEAD; a short GET still names the type.
  }
  try {
    const peek = await fetch(url, {
      credentials: 'include',
      headers: { Range: 'bytes=0-1023' },
    });
    const type = peek.headers.get('content-type');
    if (isPdfContentType(type)) return type;
    if (pdfDocumentLooksLikePdf({ contentType: type ?? '', embedType: '', embedSrc: '' })) {
      return type;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Whether Chrome has "Allow access to file URLs" on for this extension.
 *
 * `null` means the API is missing (tests, Firefox builds that do not expose it). Callers
 * then try the fetch and treat a failure as a file-access problem only for `file:` URLs.
 */
export async function fileSchemeAccessAllowed(): Promise<boolean | null> {
  const extension = (
    browser as {
      extension?: {
        isAllowedFileSchemeAccess?: (callback?: (allowed: boolean) => void) => unknown;
      };
    }
  ).extension;
  const read = extension?.isAllowedFileSchemeAccess;
  if (typeof read !== 'function') return null;
  try {
    if (read.length === 0) {
      return await (read as () => Promise<boolean>).call(extension);
    }
    return await new Promise((resolve) => {
      read.call(extension, (allowed: boolean) => resolve(allowed));
    });
  } catch {
    return null;
  }
}
