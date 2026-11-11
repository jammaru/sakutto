import { folderPermissionError, isFolderPermissionError } from '../errors';
import { isPermissionDenied } from './file-store';
import type { SharedFolderPermission } from './folder-status';
import type { FolderPermission } from './shared-folder';

/** ModelStatus.error token and EngineError.code for a missing directory grant. */
export const FOLDER_PERMISSION_ERROR = 'model-folder-permission';

export type FolderAccessState = 'none' | 'granted' | 'prompt' | 'denied' | 'revoked';

export type FolderGrantSurface = 'tab' | 'popup' | 'offscreen' | 'unknown';

export function isFolderAccessError(error: unknown): boolean {
  return isFolderPermissionError(error) || isPermissionDenied(error);
}

export { folderPermissionError };

/**
 * Where this document can run `requestPermission`. Chrome's "Allow on every visit"
 * restore prompt is a tab-only UI. Popups auto-grant for the visit. Offscreen cannot
 * prompt at all.
 */
export function folderGrantSurface(href: string): FolderGrantSurface {
  try {
    const path = new URL(href).pathname;
    if (path.endsWith('/offscreen.html')) return 'offscreen';
    if (path.endsWith('/popup.html')) return 'popup';
    if (
      path.endsWith('/options.html') ||
      path.endsWith('/onboarding.html') ||
      path.endsWith('/typed.html') ||
      path.endsWith('/sample.html')
    ) {
      return 'tab';
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

export function folderGrantCanOfferPersistentPrompt(surface: FolderGrantSurface): boolean {
  return surface === 'tab';
}

/**
 * Detect the live grant. `opened` means the stored handle actually reads in this
 * document (queryPermission can say `prompt` while a leftover handle still works).
 * A NotAllowedError/SecurityError mid-read is `revoked`, not a missing file.
 */
export function resolveFolderAccessState(input: {
  configured: boolean;
  queried: FolderPermission | SharedFolderPermission;
  opened: boolean;
  readError?: unknown;
  /** Fake-engine tests force queryPermission; OPFS mocks always open. */
  queryAuthoritative?: boolean;
}): FolderAccessState {
  if (!input.configured) return 'none';
  if (isPermissionDenied(input.readError)) return 'revoked';
  if (input.queryAuthoritative) {
    if (input.queried === 'granted' && input.opened) return 'granted';
    if (input.queried === 'denied') return 'denied';
    if (input.queried === 'granted') return 'revoked';
    return 'prompt';
  }
  if (input.opened) return 'granted';
  if (input.queried === 'denied') return 'denied';
  if (input.queried === 'granted') return 'revoked';
  return 'prompt';
}

export function folderAccessNeedsRestore(state: FolderAccessState): boolean {
  return state === 'prompt' || state === 'denied' || state === 'revoked';
}

/** Snapshot field: revoked is shown as `prompt` so the same restore button applies. */
export function folderPermissionForStatus(state: FolderAccessState): SharedFolderPermission {
  if (state === 'none') return 'unknown';
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'prompt';
}
