/**
 * OWA installs capture listeners before the idle content script can run. This tiny bridge is
 * installed at `document_start` and forwards a banner press to the controller as soon as it
 * registers, so a page-level `stopImmediatePropagation()` cannot take the click away.
 *
 * The bridge lives on the isolated world's `globalThis`; both content-script bundles run in
 * that same world, so the early listener and the controller share it without page globals.
 */

export const MAIL_BANNER_PRESS_EVENTS = [
  'pointerdown',
  'mousedown',
  'pointerup',
  'mouseup',
  'click',
  'keydown',
] as const;

export type MailBannerPressHook = (event: Event) => boolean;

interface MailBannerPressBridge {
  view: Window | null;
  hooks: Set<MailBannerPressHook>;
  listeners: Map<string, EventListener>;
}

const BRIDGE_KEY = '__sakuttoMailBannerPressBridge';

type BridgeGlobal = typeof globalThis & {
  [BRIDGE_KEY]?: MailBannerPressBridge;
};

function bridge(): MailBannerPressBridge {
  const host = globalThis as BridgeGlobal;
  const existing = host[BRIDGE_KEY];
  if (existing) return existing;
  const created: MailBannerPressBridge = {
    view: null,
    hooks: new Set(),
    listeners: new Map(),
  };
  host[BRIDGE_KEY] = created;
  return created;
}

/** A primary-button press, or Enter/Space on a focused banner button. */
export function isMailBannerPressTrigger(event: Event): boolean {
  if (event.type === 'keydown') {
    const key = (event as KeyboardEvent).key;
    return (
      (key === 'Enter' || key === ' ' || key === 'Spacebar') &&
      (event as KeyboardEvent).repeat !== true
    );
  }
  const button = (event as MouseEvent).button;
  return typeof button !== 'number' || button === 0;
}

export function mailBannerDebug(scope: string, details?: Record<string, unknown>): void {
  try {
    /* eslint-disable no-console -- cheap, always-on mail diagnostics */
    if (details) console.debug('[sakutto-mail]', scope, details);
    else console.debug('[sakutto-mail]', scope);
    /* eslint-enable no-console */
  } catch {
    // A page can replace console; diagnostics must never break the banner.
  }
}

function forwardPress(event: Event): void {
  if (!isMailBannerPressTrigger(event)) return;
  const hooks = bridge().hooks;
  if (hooks.size === 0) return;
  for (const hook of hooks) {
    if (!hook(event)) continue;
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
}

/**
 * Installs the window-capture listeners. Call this from a `document_start` content script,
 * before the mail page's own scripts have had a chance to register their handlers.
 */
export function installEarlyMailBannerPresses(view: Window = window): () => void {
  const state = bridge();
  if (state.view === view && state.listeners.size > 0) {
    return () => uninstallEarlyMailBannerPresses(view);
  }

  state.view = view;
  state.listeners.clear();
  for (const type of MAIL_BANNER_PRESS_EVENTS) {
    const listener = (event: Event): void => {
      forwardPress(event);
    };
    state.listeners.set(type, listener);
    view.addEventListener(type, listener, true);
  }
  mailBannerDebug('early listener installed', { events: [...MAIL_BANNER_PRESS_EVENTS] });
  return () => uninstallEarlyMailBannerPresses(view);
}

function uninstallEarlyMailBannerPresses(view: Window): void {
  const state = bridge();
  if (state.view !== view) return;
  for (const [type, listener] of state.listeners) {
    view.removeEventListener(type, listener, true);
  }
  state.listeners.clear();
  state.view = null;
}

/** Registers the controller's press handler with the early listener. */
export function registerMailBannerPressHook(hook: MailBannerPressHook): () => void {
  const state = bridge();
  state.hooks.add(hook);
  return () => {
    state.hooks.delete(hook);
  };
}
