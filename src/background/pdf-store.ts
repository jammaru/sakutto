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
export async function openPdfFromUrl(url: string): Promise<{ id: string; name: string } | null> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'include' });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const length = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_PDF_BYTES) return null;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
  if (bytes.byteLength > MAX_PDF_BYTES) return null;
  if (!looksLikePdfBytes(bytes)) return null;

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
    // signed link does not decide what the document is called.
    const meta = await directory.getFileHandle(`${id}.json`, { create: true });
    const metaWriter = await meta.createWritable();
    await metaWriter.write(JSON.stringify({ name, url }));
    await metaWriter.close();

    const index = await readIndex(directory);
    await writeIndex(directory, [...index, { id, at: Date.now() }]);
  } catch {
    return null;
  }

  return { id, name };
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

/**
 * Removes documents nobody is reading.
 *
 * The reader page keeps its copy for as long as it is open, and a closed tab leaves it behind.
 * Chrome gives no event for a closed tab, so the store keeps an index of what it wrote and
 * when, and the popup sweeps anything older than a day before it stores a new document.
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
