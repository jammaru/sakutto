import type { SharedFolderAdoptResult } from '@/engine/model/shared-folder';
import type { ModelState } from '@/shared/engine-status';

export type OnboardingStoreChoice = 'browser' | 'folder';

export type OnboardingDownloadPlan = 'download' | 'skip' | 'stay';

/**
 * First-run recommends browser storage (OPFS) on every Chromium, including Edge.
 * A profile that already has a shared folder keeps it. No picker means OPFS, with no choice.
 */
export function defaultOnboardingStoreChoice(
  pickerAvailable: boolean,
  folderAlreadyConfigured = false,
): OnboardingStoreChoice {
  if (pickerAvailable && folderAlreadyConfigured) return 'folder';
  return 'browser';
}

/**
 * What onboarding should do after the license click, before any network fetch.
 * A cancelled picker or a denied permission stays on the choice screen.
 */
export function planOnboardingDownload(input: {
  pickerAvailable: boolean;
  choice: OnboardingStoreChoice;
  pick?: SharedFolderAdoptResult;
  modelState?: ModelState;
  integrityFailed?: boolean;
}): OnboardingDownloadPlan {
  if (input.pickerAvailable && input.choice === 'folder') {
    if (input.pick === undefined || input.pick === 'cancelled') return 'stay';
    if (input.pick === 'denied' || input.pick === 'failed') return 'stay';
    if (input.integrityFailed) return 'stay';
  }
  if (input.modelState === 'ready' || input.modelState === 'loaded') return 'skip';
  return 'download';
}
