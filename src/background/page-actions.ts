import { browser } from 'wxt/browser';
import { originPattern, pageHost, loadSiteRule } from '@/dom/sites';
import { ensureContentScript } from '@/shared/page-bridge';
import { requestPageCommand, type PageCommandName } from '@/shared/messages';
import { noteShortcutCommandAssigned } from '@/shared/shortcut-assignment';
import { isShortcutCommand, SHORTCUT_PAGE_COMMANDS } from '@/shared/shortcuts';

interface PageTranslationCanceller {
  cancelTab(tabId: number): void;
}

export function installPageActions(translations?: PageTranslationCanceller): void {
  installMenus();

  browser.commands.onCommand.addListener((command) => {
    if (!isShortcutCommand(command)) return;
    void noteShortcutCommandAssigned(command);
    void runOnActiveTab(SHORTCUT_PAGE_COMMANDS[command]);
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
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
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    translations?.cancelTab(tabId);
  });
}

function installMenus(): void {
  // Chrome decides menu contents when it opens, so hiding after contextmenu is too
  // late and the hidden state would be global across tabs. Keep this item on every
  // editable; ineligible fields no-op with feedback in the page.
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
    browser.contextMenus.create({
      id: 'translate-compose',
      title: browser.i18n.getMessage('contextTranslateCompose'),
      contexts: ['editable'],
    });
  });
}

async function runOnActiveTab(command: PageCommandName): Promise<void> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId === undefined) return;
  await runCommand(tabId, command);
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
