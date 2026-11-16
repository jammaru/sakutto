import { browser } from 'wxt/browser';

/** Written on `document.documentElement` so a reloaded build can claim the page from an orphan script. */
export const CONTENT_INSTANCE_DOC_ATTR = 'data-sakutto-extension-instance';

/** Written on each mail banner host so stray hosts from a previous build are identifiable in the DOM. */
export const MAIL_BANNER_INSTANCE_DATASET = 'sakuttoExtensionInstance';

export const CONTENT_LIVENESS_PORT = 'sakutto-content-liveness';

export const MAIL_BANNER_HOST_TAGS = ['sakutto-gmail', 'sakutto-outlook'] as const;

export function contentExtensionId(): string {
  try {
    return browser.runtime.id;
  } catch {
    return '';
  }
}

export function stampMailBannerInstance(
  host: HTMLElement,
  extensionId = contentExtensionId(),
): void {
  if (extensionId.length === 0) return;
  host.dataset[MAIL_BANNER_INSTANCE_DATASET] = extensionId;
}

/** Marks this content-script generation as the owner of the page (visible to every isolated world). */
export function claimContentExtensionInstance(
  doc: Document,
  extensionId = contentExtensionId(),
): void {
  if (extensionId.length === 0) return;
  doc.documentElement.setAttribute(CONTENT_INSTANCE_DOC_ATTR, extensionId);
}

/** Removes mail banner hosts owned by another extension instance (or left unstamped). */
export function purgeForeignMailBannerHosts(doc: Document, keepExtensionId: string): void {
  if (keepExtensionId.length === 0) return;
  for (const tag of MAIL_BANNER_HOST_TAGS) {
    for (const node of doc.querySelectorAll(tag)) {
      if (!(node instanceof HTMLElement)) continue;
      const owner = node.dataset[MAIL_BANNER_INSTANCE_DATASET] ?? '';
      if (owner === keepExtensionId) continue;
      node.remove();
    }
  }
}

/** Removes mail banner hosts stamped with this instance after invalidation teardown. */
export function removeOwnedMailBannerHosts(
  doc: Document,
  extensionId = contentExtensionId(),
): void {
  if (extensionId.length === 0) return;
  for (const tag of MAIL_BANNER_HOST_TAGS) {
    for (const node of doc.querySelectorAll(tag)) {
      if (!(node instanceof HTMLElement)) continue;
      if ((node.dataset[MAIL_BANNER_INSTANCE_DATASET] ?? '') !== extensionId) continue;
      node.remove();
    }
  }
}

/**
 * Fires when the extension reloads and this content script's `runtime` is invalidated.
 * A short-lived port is enough; the background only needs to accept the connection.
 */
export function installContentInvalidationCleanup(onInvalidate: () => void): void {
  let done = false;
  const teardown = (): void => {
    if (done) return;
    done = true;
    onInvalidate();
  };
  try {
    const port = browser.runtime.connect({ name: CONTENT_LIVENESS_PORT });
    port.onDisconnect.addListener(teardown);
  } catch {
    teardown();
  }
}
