import { browser } from 'wxt/browser';
import { requestPageInfo } from './messages';

const CONTENT_SCRIPT_FILE = '/content-scripts/content.js';

export async function ensureContentScript(
  tabId: number,
  options: { allFrames?: boolean } = {},
): Promise<boolean> {
  if (!options.allFrames && (await requestPageInfo(tabId))) return true;

  try {
    await browser.scripting.executeScript({
      target: { tabId, allFrames: options.allFrames === true },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch {
    if (!options.allFrames) return false;
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        files: [CONTENT_SCRIPT_FILE],
      });
    } catch {
      return false;
    }
  }

  return (await requestPageInfo(tabId)) !== null;
}
