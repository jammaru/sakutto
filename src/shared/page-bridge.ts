import { browser } from 'wxt/browser';
import { requestPageInfo } from './messages';

const CONTENT_SCRIPT_FILE = '/content-scripts/content.js';
/** Firefox can refuse an injection for a moment while a reloaded tab replaces its document. */
const CONTENT_SCRIPT_RETRY_DELAYS_MS = [80, 200, 400] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function injectContentScript(tabId: number, allFrames: boolean): Promise<boolean> {
  try {
    await browser.scripting.executeScript({
      target: { tabId, allFrames },
      files: [CONTENT_SCRIPT_FILE],
    });
    return true;
  } catch {
    if (!allFrames) return false;
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        files: [CONTENT_SCRIPT_FILE],
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Make sure the page has a content script that answers `page:info`. A normal page answers
 * on the first ping. After a Firefox reload the document may still be swapping, so an
 * injection that is refused (or lands before the listener is ready) is retried briefly
 * instead of surfacing "this page cannot be translated" on the first popup click.
 */
export async function ensureContentScript(
  tabId: number,
  options: { allFrames?: boolean } = {},
): Promise<boolean> {
  const allFrames = options.allFrames === true;
  if (!allFrames && (await requestPageInfo(tabId))) return true;

  for (let attempt = 0; attempt <= CONTENT_SCRIPT_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await delay(CONTENT_SCRIPT_RETRY_DELAYS_MS[attempt - 1] ?? 0);
    if (!(await injectContentScript(tabId, allFrames))) continue;
    if (await requestPageInfo(tabId)) return true;
  }

  return false;
}
