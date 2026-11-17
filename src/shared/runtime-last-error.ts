import { browser } from 'wxt/browser';

/** Read and clear Chrome's unchecked messaging error without throwing in other hosts. */
export function readRuntimeLastError(): void {
  try {
    void browser.runtime.lastError;
  } catch {
    // Older or non-extension hosts may not expose runtime.lastError.
  }
}

/** Chrome may set runtime.lastError on the next turn after a port closes (BFCache). */
export function scheduleRuntimeLastErrorClear(): void {
  readRuntimeLastError();
  queueMicrotask(() => readRuntimeLastError());
}

export interface MessagePort {
  postMessage(message: unknown): void;
}

export function postPortMessage(port: MessagePort, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
    // The other end is gone.
  }
  scheduleRuntimeLastErrorClear();
}

export function safeSendResponse(
  sendResponse: (response: unknown) => void,
  response: unknown,
): void {
  try {
    sendResponse(response);
  } catch {
    // The caller went away before the async handler finished.
  }
  scheduleRuntimeLastErrorClear();
}

interface ChromeRuntime {
  sendMessage?: (message: unknown, callback: () => void) => unknown;
  lastError?: unknown;
}

function readChromeRuntimeLastError(): void {
  try {
    const runtime = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
    if (runtime) void runtime.lastError;
  } catch {
    // Chrome APIs are absent or already gone.
  }
}

/** Broadcast to extension pages and clear pending unchecked errors on success and failure. */
export async function broadcastRuntimeMessage(message: unknown): Promise<void> {
  const chromeRuntime = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
  const chromeSend = chromeRuntime?.sendMessage;

  if (chromeRuntime && typeof chromeSend === 'function') {
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          readChromeRuntimeLastError();
          readRuntimeLastError();
          resolve();
        };
        let result: unknown;
        try {
          result = chromeSend.call(chromeRuntime, message, done);
        } catch {
          done();
          return;
        }
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          void (result as PromiseLike<unknown>).then(done, done);
        }
      });
    } catch {
      readChromeRuntimeLastError();
      readRuntimeLastError();
    } finally {
      readChromeRuntimeLastError();
      readRuntimeLastError();
    }
    return;
  }

  try {
    await browser.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    readRuntimeLastError();
  } finally {
    readRuntimeLastError();
  }
}

/** Run a promise API and turn a rejected message into null after clearing lastError. */
export interface DisconnectPort {
  onDisconnect: { addListener(listener: () => void): void };
}

/** Ensure every extension port clears lastError before its own disconnect cleanup runs. */
export function bindPortDisconnectCleanup(
  port: DisconnectPort,
  onDisconnect: () => void = () => undefined,
): void {
  port.onDisconnect.addListener(() => {
    readRuntimeLastError();
    queueMicrotask(() => readRuntimeLastError());
    onDisconnect();
  });
}

export async function swallowMessagingError<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    readRuntimeLastError();
    return null;
  }
}
