import { describe, expect, it } from 'vitest';
import { shouldPrepareTranslatorPack } from '@/ui/onboarding-store';

describe('onboarding translator pack decision', () => {
  it('asks for the pack before a download into browser storage', () => {
    expect(
      shouldPrepareTranslatorPack({
        builtInTranslator: true,
        modelState: 'absent',
        choice: 'browser',
      }),
    ).toBe(true);
  });

  it('skips the pack when the model is already on disk', () => {
    for (const modelState of ['ready', 'loaded'] as const) {
      expect(
        shouldPrepareTranslatorPack({
          builtInTranslator: true,
          modelState,
          choice: 'browser',
        }),
      ).toBe(false);
    }
  });

  it('skips the pack for a shared-folder path that may skip the download', () => {
    for (const modelState of ['absent', 'ready', 'loading'] as const) {
      expect(
        shouldPrepareTranslatorPack({
          builtInTranslator: true,
          modelState,
          choice: 'folder',
        }),
      ).toBe(false);
    }
  });

  it('does not call Chrome Translator on Firefox or without the built-in UI', () => {
    expect(
      shouldPrepareTranslatorPack({
        builtInTranslator: false,
        modelState: 'absent',
        choice: 'browser',
      }),
    ).toBe(false);
  });
});
