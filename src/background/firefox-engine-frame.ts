import { browser } from 'wxt/browser';
import {
  WEBGPU_DEBUG_STORAGE_KEY,
  isWebGpuDebugProfile,
  offscreenDocumentUrl,
} from '@/shared/gpu-diagnostic';
import type { OffscreenDocumentApi } from './offscreen-lifecycle';
import { ENGINE_PAGE } from './chrome-offscreen';

const FRAME_ID = 'sakutto-engine-frame';
const FRAME_READY = 'sakutto-engine-frame';
const KEEP_ALIVE_KEY = 'sakuttoEngineKeepAlive';
const KEEP_ALIVE_MS = 15_000;
const FRAME_READY_TIMEOUT_MS = 8_000;

export { ENGINE_PAGE };

function existingFrame(): HTMLIFrameElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(FRAME_ID) as HTMLIFrameElement | null;
}

function enginePageUrl(): string {
  return browser.runtime.getURL(`/${ENGINE_PAGE}`);
}

async function engineFrameSrc(): Promise<string> {
  try {
    const stored = await browser.storage.local.get(WEBGPU_DEBUG_STORAGE_KEY);
    const profile = stored[WEBGPU_DEBUG_STORAGE_KEY];
    return offscreenDocumentUrl(enginePageUrl(), isWebGpuDebugProfile(profile) ? profile : 'off');
  } catch {
    return enginePageUrl();
  }
}

/**
 * Firefox has no offscreen documents. The event page can host DOM, so the engine page is an
 * iframe of `offscreen.html`. Message ports do not keep an event page alive; writing
 * `storage.session` on an interval does (bug 1851373).
 */
export function createFirefoxEngineFrameApi(): OffscreenDocumentApi {
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  const ping = async (): Promise<void> => {
    try {
      await browser.storage.session.set({ [KEEP_ALIVE_KEY]: Date.now() });
    } catch {
      // Session storage can be missing in tests.
    }
  };

  const startKeepAlive = (): void => {
    if (keepAliveTimer) return;
    void ping();
    keepAliveTimer = setInterval(() => {
      void ping();
    }, KEEP_ALIVE_MS);
  };

  const stopKeepAlive = (): void => {
    if (!keepAliveTimer) return;
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  };

  return {
    hasDocument: async () => {
      const frame = existingFrame();
      return frame !== null && frame.dataset.ready === '1';
    },
    createDocument: async () => {
      if (typeof document === 'undefined') {
        throw new Error('The Firefox engine frame needs a background document.');
      }
      const current = existingFrame();
      if (current?.dataset.ready === '1') {
        startKeepAlive();
        return;
      }
      current?.remove();

      const frame = document.createElement('iframe');
      frame.id = FRAME_ID;
      frame.hidden = true;
      frame.setAttribute('aria-hidden', 'true');
      frame.src = await engineFrameSrc();

      await waitForFrameReady(frame);
      startKeepAlive();
    },
    closeDocument: async () => {
      existingFrame()?.remove();
      stopKeepAlive();
    },
  };
}

function waitForFrameReady(frame: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (error) {
        frame.remove();
        reject(error);
        return;
      }
      frame.dataset.ready = '1';
      resolve();
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.contentWindow) return;
      if (event.origin !== window.location.origin && event.origin !== 'null') return;
      const data = event.data as { source?: unknown; type?: unknown };
      if (data?.source !== FRAME_READY || data.type !== 'ready') return;
      finish();
    };
    const timer = window.setTimeout(() => {
      finish(new Error('The Firefox engine frame did not become ready in time.'));
    }, FRAME_READY_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    // A failed src in tests (happy-dom cannot fetch extension pages) fires `error`
    // and would remove the frame before `load`. Timeout is the failure path.
    frame.addEventListener('load', () => finish(), { once: true });
    document.documentElement.append(frame);
  });
}
