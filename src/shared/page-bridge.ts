import { browser } from 'wxt/browser';
import { requestPageInfo } from './messages';

const CONTENT_SCRIPT_FILE = '/content-scripts/content.js';

export async function ensureContentScript(tabId: number): Promise<boolean> {
  if (await requestPageInfo(tabId)) return true;

  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch {
    return false;
  }

  return (await requestPageInfo(tabId)) !== null;
}
