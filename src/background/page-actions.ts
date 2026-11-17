import { browser } from 'wxt/browser';
import { shouldAutoInjectCaptions } from '@/captions/sites';
import { shouldAutoInjectGmailBanner } from '@/dom/gmail-banner';
import { shouldAutoInjectOutlookBanner } from '@/dom/outlook-banner';
import { originPattern, pageHost, loadSiteRule } from '@/dom/sites';
import { ensureContentScript } from '@/shared/page-bridge';
import { requestPageCommand, type PageCommandName } from '@/shared/messages';
import { noteShortcutCommandAssigned } from '@/shared/shortcut-assignment';
import { isShortcutCommand, PDF_COMMAND, SHORTCUT_PAGE_COMMANDS } from '@/shared/shortcuts';
import type { ShortcutCommand, ShortcutEnabled } from '@/shared/shortcuts';
import { loadSettings } from '@/shared/storage';
import { openPdfForTab } from './pdf-actions';
import type { EngineClient } from './engine-client';
import { scheduleContextMenusInstall } from './context-menus';
import { runGatedPageCommand, runGatedPdfCommand } from './folder-grant';

export { openActivePdf, openPdfForTab, openPdfForTabReason } from './pdf-actions';

interface PageTranslationCanceller {
  cancelTab(tabId: number): void;
}

let gatedEngine: EngineClient | undefined;
let translationCanceller: PageTranslationCanceller | undefined;
let listenersInstalled = false;

/**
 * Register the event listeners synchronously during service-worker startup. Chrome only
 * queues an event that woke the worker when its listener already exists in the first turn;
 * a command must not wait for the engine client or the offscreen document to be ready.
 */
export function installPageActionListeners(engine?: EngineClient): void {
  if (engine) gatedEngine = engine;
  if (listenersInstalled) return;
  listenersInstalled = true;

  browser.commands.onCommand.addListener((command, tab) => {
    // The PDF command is not a page action: the browser delivers the key here and the
    // background opens the reader itself, because no content script can run in its viewer.
    if (command === PDF_COMMAND) {
      void runPdfCommand(tab);
      return;
    }
    void handleShortcutCommand(command, tab);
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === PDF_COMMAND) {
      void runPdfCommand(tab);
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
    if (changeInfo.status === 'loading') translationCanceller?.cancelTab(tabId);
    if (changeInfo.status !== 'complete' || !tab.url) return;
    void injectIfAlways(tabId, tab.url);
    void injectIfCaptions(tabId, tab.url);
    void injectIfGmailBanner(tabId, tab.url);
    void injectIfOutlookBanner(tabId, tab.url);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    translationCanceller?.cancelTab(tabId);
  });
}

export function installPageActions(
  translations?: PageTranslationCanceller,
  engine?: EngineClient,
): void {
  if (translations) translationCanceller = translations;
  if (engine) gatedEngine = engine;
  installPageActionListeners();
  installMenus();
}

function installMenus(): void {
  scheduleContextMenusInstall();
}

/**
 * The PDF command shares the folder gate with page actions. When the grant is dormant the
 * command is deferred before any bytes are fetched or a reader tab is created; the grant
 * tab resumes by opening the reader for the same source tab.
 */
export async function runPdfCommand(
  tab: { id?: number | undefined; url?: string | undefined } | undefined,
): Promise<void> {
  const target =
    tab?.id === undefined
      ? (await browser.tabs.query({ active: true, currentWindow: true }))[0]
      : tab;
  if (target?.id === undefined) return;
  if (gatedEngine) {
    await runGatedPdfCommand(gatedEngine, target);
    return;
  }
  await openPdfForTab(target);
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
  if (gatedEngine) {
    await runGatedPageCommand(gatedEngine, tabId, command, frameId);
    return;
  }
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

async function injectIfGmailBanner(tabId: number, url: string): Promise<void> {
  const host = pageHost(url);
  const pattern = originPattern(url);
  if (!host || !pattern) return;

  const settings = await loadSettings();
  const allowed = await browser.permissions.contains({ origins: [pattern] }).catch(() => false);
  if (
    !shouldAutoInjectGmailBanner({
      settingOn: settings.gmailTranslateBanner,
      host,
      originAllowed: allowed,
    })
  ) {
    return;
  }
  await ensureContentScript(tabId);
}

/** Re-injects open Gmail tabs after the banner setting is turned back on. */
export async function injectGmailBannerPages(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.gmailTranslateBanner) return;
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url) continue;
    void injectIfGmailBanner(tab.id, tab.url);
  }
}

async function injectIfOutlookBanner(tabId: number, url: string): Promise<void> {
  const host = pageHost(url);
  const pattern = originPattern(url);
  if (!host || !pattern) return;

  const settings = await loadSettings();
  const allowed = await browser.permissions.contains({ origins: [pattern] }).catch(() => false);
  if (
    !shouldAutoInjectOutlookBanner({
      settingOn: settings.gmailTranslateBanner,
      host,
      originAllowed: allowed,
    })
  ) {
    return;
  }
  await ensureContentScript(tabId);
}

/** Re-injects open Outlook tabs after the banner setting is turned back on. */
export async function injectOutlookBannerPages(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.gmailTranslateBanner) return;
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url) continue;
    void injectIfOutlookBanner(tab.id, tab.url);
  }
}
