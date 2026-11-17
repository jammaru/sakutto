import { browser } from 'wxt/browser';

/** Read and clear Chrome's unchecked messaging error without throwing in other hosts. */
export function readRuntimeLastError(): void {
  try {
    void browser.runtime.lastError;
  } catch {
    // Older or non-extension hosts may not expose runtime.lastError.
  }
}

/** Broadcast to extension pages and clear pending unchecked errors on success and failure. */
export async function broadcastRuntimeMessage(message: unknown): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        readRuntimeLastError();
        resolve();
      };
      let result: unknown;
      try {
        result = (
          browser.runtime.sendMessage as (message: unknown, callback: () => void) => unknown
        )(message, done);
      } catch {
        done();
        return;
      }
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void (result as PromiseLike<unknown>).then(done, done);
      }
    });
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
