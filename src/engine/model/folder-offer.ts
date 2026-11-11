import type { ModelStatus } from '@/shared/engine-status';

export const SHARED_FOLDER_CHANGED_EVENT = 'sakutto:shared-folder';

export interface SharedFolderOfferInput {
  pickerAvailable: boolean;
  folderConfigured: boolean;
  dismissed: boolean;
  translating: boolean;
  opfsHasOfficialModel: boolean;
  /** True after this popup visit already rendered the card. */
  shownThisVisit?: boolean;
  /** True after Later on this visit. */
  closedThisVisit?: boolean;
}

/** Official GGUF is on disk in this browser (not a leftover partial download). */
export function opfsHasOfficialModel(statuses: readonly Pick<ModelStatus, 'state'>[]): boolean {
  return statuses.some(
    (status) =>
      status.state === 'ready' ||
      status.state === 'loaded' ||
      status.state === 'loading' ||
      status.state === 'verifying',
  );
}

/**
 * Persist only after the popup actually rendered the card. Hidden during translation
 * does not count as shown. Settings keep the folder picker.
 */
export function shouldPersistSharedFolderOfferImpression(
  input: Pick<
    SharedFolderOfferInput,
    'pickerAvailable' | 'folderConfigured' | 'translating' | 'opfsHasOfficialModel'
  >,
): boolean {
  if (!input.pickerAvailable) return false;
  if (input.folderConfigured) return false;
  if (input.translating) return false;
  return input.opfsHasOfficialModel;
}

/**
 * Chromium popup only, once, and only when an official model already lives in OPFS.
 * The first render persists the hide for later visits. Settings keep the folder picker.
 * Declining leaves "save in this browser" unchanged. The picker never opens by itself.
 */
export function shouldOfferSharedFolderMove(input: SharedFolderOfferInput): boolean {
  if (!shouldPersistSharedFolderOfferImpression(input)) return false;
  if (input.closedThisVisit) return false;
  if (input.dismissed && !input.shownThisVisit) return false;
  return true;
}

export const FOLDER_SETTINGS_PICK_QUERY = 'folder';
export const FOLDER_SETTINGS_PICK_VALUE = 'pick';
export const FOLDER_SETTINGS_HASH = 'model-folder';

/** Settings tab URL for the first grant. Chrome can offer “Allow on every visit” there. */
export function sharedFolderSettingsHref(extensionUrl: (path: '/options.html') => string): string {
  return `${extensionUrl('/options.html')}?${FOLDER_SETTINGS_PICK_QUERY}=${FOLDER_SETTINGS_PICK_VALUE}#${FOLDER_SETTINGS_HASH}`;
}

export function shouldHighlightFolderPicker(href: string): boolean {
  try {
    const url = new URL(href);
    return (
      url.searchParams.get(FOLDER_SETTINGS_PICK_QUERY) === FOLDER_SETTINGS_PICK_VALUE ||
      url.hash === `#${FOLDER_SETTINGS_HASH}`
    );
  } catch {
    return false;
  }
}

/** Same-page notice after a picker/reload so options, popup, and folder settings refresh. */
export function notifySharedFolderChanged(): void {
  window.dispatchEvent(new Event(SHARED_FOLDER_CHANGED_EVENT));
}
