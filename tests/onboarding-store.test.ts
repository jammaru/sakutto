import { describe, expect, it } from 'vitest';
import { defaultOnboardingStoreChoice, planOnboardingDownload } from '@/ui/onboarding-store';

describe('defaultOnboardingStoreChoice', () => {
  it('recommends browser storage when the picker exists, and keeps an existing folder', () => {
    expect(defaultOnboardingStoreChoice(true)).toBe('browser');
    expect(defaultOnboardingStoreChoice(true, false)).toBe('browser');
    expect(defaultOnboardingStoreChoice(true, true)).toBe('folder');
    expect(defaultOnboardingStoreChoice(false)).toBe('browser');
    expect(defaultOnboardingStoreChoice(false, true)).toBe('browser');
  });
});

describe('planOnboardingDownload', () => {
  it('downloads into the browser when the shared folder is not offered', () => {
    expect(
      planOnboardingDownload({ pickerAvailable: false, choice: 'folder', modelState: 'absent' }),
    ).toBe('download');
    expect(
      planOnboardingDownload({ pickerAvailable: true, choice: 'browser', modelState: 'absent' }),
    ).toBe('download');
  });

  it('stays on the choice screen when the picker is cancelled or refused', () => {
    expect(
      planOnboardingDownload({
        pickerAvailable: true,
        choice: 'folder',
        pick: 'cancelled',
        modelState: 'absent',
      }),
    ).toBe('stay');
    expect(
      planOnboardingDownload({
        pickerAvailable: true,
        choice: 'folder',
        pick: 'denied',
        modelState: 'absent',
      }),
    ).toBe('stay');
    expect(
      planOnboardingDownload({
        pickerAvailable: true,
        choice: 'folder',
        pick: 'failed',
        modelState: 'absent',
      }),
    ).toBe('stay');
  });

  it('skips the download when a verified official file is already in the folder', () => {
    expect(
      planOnboardingDownload({
        pickerAvailable: true,
        choice: 'folder',
        pick: 'granted',
        modelState: 'ready',
      }),
    ).toBe('skip');
  });

  it('downloads into the folder when it is empty, and stays on a bad file', () => {
    expect(
      planOnboardingDownload({
        pickerAvailable: true,
        choice: 'folder',
        pick: 'granted',
        modelState: 'absent',
      }),
    ).toBe('download');
    expect(
      planOnboardingDownload({
        pickerAvailable: true,
        choice: 'folder',
        pick: 'granted',
        integrityFailed: true,
        modelState: 'error',
      }),
    ).toBe('stay');
  });
});
