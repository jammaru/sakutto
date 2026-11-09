import { browser } from 'wxt/browser';
import { originPattern, pageHost, loadSiteRule } from '@/dom/sites';
import { ensureContentScript } from '@/shared/page-bridge';
import { requestPageCommand, type PageCommandName } from '@/shared/messages';
import { isShortcutCommand, SHORTCUT_PAGE_COMMANDS } from '@/shared/shortcuts';

interface PageTranslationCanceller {
  cancelTab(tabId: number): void;
}

export function installPageActions(translations?: PageTranslationCanceller): void {
  installMenus();

  browser.commands.onCommand.addListener((command) => {
    if (!isShortcutCommand(command)) return;
    void runOnActiveTab(SHORTCUT_PAGE_COMMANDS[command]);
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    const tabId = tab?.id;
    if (tabId === undefined) return;
    const pageCommand =
      info.menuItemId === 'translate-selection'
        ? 'selection'
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
  });
}

async function runOnActiveTab(command: PageCommandName): Promise<void> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId === undefined) return;
  await runCommand(tabId, command);
}

async function runCommand(tabId: number, command: PageCommandName): Promise<void> {
  if (!(await ensureContentScript(tabId))) return;
  await requestPageCommand(tabId, command);
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
