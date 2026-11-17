import type { Browser } from 'wxt/browser';
import { readRuntimeLastError } from './runtime-last-error';

interface TrackedContentPort {
  port: Browser.runtime.Port;
  onPageHide?: (() => void) | undefined;
}

const trackedPorts = new Set<TrackedContentPort>();
const reconnectHooks = new Set<() => void>();
let pageHidden = false;
let installed = false;

/** Track a content-side runtime port so pagehide can close it before BFCache freezes it. */
export function trackContentPort(port: Browser.runtime.Port, onPageHide?: () => void): () => void {
  const entry: TrackedContentPort = { port, onPageHide };
  trackedPorts.add(entry);
  return () => trackedPorts.delete(entry);
}

/** Hooks run on a persisted pageshow, after pagehide closed the tracked ports. */
export function registerContentPortReconnect(hook: () => void): () => void {
  reconnectHooks.add(hook);
  return () => reconnectHooks.delete(hook);
}

export function isContentPageHidden(): boolean {
  return pageHidden;
}

export function installContentPortLifecycle(): () => void {
  if (installed) return () => undefined;
  installed = true;

  const onPageHide = (): void => {
    pageHidden = true;
    for (const entry of [...trackedPorts]) {
      entry.onPageHide?.();
      readRuntimeLastError();
      try {
        entry.port.disconnect();
      } catch {
        readRuntimeLastError();
      }
    }
    trackedPorts.clear();
  };

  const onPageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;
    pageHidden = false;
    for (const hook of [...reconnectHooks]) {
      try {
        hook();
      } catch {
        // A failed reconnect must not block the other content hooks.
      }
    }
  };

  window.addEventListener('pagehide', onPageHide, { capture: true });
  window.addEventListener('pageshow', onPageShow);

  return () => {
    window.removeEventListener('pagehide', onPageHide, { capture: true });
    window.removeEventListener('pageshow', onPageShow);
    installed = false;
    pageHidden = false;
  };
}
