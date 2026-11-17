/** Last-resort wait when `cancel` is unavailable (engines without picker cancel). */
export const PICKER_CANCEL_FALLBACK_MS = 60_000;

function filesFromInput(input: HTMLInputElement): File[] | null {
  const list = input.files;
  if (!list || list.length === 0) return null;
  return Array.from(list);
}

export function supportsDirectoryPickerCancel(): boolean {
  if (typeof HTMLInputElement === 'undefined') return false;
  return 'oncancel' in HTMLInputElement.prototype;
}

export interface PickDirectoryFilesOptions {
  /** Fires when the window regains focus while still waiting for `change` or `cancel`. */
  onAwaitingFiles?: () => void;
  /** Overrides {@link supportsDirectoryPickerCancel} (tests only). */
  supportsCancel?: boolean;
}

/**
 * Opens a `webkitdirectory` input and resolves with the chosen files. The click must happen
 * directly inside the user gesture. With picker `cancel` support (Firefox >= 91, Chromium),
 * only `change` and `cancel` settle the promise. Otherwise a long fallback re-checks
 * `input.files` after focus returns.
 */
export function pickDirectoryFiles(
  input: HTMLInputElement | null,
  windowRef: Window | null = typeof window === 'undefined' ? null : window,
  options: PickDirectoryFilesOptions = {},
): Promise<File[] | null> {
  if (!input) return Promise.resolve(null);

  const supportsCancel = options.supportsCancel ?? supportsDirectoryPickerCancel();

  return new Promise((resolve) => {
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      input.removeEventListener('change', onChange);
      if (supportsCancel) input.removeEventListener('cancel', onCancel);
      windowRef?.removeEventListener('focus', onFocus);
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    };
    const finish = (files: File[] | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(files);
    };
    const onChange = (): void => {
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      finish(filesFromInput(input));
    };
    const onCancel = (): void => {
      finish(null);
    };
    const onFocus = (): void => {
      options.onAwaitingFiles?.();
      if (supportsCancel) return;
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        finish(filesFromInput(input));
      }, PICKER_CANCEL_FALLBACK_MS);
    };

    input.addEventListener('change', onChange);
    if (supportsCancel) input.addEventListener('cancel', onCancel);
    windowRef?.addEventListener('focus', onFocus);
    try {
      input.value = '';
      input.click();
    } catch {
      finish(null);
    }
  });
}
