import type { SharedFolderAdoptResult } from '@/engine/model/shared-folder';
import type { ModelState } from '@/shared/engine-status';

export type OnboardingStoreChoice = 'browser' | 'folder';

export type OnboardingDownloadPlan = 'download' | 'skip' | 'stay';

/**
 * Whether the onboarding click should ask Chrome to install its built-in translator pack.
 *
 * The call needs the click's activation, so it must be decided before the first slow await.
 * A model already on disk, or a shared-folder setup that may skip the download, is not a
 * reason to create a translator service. That repeated service is what Chrome reports as
 * "The translation service count exceeded the limitation."
 */
export function shouldPrepareTranslatorPack(input: {
  builtInTranslator: boolean;
  modelState: ModelState;
  choice: OnboardingStoreChoice;
}): boolean {
  if (!input.builtInTranslator) return false;
  if (input.modelState === 'ready' || input.modelState === 'loaded') return false;
  return input.choice === 'browser';
}

/**
 * First-run uses this browser's internal storage on every browser. Chromium's shared folder
 * and Firefox's copy-from-folder flow are explicit alternatives, so an untouched Start click
 * never opens a picker. The capability argument keeps the default stable across async status
 * refreshes without adding work on mount.
 */
export function defaultOnboardingStoreChoice(pickerAvailable: boolean): OnboardingStoreChoice {
  void pickerAvailable;
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
