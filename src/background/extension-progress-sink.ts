import { browser } from 'wxt/browser';
import { broadcastRuntimeMessage, readRuntimeLastError } from '@/shared/runtime-last-error';

/** Progress for toolbar popup and other non-tab extension pages, plus extension tabs. */
export async function sendExtensionModelProgress(item: unknown): Promise<void> {
  await broadcastRuntimeMessage(item);
  const origin = new URL(browser.runtime.getURL('/')).origin;
  const tabs = await browser.tabs.query({ url: `${origin}/*` });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    await browser.tabs.sendMessage(tab.id, item).catch(() => undefined);
    readRuntimeLastError();
  }
}
