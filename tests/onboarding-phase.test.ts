import { describe, expect, it } from 'vitest';
import { onboardingPhaseAfterStatus } from '@/ui/onboarding-phase';

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
