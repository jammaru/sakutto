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

export interface PdfForgetRequest {
  type: 'pdf:forget';
  id: string;
}

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
export type PdfOpenReason =
  'not-pdf' | 'fetch-failed' | 'too-large' | 'store-failed' | 'open-failed' | 'file-denied';

export type PdfOpenResult =
  | { opened: true }
  | {
      opened: false;
      reason: PdfOpenReason;
    };

export interface PdfInspectRequest {
  type: 'pdf:inspect';
  tabId: number;
}

export interface PdfInspectResult {
  pdf: boolean;
}

export interface PdfDocumentProbe {
  contentType: string;
  embedType: string;
  embedSrc: string;
}

/** Match patterns for the PDF context-menu item, including paths that omit `.pdf`. */
export const PDF_MENU_URL_PATTERNS = [
  '*://*/*.pdf',
  '*://*/*.pdf?*',
  '*://*/*pdf*',
  '*://*/*PDF*',
  'file:///*/*.pdf',
  'file:///*/*.pdf?*',
  'file:///*/*pdf*',
] as const;

/** The query the reader page uses to find its bytes. */
export const PDF_ID_PARAM = 'id';

export function readerUrl(id: string, pages = 0): string {
  if (id.length === 0) return '/reader.html';
  const query = `${PDF_ID_PARAM}=${encodeURIComponent(id)}`;
  return pages > 0 ? `/reader.html?${query}&pages=${String(pages)}` : `/reader.html?${query}`;
}

/** True when a Content-Type names a PDF, including `application/pdf; charset=binary`. */
export function isPdfContentType(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^\s*application\/pdf(?:\s|;|$)/iu.test(value);
}

/** True when the live document is Chrome/Firefox's PDF viewer rather than an HTML page. */
export function pdfDocumentLooksLikePdf(probe: PdfDocumentProbe): boolean {
  if (isPdfContentType(probe.contentType) || isPdfContentType(probe.embedType)) return true;
  return /\.pdf(?:$|[?#])/iu.test(probe.embedSrc);
}

/**
 * True when a URL is a PDF, or is one of the paths a document server uses to serve a PDF.
 *
 * Most hosts end the path with `.pdf`. Others put a `pdf` or `_pdf` segment in the path, or
 * name the type in the query (`type=pdf`), and still open Chrome's built-in viewer. The
 * popup also probes `document.contentType` / `Content-Type` when the path is silent.
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
    const segments = path.split('/').filter(Boolean);
    // Hosts that mint document bytes at `/_pdf/…` never use a file extension.
    if (segments.some((segment) => segment === '_pdf')) return true;
    const pdfAt = segments.findIndex((segment) => segment === 'pdf');
    if (pdfAt >= 0) {
      const rest = segments.slice(pdfAt + 1).join('/');
      // `/pdf/<id>` is a document when the id carries a digit. `/pdf/help` is a site page.
      if (/\d/u.test(rest)) return true;
    }
    for (const [key, value] of parsed.searchParams) {
      const kind = key.toLowerCase();
      if (
        kind !== 'type' &&
        kind !== 'format' &&
        kind !== 'file' &&
        kind !== 'download' &&
        kind !== 'kind' &&
        kind !== 'mime' &&
        kind !== 'contenttype' &&
        kind !== 'content-type'
      ) {
        continue;
      }
      const offered = value.toLowerCase();
      if (offered === 'pdf' || offered === 'application/pdf' || offered.endsWith('/pdf')) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Combines the cheap URL check with a document probe and a `Content-Type` header.
 *
 * Chrome's PDF viewer is not scriptable, so `document` is `null` there and the header (from
 * a HEAD/GET the background can make with `activeTab`) is what names the file.
 */
export function tabLooksLikePdf(input: {
  url?: string | undefined;
  document?: PdfDocumentProbe | null;
  contentType?: string | null;
}): boolean {
  if (looksLikePdfUrl(input.url)) return true;
  if (input.document && pdfDocumentLooksLikePdf(input.document)) return true;
  if (input.document === null && isPdfContentType(input.contentType)) return true;
  return false;
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

export function isPdfInspectRequest(value: unknown): value is PdfInspectRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { type?: unknown; tabId?: unknown };
  return record.type === 'pdf:inspect' && typeof record.tabId === 'number';
}

export function isPdfInspectResult(value: unknown): value is PdfInspectResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { pdf?: unknown }).pdf === 'boolean'
  );
}

export function isPdfForgetRequest(value: unknown): value is PdfForgetRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { type?: unknown; id?: unknown };
  return record.type === 'pdf:forget' && typeof record.id === 'string' && record.id.length > 0;
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
    record.reason === 'open-failed' ||
    record.reason === 'file-denied'
  );
}
