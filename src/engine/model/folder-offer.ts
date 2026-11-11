import { browser } from 'wxt/browser';
import type { ModelStatus } from '@/shared/engine-status';

const SESSION_KEY = 'sharedFolderOfferLater';
export const SHARED_FOLDER_CHANGED_EVENT = 'sakutto:shared-folder';

export interface SharedFolderOfferInput {
  pickerAvailable: boolean;
  folderConfigured: boolean;
  dismissed: boolean;
  laterHidden: boolean;
  opfsHasOfficialModel: boolean;
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
 * Chromium-only, once, and only when an official model already lives in OPFS.
 * Declining leaves "save in this browser" unchanged. The picker never opens by itself.
 */
export function shouldOfferSharedFolderMove(input: SharedFolderOfferInput): boolean {
  if (!input.pickerAvailable) return false;
  if (input.folderConfigured) return false;
  if (input.dismissed) return false;
  if (input.laterHidden) return false;
  return input.opfsHasOfficialModel;
}

export async function readSharedFolderOfferLater(): Promise<boolean> {
  try {
    const stored = await browser.storage.session.get(SESSION_KEY);
    return stored[SESSION_KEY] === true;
  } catch {
    return false;
  }
}

export async function writeSharedFolderOfferLater(): Promise<void> {
  await browser.storage.session.set({ [SESSION_KEY]: true });
}

export type SharedFolderOfferPick = 'moved' | 'cancelled' | 'denied' | 'failed';

/**
 * One click: open the picker (caller must do that from a gesture), then reload the
 * engine so the verified OPFS → folder move runs. Cancel/deny leave OPFS as-is.
 */
export async function completeSharedFolderOffer(deps: {
  pick: () => Promise<{ status: 'granted' | 'cancelled' | 'denied' | 'failed' }>;
  reload: () => Promise<unknown>;
}): Promise<SharedFolderOfferPick> {
  const picked = await deps.pick();
  if (picked.status !== 'granted') return picked.status;
  await deps.reload();
  return 'moved';
}

/** Same-page notice after a picker/reload so options, popup, and folder settings refresh. */
export function notifySharedFolderChanged(): void {
  window.dispatchEvent(new Event(SHARED_FOLDER_CHANGED_EVENT));
}
