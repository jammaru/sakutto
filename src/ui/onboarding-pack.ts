import type { ModelState } from '@/shared/engine-status';
import type { OnboardingStoreChoice } from './onboarding-store';

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
