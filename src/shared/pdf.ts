/**
 * How a PDF reaches the reader.
 *
 * Chrome draws a PDF in its own viewer, and no content script can run there: the viewer is a
 * browser-internal page. So the bytes are taken once, in the background, from the URL the tab
 * is showing — the extension has that origin through `activeTab` — and kept in the extension's
 * private file system until the reader page asks for them. A downloaded copy is never written
 * to the user's Downloads folder, and the reader tab only ever reads from the extension.
 */

/** Where the bytes wait between the background and the reader. */
export const PDF_STORE_DIRECTORY = 'pdf';

/** Longest PDF the extension will accept, in bytes. */
export const MAX_PDF_BYTES = 200 * 1024 * 1024;

export interface PdfOpenRequest {
  type: 'pdf:open';
  tabId: number;
  /**
   * The document to read, when the caller already knows it.
   *
   * The popup never sends this: it lets the background read the tab, which works because the
   * toolbar click granted `activeTab` and Chrome reports a PDF tab's original URL under that
   * grant. A test harness cannot produce that grant, so it names the URL instead, and the
   * background then needs the origin the harness requested in its place.
   */
  url?: string;
  /** Pages to translate, for a harness reading a slice of a long paper. */
  pages?: number;
}

/**
 * What the popup learns. The background opens the reader tab itself, so the answer is only
 * whether the document could be taken; a failure reason tells the popup what to say.
 */
export type PdfOpenResult =
  | { opened: true }
  | {
      opened: false;
      reason: 'not-pdf' | 'fetch-failed' | 'too-large' | 'store-failed' | 'open-failed';
    };

/** The query the reader page uses to find its bytes. */
export const PDF_ID_PARAM = 'id';

export function readerUrl(id: string, pages = 0): string {
  const query = `${PDF_ID_PARAM}=${encodeURIComponent(id)}`;
  return pages > 0 ? `/reader.html?${query}&pages=${String(pages)}` : `/reader.html?${query}`;
}

/**
 * True when a URL is a PDF, or is one of the paths a paper server uses to serve a PDF.
 *
 * Most hosts end the path with `.pdf`, but some paper servers use `/pdf/<id>` with no
 * extension at all. A URL that ends in a bare identifier under a `/pdf/` segment is therefore
 * a PDF too. The check stays conservative: it only reads the path, so a query string cannot
 * make an ordinary page look like a document.
 */
export function looksLikePdfUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'https:' &&
      parsed.protocol !== 'file:'
    ) {
      return false;
    }
    const path = parsed.pathname.toLowerCase();
    if (path.endsWith('.pdf') || path.endsWith('.pdf/')) return true;
    // `/pdf/sample-2024`, `/pdf/sample-2024v2`, and the same with a trailing slash. The
    // segment must look like an identifier and hold a digit, so a site's own `/pdf/help`
    // page is not mistaken for a document.
    const identifier = /\/pdf\/([^/]+)\/?$/u.exec(path)?.[1];
    return identifier !== undefined && /^[\w.-]+$/u.test(identifier) && /\d/u.test(identifier);
  } catch {
    return false;
  }
}

/** True when the bytes start with the PDF header, whatever the server called the file. */
export function looksLikePdfBytes(bytes: Uint8Array): boolean {
  // `%PDF-` may sit a little into the file: a PDF is allowed to start with junk, and readers
  // are told to look for the header in the first kilobyte.
  const limit = Math.min(bytes.length, 1024) - 5;
  for (let index = 0; index <= limit; index += 1) {
    if (
      bytes[index] === 0x25 &&
      bytes[index + 1] === 0x50 &&
      bytes[index + 2] === 0x44 &&
      bytes[index + 3] === 0x46 &&
      bytes[index + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

/** A file name for a PDF URL, used when the server sends no name of its own. */
export function pdfFileName(url: string): string {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
    if (name.toLowerCase().endsWith('.pdf')) return name;
    return name.length > 0 ? `${name}.pdf` : 'document.pdf';
  } catch {
    return 'document.pdf';
  }
}

export function isPdfOpenRequest(value: unknown): value is PdfOpenRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { type?: unknown; tabId?: unknown; url?: unknown; pages?: unknown };
  if (record.type !== 'pdf:open') return false;
  if (typeof record.tabId !== 'number') return false;
  if (record.url !== undefined && typeof record.url !== 'string') return false;
  if (record.pages !== undefined && (typeof record.pages !== 'number' || record.pages < 0)) {
    return false;
  }
  return true;
}

export function isPdfOpenResult(value: unknown): value is PdfOpenResult {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { opened?: unknown; reason?: unknown };
  if (record.opened === true) return true;
  if (record.opened !== false) return false;
  return (
    record.reason === 'not-pdf' ||
    record.reason === 'fetch-failed' ||
    record.reason === 'too-large' ||
    record.reason === 'store-failed' ||
    record.reason === 'open-failed'
  );
}
