import { browser, type Browser } from 'wxt/browser';
import { registerContentPortReconnect, trackContentPort } from './content-port-lifecycle';
import { readRuntimeLastError } from './runtime-last-error';

/** Written on `document.documentElement` so a reloaded build can claim the page from an orphan script. */
export const CONTENT_INSTANCE_DOC_ATTR = 'data-sakutto-extension-instance';

/** Per content-script bundle load (not shared on globalThis — reload may reuse the same world). */
export const MAIL_BANNER_INSTANCE_DATASET = 'sakuttoExtensionInstance';

export const CONTENT_LIVENESS_PORT = 'sakutto-content-liveness';

export const CONTENT_LIVENESS_GENERATION_MESSAGE = 'generation' as const;

/** Background posts this; bumps reset the live-token registry in the page. */
export const CONTENT_LOAD_GENERATION_GLOBAL_KEY = '__sakuttoContentLoadGeneration';

/** Tokens registered by bundles that still have a valid extension context in this world. */
export const LIVE_CONTENT_INSTANCE_REGISTRY_KEY = '__sakuttoLiveContentInstanceTokens';

export const MAIL_BANNER_HOST_TAGS = ['sakutto-gmail', 'sakutto-outlook'] as const;

type ContentInstanceGlobals = typeof globalThis & {
  [CONTENT_LOAD_GENERATION_GLOBAL_KEY]?: string;
  [LIVE_CONTENT_INSTANCE_REGISTRY_KEY]?: Set<string>;
};

function mintContentScriptInstanceToken(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `fallback-${Math.random().toString(36).slice(2)}`;
}

/** Unique per bundle (`content.js` vs `mail.js`); not stored on globalThis. */
const CONTENT_SCRIPT_INSTANCE_TOKEN = mintContentScriptInstanceToken();

export function contentScriptInstanceToken(): string {
  return CONTENT_SCRIPT_INSTANCE_TOKEN;
}

export function isContentLoadGenerationMessage(
  message: unknown,
): message is { type: typeof CONTENT_LIVENESS_GENERATION_MESSAGE; generation: string } {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === CONTENT_LIVENESS_GENERATION_MESSAGE &&
    typeof (message as { generation?: unknown }).generation === 'string'
  );
}

/** Bumps the page generation after reload; the first message in a load does not clear live tokens. */
export function applyContentLoadGeneration(generation: string): void {
  if (generation.length === 0) return;
  const host = globalThis as ContentInstanceGlobals;
  const previous = host[CONTENT_LOAD_GENERATION_GLOBAL_KEY];
  if (previous === generation) return;
  host[CONTENT_LOAD_GENERATION_GLOBAL_KEY] = generation;
  if (previous !== undefined) {
    host[LIVE_CONTENT_INSTANCE_REGISTRY_KEY] = new Set();
  }
}

function liveContentInstanceRegistry(): Set<string> {
  const host = globalThis as ContentInstanceGlobals;
  let registry = host[LIVE_CONTENT_INSTANCE_REGISTRY_KEY];
  if (!registry) {
    registry = new Set();
    host[LIVE_CONTENT_INSTANCE_REGISTRY_KEY] = registry;
  }
  return registry;
}

export function registerLiveContentInstanceToken(token: string): void {
  if (token.length === 0) return;
  liveContentInstanceRegistry().add(token);
}

export function unregisterLiveContentInstanceToken(token: string): void {
  if (token.length === 0) return;
  liveContentInstanceRegistry().delete(token);
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

/**
 * Removes banner hosts whose owning instance is not registered as live in this world (orphan
 * scripts after reload, or unstamped shells). Bundles in the same load keep each other's hosts.
 */
export function purgeForeignMailBannerHosts(doc: Document, keepInstanceToken: string): void {
  if (keepInstanceToken.length === 0) return;
  registerLiveContentInstanceToken(keepInstanceToken);
  const live = liveContentInstanceRegistry();
  for (const tag of MAIL_BANNER_HOST_TAGS) {
    for (const node of doc.querySelectorAll(tag)) {
      if (!(node instanceof HTMLElement)) continue;
      const owner = node.dataset[MAIL_BANNER_INSTANCE_DATASET] ?? '';
      if (owner.length === 0 || live.has(owner)) continue;
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
): () => void {
  let tornDown = false;
  let reconnectAttempt = 0;
  let port: Browser.runtime.Port | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const baseDelay = options.initialReconnectMs ?? 500;

  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    onInvalidate();
  };

  const scheduleReconnect = (): void => {
    if (tornDown || reconnectTimer !== null) return;
    const delay = Math.min(30_000, baseDelay * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (tornDown || port) return;
    try {
      const next = browser.runtime.connect({ name: CONTENT_LIVENESS_PORT });
      port = next;
      reconnectAttempt = 0;
      const untrack = trackContentPort(next, () => {
        if (port === next) port = null;
      });
      next.onMessage.addListener((message: unknown) => {
        if (isContentLoadGenerationMessage(message)) {
          applyContentLoadGeneration(message.generation);
        }
      });
      next.onDisconnect.addListener(() => {
        readRuntimeLastError();
        queueMicrotask(() => readRuntimeLastError());
        const invalidated = isExtensionContextInvalidated();
        untrack();
        if (port === next) port = null;
        else return;
        if (tornDown) return;
        if (invalidated) {
          teardown();
          return;
        }
        scheduleReconnect();
      });
    } catch {
      port = null;
      const invalidated = isExtensionContextInvalidated();
      readRuntimeLastError();
      if (invalidated) {
        teardown();
        return;
      }
      scheduleReconnect();
    }
  };

  const reconnectNow = (): void => {
    if (tornDown || port) return;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  };

  // The port lifecycle module closes live ports on pagehide and runs this on a persisted
  // pageshow, so the liveness channel reopens before the page becomes interactive again.
  const unregisterReconnect = registerContentPortReconnect(reconnectNow);
  connect();

  return () => {
    tornDown = true;
    unregisterReconnect();
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      port?.disconnect();
    } catch {
      readRuntimeLastError();
    }
    port = null;
  };
}

/** @internal */
export function resetContentInstanceGlobalsForTests(): void {
  const host = globalThis as ContentInstanceGlobals;
  delete host[CONTENT_LOAD_GENERATION_GLOBAL_KEY];
  delete host[LIVE_CONTENT_INSTANCE_REGISTRY_KEY];
}
