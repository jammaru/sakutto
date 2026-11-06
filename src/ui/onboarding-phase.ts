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

const HTTP_STATUS = /\bHTTP (\d{3})\b/;

/**
 * Prefer the status from a failed model request. Other engine errors stay
 * visible. A missing detail falls back to the generic setup message.
 */
export function onboardingErrorMessage(input: {
  error?: string | undefined;
  fallback: string;
  http: (status: string) => string;
}): string {
  const detail = input.error?.trim() ?? '';
  const status = HTTP_STATUS.exec(detail)?.[1];
  if (status) return input.http(status);
  if (detail.length > 0) return detail;
  return input.fallback;
}
