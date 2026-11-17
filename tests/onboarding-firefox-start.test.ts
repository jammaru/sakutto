// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultOnboardingStoreChoice, planOnboardingDownload } from '@/ui/onboarding-store';

const onboarding = readFileSync(
  resolve(import.meta.dirname, '../src/entrypoints/onboarding/App.svelte'),
  'utf8',
);

describe('Firefox onboarding start flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to browser storage without opening the folder picker', () => {
    expect(defaultOnboardingStoreChoice(false)).toBe('browser');
    const start = onboarding.slice(onboarding.indexOf('async function start()'));
    expect(start).not.toContain("storeChoice = 'copy'");
    expect(start).toContain("if (!pickerAvailable && storeChoice === 'copy')");
  });

  it('continues to skip download when a copy leaves the model ready', () => {
    expect(
      planOnboardingDownload({
        pickerAvailable: false,
        choice: 'browser',
        modelState: 'ready',
      }),
    ).toBe('skip');
  });

  it('plans a download after an empty shared folder on Firefox', () => {
    expect(
      planOnboardingDownload({
        pickerAvailable: false,
        choice: 'browser',
        modelState: 'absent',
      }),
    ).toBe('download');
  });

  it('returns cancelled, copied, and needs-download outcomes from the copy helper', () => {
    expect(onboarding).toContain(
      "type FirefoxFolderPickOutcome = 'cancelled' | 'copied' | 'needs-download'",
    );
    expect(onboarding).toContain("if (outcome === 'cancelled') return;");
    expect(onboarding).toContain("return 'needs-download'");
    expect(onboarding).toContain("return 'copied'");
    expect(onboarding).toContain("if (outcome === 'cancelled') return;");
    expect(onboarding).toMatch(/alreadyReady[\s\S]{0,200}phase = 'ready'/);
  });
});
