import { MAX_PDF_BYTES, PDF_STORE_DIRECTORY, looksLikePdfBytes } from '@/shared/pdf';
/**
 * Reads the PDF the tab is showing and keeps it for the reader page.
 *
 * Chrome's PDF viewer is a browser-internal page, so a content script cannot read the
 * document. What the extension can do is request the same URL itself: `activeTab` grants the
 * page's origin for the click that opened the popup, and the bytes that come back are the file
 * the viewer is displaying. Nothing is written to the user's Downloads folder, and no server
 * is involved beyond the one that already served the page.
 *
 * The copy is keyed by a random id, because a PDF's URL is not unique enough: the same paper
 * can be open from two places, and two tabs must not read each other's document.
 */
export type PdfStoreReason = 'fetch-failed' | 'too-large' | 'store-failed' | 'not-pdf';

export type PdfStoreResult =
  { ok: true; id: string; name: string } | { ok: false; reason: PdfStoreReason };

/** Sidecar written next to the bytes: the file name only, never the URL (signed tokens). */
export function storedPdfRecord(name: string): string {
  return JSON.stringify({ name });
}

export function classifyFetchedPdf(
  bytes: Uint8Array,
  contentLength: number | null,
): 'ok' | 'too-large' | 'not-pdf' {
  if (contentLength !== null && Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
    return 'too-large';
  }
  if (bytes.byteLength > MAX_PDF_BYTES) return 'too-large';
  if (!looksLikePdfBytes(bytes)) return 'not-pdf';
  return 'ok';
}

export async function openPdfFromUrl(url: string): Promise<PdfStoreResult> {
  const response = await fetchPdfBytes(url);
  if (!response) return { ok: false, reason: 'fetch-failed' };

  const headerLength = Number(response.headers.get('content-length') ?? '');
  const announced = Number.isFinite(headerLength) && headerLength > 0 ? headerLength : null;
  if (announced !== null && announced > MAX_PDF_BYTES) return { ok: false, reason: 'too-large' };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { ok: false, reason: 'fetch-failed' };
  }
  const kind = classifyFetchedPdf(bytes, announced);
  if (kind !== 'ok') return { ok: false, reason: kind };

  const id = crypto.randomUUID();
  const name = fileNameFrom(url, response);

  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(PDF_STORE_DIRECTORY, { create: true });
    const handle = await directory.getFileHandle(`${id}.pdf`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes as unknown as FileSystemWriteChunkType);
    await writable.close();

    // The reader shows the name from the store rather than from the URL, so a redirect or a
    // signed link does not decide what the document is called. The URL itself is not stored:
    // it can carry a signed token that would otherwise sit in OPFS until the copy is swept.
    const meta = await directory.getFileHandle(`${id}.json`, { create: true });
    const metaWriter = await meta.createWritable();
    await metaWriter.write(storedPdfRecord(name));
    await metaWriter.close();

    const index = await readIndex(directory);
    await writeIndex(directory, [...index, { id, at: Date.now() }]);
  } catch {
    return { ok: false, reason: 'store-failed' };
  }

  return { ok: true, id, name };
}

interface IndexEntry {
  id: string;
  at: number;
}

const INDEX_FILE = 'index.json';

async function readIndex(directory: FileSystemDirectoryHandle): Promise<IndexEntry[]> {
  try {
    const handle = await directory.getFileHandle(INDEX_FILE, { create: false });
    const value: unknown = JSON.parse(await (await handle.getFile()).text());
    if (!Array.isArray(value)) return [];
    return value.filter(isIndexEntry);
  } catch {
    return [];
  }
}

function isIndexEntry(value: unknown): value is IndexEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IndexEntry).id === 'string' &&
    typeof (value as IndexEntry).at === 'number'
  );
}

async function writeIndex(
  directory: FileSystemDirectoryHandle,
  entries: readonly IndexEntry[],
): Promise<void> {
  const handle = await directory.getFileHandle(INDEX_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(entries));
  await writable.close();
}

/** Reads stored PDF bytes for the reader page. */
export async function readStoredPdf(id: string): Promise<Uint8Array | null> {
  if (!/^[0-9a-f-]{36}$/iu.test(id)) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(PDF_STORE_DIRECTORY, { create: false });
    const handle = await directory.getFileHandle(`${id}.pdf`, { create: false });
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

/** The stored file name, or null when the document is not in the store. */
export async function storedPdfName(id: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/iu.test(id)) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(PDF_STORE_DIRECTORY, { create: false });
    const handle = await directory.getFileHandle(`${id}.json`, { create: false });
    const file = await handle.getFile();
    const value = JSON.parse(await file.text()) as { name?: unknown };
    return typeof value.name === 'string' ? value.name : null;
  } catch {
    return null;
  }
}

/** Removes one stored document. The reader calls this when its tab closes. */
export async function deleteStoredPdf(id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/iu.test(id)) return;
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(PDF_STORE_DIRECTORY, { create: false });
    await directory.removeEntry(`${id}.pdf`).catch(() => undefined);
    await directory.removeEntry(`${id}.json`).catch(() => undefined);
    const index = await readIndex(directory);
    await writeIndex(
      directory,
      index.filter((entry) => entry.id !== id),
    );
  } catch {
    // Nothing stored, or the origin has no OPFS: there is nothing to delete.
  }
}

/**
 * Removes documents nobody is reading.
 *
 * The reader page deletes its copy when the tab closes. A crash or a killed process can
 * leave a file behind, so the store also keeps an index of what it wrote and when, and the
 * popup sweeps anything older than a day before it stores a new document.
 */
export async function sweepStoredPdfs(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(PDF_STORE_DIRECTORY, { create: false });
    const index = await readIndex(directory);
    const cutoff = Date.now() - maxAgeMs;
    const keep: IndexEntry[] = [];

    for (const entry of index) {
      if (entry.at < cutoff) {
        await directory.removeEntry(`${entry.id}.pdf`).catch(() => undefined);
        await directory.removeEntry(`${entry.id}.json`).catch(() => undefined);
        continue;
      }
      keep.push(entry);
    }

    if (keep.length !== index.length) await writeIndex(directory, keep);
  } catch {
    // No store yet: there is nothing to sweep.
  }
}

function fileNameFrom(url: string, response: Response): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/iu.exec(disposition);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]).slice(0, 200);
    } catch {
      return match[1].slice(0, 200);
    }
  }

  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
    if (name.toLowerCase().endsWith('.pdf')) return name.slice(0, 200);
    if (name.length > 0) return `${name}.pdf`.slice(0, 200);
  } catch {
    // Fall through to the generic name.
  }
  return 'document.pdf';
}

/**
 * Reads the document at `url`, retrying a local file once the service worker is awake.
 *
 * A `file:` fetch from a just-started worker often throws on the first attempt and succeeds
 * a moment later. One retry with a short pause is the difference between "reload the page"
 * and opening the reader on the first click.
 */
async function fetchPdfBytes(url: string): Promise<Response | null> {
  const attempts = url.startsWith('file:') ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (response.ok) return response;
    } catch {
      // Try again: a cold worker or a viewer that has not finished opening the file.
    }
    if (attempt + 1 < attempts) await wait(120 * (attempt + 1));
  }
  return null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
