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
