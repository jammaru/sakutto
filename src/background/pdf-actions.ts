import { browser } from 'wxt/browser';
import { readerUrl } from '@/shared/pdf';
import { fileSchemeAccessAllowed, tabServesPdf } from './pdf-detect';
import { openPdfFromUrl, sweepStoredPdfs } from './pdf-store';

/**
 * Opens the PDF the active tab is showing in the extension's own reader.
 *
 * The bytes are fetched and stored here rather than in the reader page: a service worker can
 * request the page's origin with the `activeTab` grant the toolbar click produced, and the
 * reader tab then reads only from the extension's own store.
 */
export async function openActivePdf(): Promise<boolean> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return openPdfForTab(tabs[0]);
}

export async function openPdfForTab(
  tab: { id?: number | undefined; url?: string | undefined } | undefined,
): Promise<boolean> {
  return (await openPdfForTabReason(tab)) === null;
}

/**
 * The same, reporting why it failed.
 *
 * The popup shows one message either way, but the bench and the e2e suite need to tell a
 * refused origin from a document that is not a PDF.
 */
export async function openPdfForTabReason(
  tab: { id?: number | undefined; url?: string | undefined } | undefined,
  pages = 0,
): Promise<
  | 'no-tab'
  | 'not-pdf'
  | 'fetch-failed'
  | 'too-large'
  | 'store-failed'
  | 'open-failed'
  | 'file-denied'
  | null
> {
  const tabId = tab?.id;
  const url = tab?.url;
  if (tabId === undefined || typeof url !== 'string') return 'no-tab';
  if (!(await tabServesPdf({ id: tabId, url }))) return 'not-pdf';

  if (url.startsWith('file:')) {
    const allowed = await fileSchemeAccessAllowed();
    if (allowed === false) {
      await openPickerReader();
      return 'file-denied';
    }
  }

  await sweepStoredPdfs();
  const stored = await openPdfFromUrl(url);
  if (!stored.ok) {
    if (url.startsWith('file:') && stored.reason === 'fetch-failed') {
      await openPickerReader();
      return 'file-denied';
    }
    return stored.reason;
  }

  try {
    await browser.tabs.create({
      url: browser.runtime.getURL(readerUrl(stored.id, pages) as never),
    });
  } catch {
    return 'open-failed';
  }
  return null;
}

/** Opens the reader with no stored document so the user can pick a local file. */
async function openPickerReader(): Promise<void> {
  try {
    await browser.tabs.create({
      url: browser.runtime.getURL(readerUrl('') as never),
    });
  } catch {
    // The popup still explains how to allow file URLs.
  }
}
