import { browser } from 'wxt/browser';
import { shouldAutoInjectCaptions } from '@/captions/sites';
import { originPattern, pageHost, loadSiteRule } from '@/dom/sites';
import { ensureContentScript } from '@/shared/page-bridge';
import { requestPageCommand, type PageCommandName } from '@/shared/messages';
import { looksLikePdfUrl, readerUrl } from '@/shared/pdf';
import { noteShortcutCommandAssigned } from '@/shared/shortcut-assignment';
import { isShortcutCommand, PDF_COMMAND, SHORTCUT_PAGE_COMMANDS } from '@/shared/shortcuts';
import type { ShortcutCommand, ShortcutEnabled } from '@/shared/shortcuts';
import { loadSettings } from '@/shared/storage';
import { openPdfFromUrl, sweepStoredPdfs } from './pdf-store';

interface PageTranslationCanceller {
  cancelTab(tabId: number): void;
}

export function installPageActions(translations?: PageTranslationCanceller): void {
  installMenus();

  browser.commands.onCommand.addListener((command, tab) => {
    // The PDF command is not a page action: the browser delivers the key here and the
    // background opens the reader itself, because no content script can run in its viewer.
    if (command === PDF_COMMAND) {
      void (tab?.id === undefined ? openActivePdf() : openPdfForTab(tab));
      return;
    }
    void handleShortcutCommand(command, tab);
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === PDF_COMMAND) {
      void openPdfForTab(tab);
      return;
    }
    const tabId = tab?.id;
    if (tabId === undefined) return;
    const pageCommand =
      info.menuItemId === 'translate-selection'
        ? 'selection'
        : info.menuItemId === 'translate-compose'
          ? 'compose'
          : info.menuItemId === 'translate-page'
            ? 'toggle'
            : null;
    if (!pageCommand) return;
    void runCommand(tabId, pageCommand);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading') translations?.cancelTab(tabId);
    if (changeInfo.status !== 'complete' || !tab.url) return;
    void injectIfAlways(tabId, tab.url);
    void injectIfCaptions(tabId, tab.url);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    translations?.cancelTab(tabId);
  });
}

function installMenus(): void {
  void browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: 'translate-page',
      title: browser.i18n.getMessage('contextTranslatePage'),
      contexts: ['page'],
    });
    browser.contextMenus.create({
      id: 'translate-selection',
      title: browser.i18n.getMessage('contextTranslateSelection'),
      contexts: ['selection'],
    });
    // Chrome decides menu contents when it opens, so hiding after contextmenu is too
    // late and the hidden state would be global across tabs. Keep this item on every
    // editable; ineligible fields no-op with feedback in the page.
    browser.contextMenus.create({
      id: 'translate-compose',
      title: browser.i18n.getMessage('contextTranslateCompose'),
      contexts: ['editable'],
    });
    browser.contextMenus.create({
      id: PDF_COMMAND,
      title: browser.i18n.getMessage('contextTranslatePdf'),
      contexts: ['page', 'link'],
      // Only offered on something that is a PDF, so the menu does not promise a feature the
      // click cannot deliver. Chrome reports a PDF tab's URL as the file itself.
      documentUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*'],
    });
  });
}

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
  'no-tab' | 'not-pdf' | 'fetch-failed' | 'too-large' | 'store-failed' | 'open-failed' | null
> {
  const tabId = tab?.id;
  const url = tab?.url;
  if (tabId === undefined || typeof url !== 'string') return 'no-tab';
  if (!looksLikePdfUrl(url)) return 'not-pdf';

  await sweepStoredPdfs();
  const stored = await openPdfFromUrl(url);
  if (!stored.ok) return stored.reason;

  try {
    await browser.tabs.create({
      url: browser.runtime.getURL(readerUrl(stored.id, pages) as never),
    });
  } catch {
    return 'open-failed';
  }
  return null;
}

/**
 * True when this Chrome/Edge/Firefox command should run. Sakutto's own off switch
 * applies only to the keyboard command; the popup and context menu still translate.
 */
export function shouldHandleShortcutCommand(
  command: string,
  enabled: ShortcutEnabled,
): command is ShortcutCommand {
  return isShortcutCommand(command) && enabled[command] !== false;
}

/**
 * The tab Chrome delivered with `onCommand`, or the focused window's active tab.
 * A service worker has no "current window", so `currentWindow: true` alone can miss
 * the page the reader is looking at.
 */
export function resolveShortcutTabId(
  delivered: { id?: number | undefined } | undefined,
  lastFocused: ReadonlyArray<{ id?: number | undefined }>,
  currentWindow: ReadonlyArray<{ id?: number | undefined }> = [],
): number | undefined {
  return delivered?.id ?? lastFocused[0]?.id ?? currentWindow[0]?.id;
}

/** Same path `commands.onCommand` uses: record the binding, then tell the content script. */
export async function handleShortcutCommand(
  command: string,
  tab?: { id?: number | undefined },
): Promise<void> {
  if (!isShortcutCommand(command)) return;
  void noteShortcutCommandAssigned(command);
  const settings = await loadSettings();
  if (!shouldHandleShortcutCommand(command, settings.shortcutsEnabled)) return;
  const tabId =
    tab?.id !== undefined
      ? tab.id
      : resolveShortcutTabId(
          undefined,
          await browser.tabs.query({ active: true, lastFocusedWindow: true }),
          await browser.tabs.query({ active: true, currentWindow: true }),
        );
  if (tabId === undefined) return;
  await runCommand(tabId, SHORTCUT_PAGE_COMMANDS[command]);
}

/** The frame whose document has a real focused control, if scripting can see it. */
export function pickFocusedFrameId(
  results: ReadonlyArray<{ frameId?: number; result?: boolean | undefined }>,
): number | undefined {
  return results.find((entry) => entry.result === true)?.frameId;
}

async function focusedContentFrameId(tabId: number): Promise<number | undefined> {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (): boolean => {
        if (!document.hasFocus()) return false;
        const active = document.activeElement;
        return Boolean(active && active !== document.body && active !== document.documentElement);
      },
    });
    return pickFocusedFrameId(results);
  } catch {
    return undefined;
  }
}

async function runCommand(tabId: number, command: PageCommandName): Promise<void> {
  const allFrames = command === 'compose';
  if (!(await ensureContentScript(tabId, { allFrames }))) return;
  const frameId = allFrames ? await focusedContentFrameId(tabId) : undefined;
  await requestPageCommand(tabId, command, frameId);
}

async function injectIfAlways(tabId: number, url: string): Promise<void> {
  const host = pageHost(url);
  const pattern = originPattern(url);
  if (!host || !pattern) return;

  const rule = await loadSiteRule(host);
  if (rule.auto !== 'always') return;

  const allowed = await browser.permissions.contains({ origins: [pattern] }).catch(() => false);
  if (!allowed) return;
  await ensureContentScript(tabId);
}

async function injectIfCaptions(tabId: number, url: string): Promise<void> {
  const host = pageHost(url);
  const pattern = originPattern(url);
  if (!host || !pattern) return;

  const settings = await loadSettings();
  const allowed = await browser.permissions.contains({ origins: [pattern] }).catch(() => false);
  if (
    !shouldAutoInjectCaptions({
      settingOn: settings.translateVideoCaptions,
      host,
      originAllowed: allowed,
      customHosts: settings.captionCustomHosts,
    })
  ) {
    return;
  }
  await ensureContentScript(tabId);
}

/** Re-injects youtube.com / x.com tabs after the caption setting is turned on. */
export async function injectCaptionPages(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.translateVideoCaptions) return;
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url) continue;
    void injectIfCaptions(tab.id, tab.url);
  }
}
