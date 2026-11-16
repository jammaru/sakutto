import { browser } from 'wxt/browser';

/**
 * Focus an extension page that is already open, otherwise create it once. Settings actions
 * that need onboarding should not add another tab every time the reader presses the same
 * button; the existing tab keeps its live progress and license state.
 */
function absoluteUrl(pathOrUrl: string): string {
  return /^[a-z][a-z0-9+.-]*:/iu.test(pathOrUrl)
    ? pathOrUrl
    : browser.runtime.getURL(pathOrUrl as never);
}

export async function openOrFocusExtensionTab(pathOrUrl: string): Promise<number | null> {
  const url = absoluteUrl(pathOrUrl);
  const pattern = `${url.split(/[?#]/u)[0]}*`;

  try {
    const tabs = await browser.tabs.query({ url: pattern });
    const existing = tabs.find((tab) => tab.id !== undefined);
    if (existing?.id !== undefined) {
      await browser.tabs.update(existing.id, { active: true }).catch(() => undefined);
      if (existing.windowId !== undefined) {
        await browser.windows.update(existing.windowId, { focused: true }).catch(() => undefined);
      }
      return existing.id;
    }
  } catch {
    // Not every page can query tabs (or has the tabs API in a test). Falling through still
    // opens the page exactly once.
  }

  try {
    const created = await browser.tabs.create({ url });
    return created.id ?? null;
  } catch {
    return null;
  }
}
