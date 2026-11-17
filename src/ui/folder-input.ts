/**
 * Opens a `webkitdirectory` input and resolves with the chosen files. The click must happen
 * directly inside the user gesture. If focus returns before the change event, the picker was
 * cancelled; resolve `null` instead of leaving the calling flow pending forever.
 */
export function pickDirectoryFiles(
  input: HTMLInputElement | null,
  windowRef: Window | null = typeof window === 'undefined' ? null : window,
): Promise<File[] | null> {
  if (!input) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let focusTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      windowRef?.removeEventListener('focus', onFocus);
      if (focusTimer !== null) clearTimeout(focusTimer);
    };
    const finish = (files: File[] | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(files);
    };
    const onChange = (): void => {
      finish(input.files ? Array.from(input.files) : []);
    };
    const onCancel = (): void => {
      finish(null);
    };
    const onFocus = (): void => {
      focusTimer = setTimeout(() => finish(null), 300);
    };

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    windowRef?.addEventListener('focus', onFocus);
    try {
      input.value = '';
      input.click();
    } catch {
      finish(null);
    }
  });
}
