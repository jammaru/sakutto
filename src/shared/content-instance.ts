import { browser } from 'wxt/browser';

/** Written on `document.documentElement` so a reloaded build can claim the page from an orphan script. */
export const CONTENT_INSTANCE_DOC_ATTR = 'data-sakutto-extension-instance';

/** Per content-script load; distinguishes orphan scripts after reload (runtime.id stays the same). */
export const MAIL_BANNER_INSTANCE_DATASET = 'sakuttoExtensionInstance';

export const CONTENT_LIVENESS_PORT = 'sakutto-content-liveness';

export const MAIL_BANNER_HOST_TAGS = ['sakutto-gmail', 'sakutto-outlook'] as const;

const CONTENT_SCRIPT_INSTANCE_TOKEN =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `fallback-${Math.random().toString(36).slice(2)}`;

export function contentScriptInstanceToken(): string {
  return CONTENT_SCRIPT_INSTANCE_TOKEN;
}

export function contentExtensionId(): string {
  try {
    return browser.runtime.id;
  } catch {
    return '';
  }
}

/** True when this content script can no longer talk to the extension (reload/uninstall). */
export function isExtensionContextInvalidated(): boolean {
  try {
    const id = browser.runtime.id;
    if (typeof id !== 'string' || id.length === 0) return true;
  } catch {
    return true;
  }
  const message = browser.runtime.lastError?.message ?? '';
  return /extension context invalidated/i.test(message);
}

export function stampMailBannerInstance(
  host: HTMLElement,
  instanceToken = contentScriptInstanceToken(),
): void {
  if (instanceToken.length === 0) return;
  host.dataset[MAIL_BANNER_INSTANCE_DATASET] = instanceToken;
}

/** Marks this content-script generation as the owner of the page (visible to every isolated world). */
export function claimContentExtensionInstance(
  doc: Document,
  instanceToken = contentScriptInstanceToken(),
): void {
  if (instanceToken.length === 0) return;
  doc.documentElement.setAttribute(CONTENT_INSTANCE_DOC_ATTR, instanceToken);
}

/** Removes mail banner hosts owned by another content-script instance (or left unstamped). */
export function purgeForeignMailBannerHosts(doc: Document, keepInstanceToken: string): void {
  if (keepInstanceToken.length === 0) return;
  for (const tag of MAIL_BANNER_HOST_TAGS) {
    for (const node of doc.querySelectorAll(tag)) {
      if (!(node instanceof HTMLElement)) continue;
      const owner = node.dataset[MAIL_BANNER_INSTANCE_DATASET] ?? '';
      if (owner === keepInstanceToken) continue;
      node.remove();
    }
  }
}

/** Removes mail banner hosts stamped with this instance after invalidation teardown. */
export function removeOwnedMailBannerHosts(
  doc: Document,
  instanceToken = contentScriptInstanceToken(),
): void {
  if (instanceToken.length === 0) return;
  for (const tag of MAIL_BANNER_HOST_TAGS) {
    for (const node of doc.querySelectorAll(tag)) {
      if (!(node instanceof HTMLElement)) continue;
      if ((node.dataset[MAIL_BANNER_INSTANCE_DATASET] ?? '') !== instanceToken) continue;
      node.remove();
    }
  }
}

export interface ContentInvalidationCleanupOptions {
  /** First reconnect delay in ms; doubles on repeated idle disconnects up to 30s. */
  initialReconnectMs?: number;
}

/**
 * Detects a true extension reload/uninstall. A port disconnect alone is not enough: the service
 * worker may be idle-terminated while `runtime.id` is still valid.
 */
export function installContentInvalidationCleanup(
  onInvalidate: () => void,
  options: ContentInvalidationCleanupOptions = {},
): void {
  let tornDown = false;
  let reconnectAttempt = 0;
  const baseDelay = options.initialReconnectMs ?? 500;

  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    onInvalidate();
  };

  const connect = (): void => {
    if (tornDown) return;
    try {
      const port = browser.runtime.connect({ name: CONTENT_LIVENESS_PORT });
      reconnectAttempt = 0;
      port.onDisconnect.addListener(() => {
        if (tornDown) return;
        if (isExtensionContextInvalidated()) {
          teardown();
          return;
        }
        const delay = Math.min(30_000, baseDelay * 2 ** reconnectAttempt);
        reconnectAttempt += 1;
        setTimeout(connect, delay);
      });
    } catch {
      if (isExtensionContextInvalidated()) {
        teardown();
        return;
      }
      const delay = Math.min(30_000, baseDelay * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      setTimeout(connect, delay);
    }
  };

  connect();
}
