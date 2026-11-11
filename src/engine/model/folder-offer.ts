export const SHARED_FOLDER_CHANGED_EVENT = 'sakutto:shared-folder';

export const FOLDER_SETTINGS_PICK_QUERY = 'folder';
export const FOLDER_SETTINGS_PICK_VALUE = 'pick';
export const FOLDER_SETTINGS_HASH = 'model-folder';

/** Settings tab URL so the picker and `requestPermission` run in a real tab. */
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
