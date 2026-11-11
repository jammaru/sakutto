/**
 * Caption session traces. Enable with `localStorage.sakuttoCaptionDebug = '1'`
 * and read `console.debug` in the page's content-script world.
 */
export function captionDebug(scope: string, details?: Record<string, unknown>): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage || storage.getItem('sakuttoCaptionDebug') !== '1') return;
    /* eslint-disable no-console -- opt-in page-world caption traces */
    if (details) console.debug('[sakutto-captions]', scope, details);
    else console.debug('[sakutto-captions]', scope);
    /* eslint-enable no-console */
  } catch {
    // Private mode / opaque storage.
  }
}
