import type { ModelStatus } from '@/shared/engine-status';

export type OnboardingPhase = 'consent' | 'downloading' | 'paused' | 'ready' | 'error';

/** Poll model status when push progress has been silent for this long while downloading. */
export const ONBOARDING_PROGRESS_STALE_MS = 2_000;

/** Upper bound for exponential backoff when fallback status polling fails repeatedly. */
export const ONBOARDING_POLL_MAX_BACKOFF_MS = 30_000;

export function onboardingPollDelayMs(
  failures: number,
  baseMs = ONBOARDING_PROGRESS_STALE_MS,
  maxMs = ONBOARDING_POLL_MAX_BACKOFF_MS,
): number {
  const count = Math.max(0, Math.floor(failures));
  if (count === 0) return baseMs;
  return Math.min(maxMs, baseMs * 2 ** count);
}

export function shouldPollOnboardingProgress(input: {
  phase: OnboardingPhase;
  now: number;
  lastProgressAt: number;
  inFlight: boolean;
  failures?: number;
  staleMs?: number;
}): boolean {
  if (input.phase !== 'downloading' || input.inFlight) return false;
  const threshold = input.staleMs ?? onboardingPollDelayMs(input.failures ?? 0);
  return input.now - input.lastProgressAt >= threshold;
}

export function shouldApplyOnboardingPollResult(input: {
  disposed: boolean;
  phase: OnboardingPhase;
  startedGeneration: number;
  currentGeneration: number;
}): boolean {
  return (
    !input.disposed &&
    input.phase === 'downloading' &&
    input.startedGeneration === input.currentGeneration
  );
}

/**
 * Whether the card may offer a way to start translating right now. Only a phase that has
 * the model on disk qualifies: a sample page opened during the download keeps its source
 * text, so a "try it now" control there would promise a translation that cannot happen.
 */
export function onboardingCanTry(phase: OnboardingPhase): boolean {
  return phase === 'ready';
}

export function onboardingPhaseAfterStatus(
  phase: OnboardingPhase,
  state: ModelStatus['state'],
  started: boolean,
): OnboardingPhase {
  // A verified file already in a folder (or OPFS) must not skip the license click.
  if (phase === 'consent' && !started) return 'consent';
  if (state === 'error') return 'error';
  if (state === 'ready' || state === 'loaded') return 'ready';
  if (phase === 'ready' || phase === 'error') return phase;
  if (
    phase === 'paused' &&
    (state === 'downloading' || state === 'verifying' || state === 'loading')
  ) {
    return 'paused';
  }
  if (state === 'downloading' || state === 'verifying' || state === 'loading') return 'downloading';
  if (state === 'partial' && started) return 'paused';
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
