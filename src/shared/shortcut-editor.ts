import { browser } from 'wxt/browser';
import { isFirefoxBuild } from './browser';

/**
 * Chrome keeps the key bindings for an extension and offers no API to change them; the editor
 * at `chrome://extensions/shortcuts` is the only place a user can. Only an extension API call
 * may open a `chrome://` page, so a link needs this rather than an `href`.
 *
 * Firefox 137+ has `commands.openShortcutSettings()`. That is the documented way to open the
 * same editor; `about:addons` is not a substitute.
 *
 * Resolves false when the tab could not be opened, so the caller can say so.
 */
export async function openShortcutEditor(): Promise<boolean> {
  if (isFirefoxBuild()) {
    const commands = browser.commands as { openShortcutSettings?: () => Promise<void> } | undefined;
    if (typeof commands?.openShortcutSettings === 'function') {
      try {
        await commands.openShortcutSettings();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  try {
    await browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
    return true;
  } catch {
    return false;
  }
}
