import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_POLL_MAX_BACKOFF_MS,
  ONBOARDING_PROGRESS_STALE_MS,
  onboardingCanTry,
  onboardingErrorMessage,
  onboardingPhaseAfterStatus,
  onboardingPollDelayMs,
  shouldApplyOnboardingPollResult,
  shouldPollOnboardingProgress,
} from '@/ui/onboarding-phase';

describe('onboardingPhaseAfterStatus', () => {
  it('keeps the ready screen while the downloaded model loads', () => {
    expect(onboardingPhaseAfterStatus('ready', 'loading', true)).toBe('ready');
    expect(onboardingPhaseAfterStatus('ready', 'loaded', true)).toBe('ready');
    expect(onboardingPhaseAfterStatus('ready', 'error', true)).toBe('error');
  });

  it('follows the download until the file is ready', () => {
    expect(onboardingPhaseAfterStatus('downloading', 'verifying', true)).toBe('downloading');
    expect(onboardingPhaseAfterStatus('downloading', 'loading', true)).toBe('downloading');
    expect(onboardingPhaseAfterStatus('consent', 'ready', false)).toBe('consent');
    expect(onboardingPhaseAfterStatus('consent', 'loaded', false)).toBe('consent');
    expect(onboardingPhaseAfterStatus('consent', 'ready', true)).toBe('ready');
    expect(onboardingPhaseAfterStatus('downloading', 'partial', true)).toBe('paused');
    expect(onboardingPhaseAfterStatus('consent', 'partial', false)).toBe('consent');
  });

  it('does not turn paused back into downloading from stale progress', () => {
    expect(onboardingPhaseAfterStatus('paused', 'downloading', true)).toBe('paused');
    expect(onboardingPhaseAfterStatus('paused', 'verifying', true)).toBe('paused');
    expect(onboardingPhaseAfterStatus('paused', 'loading', true)).toBe('paused');
  });

  it('leaves an error in place until a later ready state', () => {
    expect(onboardingPhaseAfterStatus('error', 'loading', true)).toBe('error');
    expect(onboardingPhaseAfterStatus('error', 'ready', true)).toBe('ready');
  });
});

/**
 * The reported screenshot: a download card at 46% with 「今すぐ試す」 beside 中断 and 閉じる.
 * A sample page opened there keeps its source text, so the card must not offer it.
 */
describe('onboardingCanTry', () => {
  it('keeps the sample control hidden while the download is in progress', () => {
    expect(onboardingCanTry('consent')).toBe(false);
    expect(onboardingCanTry('downloading')).toBe(false);
    expect(onboardingCanTry('paused')).toBe(false);
    expect(onboardingCanTry('error')).toBe(false);
  });

  it('offers the sample only when the model is on disk', () => {
    expect(onboardingCanTry('ready')).toBe(true);
  });
});

describe('onboardingErrorMessage', () => {
  const http = (status: string) => `HTTP ${status}`;

  it('shows the HTTP status from a rejected model download', () => {
    expect(
      onboardingErrorMessage({
        error: 'The model request failed with HTTP 403.',
        fallback: 'Setup could not start. Please try again.',
        http,
      }),
    ).toBe('HTTP 403');
    expect(
      onboardingErrorMessage({
        error: 'The model request failed with HTTP 404.',
        fallback: 'Setup could not start. Please try again.',
        http,
      }),
    ).toBe('HTTP 404');
  });

  it('keeps a specific engine error and uses the fallback when none arrived', () => {
    expect(
      onboardingErrorMessage({
        error: 'The downloaded model failed its digest check.',
        fallback: 'Setup could not start. Please try again.',
        http,
      }),
    ).toBe('The downloaded model failed its digest check.');
    expect(
      onboardingErrorMessage({
        error: '   ',
        fallback: 'Setup could not start. Please try again.',
        http,
      }),
    ).toBe('Setup could not start. Please try again.');
  });
});

describe('shouldPollOnboardingProgress', () => {
  it('polls only while downloading after push progress has gone silent', () => {
    expect(
      shouldPollOnboardingProgress({
        phase: 'downloading',
        now: 10_000,
        lastProgressAt: 10_000 - ONBOARDING_PROGRESS_STALE_MS + 1,
        inFlight: false,
      }),
    ).toBe(false);

    expect(
      shouldPollOnboardingProgress({
        phase: 'downloading',
        now: 10_000,
        lastProgressAt: 10_000 - ONBOARDING_PROGRESS_STALE_MS,
        inFlight: false,
      }),
    ).toBe(true);
  });

  it('skips polling when not downloading or a poll is already in flight', () => {
    for (const phase of ['consent', 'paused', 'ready', 'error'] as const) {
      expect(
        shouldPollOnboardingProgress({
          phase,
          now: 20_000,
          lastProgressAt: 0,
          inFlight: false,
        }),
      ).toBe(false);
    }

    expect(
      shouldPollOnboardingProgress({
        phase: 'downloading',
        now: 20_000,
        lastProgressAt: 0,
        inFlight: true,
      }),
    ).toBe(false);
  });

  it('backs off exponentially after repeated poll failures up to the cap', () => {
    expect(onboardingPollDelayMs(0)).toBe(ONBOARDING_PROGRESS_STALE_MS);
    expect(onboardingPollDelayMs(1)).toBe(ONBOARDING_PROGRESS_STALE_MS * 2);
    expect(onboardingPollDelayMs(2)).toBe(ONBOARDING_PROGRESS_STALE_MS * 4);
    expect(onboardingPollDelayMs(3)).toBe(ONBOARDING_PROGRESS_STALE_MS * 8);
    expect(onboardingPollDelayMs(10)).toBe(ONBOARDING_POLL_MAX_BACKOFF_MS);

    expect(
      shouldPollOnboardingProgress({
        phase: 'downloading',
        now: 10_000,
        lastProgressAt: 10_000 - ONBOARDING_PROGRESS_STALE_MS,
        inFlight: false,
        failures: 1,
      }),
    ).toBe(false);

    expect(
      shouldPollOnboardingProgress({
        phase: 'downloading',
        now: 10_000,
        lastProgressAt: 10_000 - ONBOARDING_PROGRESS_STALE_MS * 2,
        inFlight: false,
        failures: 1,
      }),
    ).toBe(true);
  });
});

describe('shouldApplyOnboardingPollResult', () => {
  it('ignores a stale downloading poll response after pause or generation change', () => {
    expect(
      shouldApplyOnboardingPollResult({
        disposed: false,
        phase: 'downloading',
        startedGeneration: 2,
        currentGeneration: 2,
      }),
    ).toBe(true);

    // User clicked Pause while the poll request was in flight.
    expect(
      shouldApplyOnboardingPollResult({
        disposed: false,
        phase: 'paused',
        startedGeneration: 2,
        currentGeneration: 3,
      }),
    ).toBe(false);

    // User paused and resumed again before the earlier poll resolved.
    expect(
      shouldApplyOnboardingPollResult({
        disposed: false,
        phase: 'downloading',
        startedGeneration: 2,
        currentGeneration: 4,
      }),
    ).toBe(false);

    // A runtime progress message queued before Pause uses the same guard on delivery.
    expect(
      shouldApplyOnboardingPollResult({
        disposed: false,
        phase: 'paused',
        startedGeneration: 3,
        currentGeneration: 3,
      }),
    ).toBe(false);

    // Component unmounted before the poll resolved.
    expect(
      shouldApplyOnboardingPollResult({
        disposed: true,
        phase: 'downloading',
        startedGeneration: 2,
        currentGeneration: 2,
      }),
    ).toBe(false);
  });
});
