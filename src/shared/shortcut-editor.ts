import { browser } from 'wxt/browser';

/**
 * Chrome keeps the key bindings for an extension and offers no API to change them; the editor
 * at `chrome://extensions/shortcuts` is the only place a user can. Only an extension API call
 * may open a `chrome://` page, so a link needs this rather than an `href`.
 *
 * Resolves false when the tab could not be opened, so the caller can say so.
 */
export async function openShortcutEditor(): Promise<boolean> {
  try {
    await browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
    return true;
  } catch {
    return false;
  }
}
