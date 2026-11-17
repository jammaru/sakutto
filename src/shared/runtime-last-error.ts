import { browser } from 'wxt/browser';

/** Read and clear Chrome's unchecked messaging error without throwing in other hosts. */
export function readRuntimeLastError(): void {
  try {
    void browser.runtime.lastError;
  } catch {
    // Older or non-extension hosts may not expose runtime.lastError.
  }
}

/** Run a promise API and turn a rejected message into null after clearing lastError. */
export async function swallowMessagingError<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    readRuntimeLastError();
    return null;
  }
}
