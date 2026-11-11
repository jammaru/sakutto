import type { SharedFolderAdoptResult } from '@/engine/model/shared-folder';
import type { ModelState } from '@/shared/engine-status';

export type OnboardingStoreChoice = 'browser' | 'folder';

export type OnboardingDownloadPlan = 'download' | 'skip' | 'stay';

/** Chromium first-run recommends a shared folder. No picker means OPFS, with no choice. */
export function defaultOnboardingStoreChoice(pickerAvailable: boolean): OnboardingStoreChoice {
  return pickerAvailable ? 'folder' : 'browser';
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
