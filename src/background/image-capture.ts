import { browser } from 'wxt/browser';

interface CaptureSender {
  tab?:
    | {
        id?: number | undefined;
        windowId?: number | undefined;
      }
    | undefined;
}

/** Capture only the tab that requested the fallback, while it is still active. */
export async function captureActiveSenderTab(sender: CaptureSender): Promise<string | null> {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  if (tabId === undefined || windowId === undefined) return null;

  try {
    // Check immediately before captureVisibleTab: that API captures whichever tab is active,
    // not necessarily the content-script sender that supplied the crop rectangle.
    const [active] = await browser.tabs.query({ active: true, windowId });
    if (active?.id !== tabId) return null;
    return await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch {
    return null;
  }
}
