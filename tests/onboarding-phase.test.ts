import { describe, expect, it } from 'vitest';
import { onboardingErrorMessage, onboardingPhaseAfterStatus } from '@/ui/onboarding-phase';

describe('onboardingPhaseAfterStatus', () => {
  it('keeps the ready screen while the downloaded model loads', () => {
    expect(onboardingPhaseAfterStatus('ready', 'loading', true)).toBe('ready');
    expect(onboardingPhaseAfterStatus('ready', 'loaded', true)).toBe('ready');
    expect(onboardingPhaseAfterStatus('ready', 'error', true)).toBe('error');
  });

  it('follows the download until the file is ready', () => {
    expect(onboardingPhaseAfterStatus('downloading', 'verifying', true)).toBe('downloading');
    expect(onboardingPhaseAfterStatus('downloading', 'loading', true)).toBe('downloading');
    expect(onboardingPhaseAfterStatus('consent', 'ready', false)).toBe('ready');
    expect(onboardingPhaseAfterStatus('downloading', 'partial', true)).toBe('paused');
    expect(onboardingPhaseAfterStatus('consent', 'partial', false)).toBe('consent');
  });

  it('leaves an error in place until a later ready state', () => {
    expect(onboardingPhaseAfterStatus('error', 'loading', true)).toBe('error');
    expect(onboardingPhaseAfterStatus('error', 'ready', true)).toBe('ready');
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
