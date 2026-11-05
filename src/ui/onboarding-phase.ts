import type { ModelStatus } from '@/shared/engine-status';

export type OnboardingPhase = 'consent' | 'downloading' | 'paused' | 'ready' | 'error';

export function onboardingPhaseAfterStatus(
  phase: OnboardingPhase,
  state: ModelStatus['state'],
  canPause: boolean,
): OnboardingPhase {
  if (state === 'error') return 'error';
  if (state === 'ready' || state === 'loaded') return 'ready';
  if (phase === 'ready' || phase === 'error') return phase;
  if (state === 'downloading' || state === 'verifying' || state === 'loading') return 'downloading';
  if (state === 'partial' && canPause) return 'paused';
  if (phase !== 'consent') return 'paused';
  return phase;
}
