import { describe, expect, it } from 'vitest';
import {
  MAX_TYPED_CHARS,
  copyTranslation,
  isTranslateShortcut,
  normalizeTypedInput,
  planTypedTranslation,
  typedReadiness,
  typedTargetNeedsChrome,
  type TypedReadinessInput,
} from '@/shared/typed-translation';

describe('typed translation direction', () => {
  it('translates into the chosen target and offers the other half of the main pair', () => {
    expect(planTypedTranslation('ja')).toEqual({
      ok: true,
      sourceLanguage: null,
      targetLanguage: 'ja',
      other: 'en',
    });
    expect(planTypedTranslation('en').other).toBe('ja');
  });

  /**
   * The source is deliberately unset. PLaMo translates a paragraph without being told which
   * language it is in, and a guess here would be a second place to be wrong when a user
   * pastes a language the picker never offered.
   */
  it('never guesses the source language', () => {
    for (const target of ['ja', 'en', 'zh-hans', 'de'] as const) {
      expect(planTypedTranslation(target).sourceLanguage).toBeNull();
    }
  });

  it('falls back to Japanese for a value that is not a target language', () => {
    // The settings normalizer refuses these, so this only guards a hand-edited record.
    const plan = planTypedTranslation('xx' as never);
    expect(plan.targetLanguage).toBe('ja');
    expect(plan.other).toBe('en');
  });

  it('keeps other targets as themselves instead of forcing the pair', () => {
    const plan = planTypedTranslation('de');
    expect(plan.targetLanguage).toBe('de');
    expect(plan.other).toBe('ja');
  });
});

describe('typed readiness gate', () => {
  const base: TypedReadinessInput = { consent: true, modelState: 'loaded', plamoReady: true };

  it('translates once the model is loaded and consent is recorded', () => {
    expect(typedReadiness(base)).toBe('ready');
  });

  it('asks for consent before doing anything else', () => {
    expect(typedReadiness({ ...base, consent: false })).toBe('no-consent');
    // Consent comes first even when the model is missing, so the onboarding gate is the one
    // the user sees rather than a download button they are not allowed to press.
    expect(typedReadiness({ consent: false, modelState: 'absent', plamoReady: false })).toBe(
      'no-consent',
    );
  });

  it('names the setup step before the model can run', () => {
    expect(typedReadiness({ ...base, modelState: 'absent', plamoReady: false })).toBe(
      'model-absent',
    );
    expect(typedReadiness({ ...base, modelState: 'partial', plamoReady: false })).toBe(
      'model-partial',
    );
    for (const state of ['downloading', 'verifying', 'loading'] as const) {
      expect(typedReadiness({ ...base, modelState: state, plamoReady: false })).toBe('model-busy');
    }
    expect(typedReadiness({ ...base, modelState: 'error', plamoReady: false })).toBe('model-error');
  });

  it('treats a stored file as ready even before the runtime reports it loaded', () => {
    for (const state of ['ready', 'loaded'] as const) {
      expect(typedReadiness({ ...base, modelState: state, plamoReady: false })).toBe('ready');
    }
  });

  it('never offers the built-in translator for typed text', () => {
    // A Chrome-only target has no PLaMo path. The page is refused in the UI instead of
    // quietly switching engines, which would show a non-PLaMo translation in a PLaMo box.
    expect(typedTargetNeedsChrome('pt')).toBe(true);
    expect(typedTargetNeedsChrome('ja')).toBe(false);
    expect(typedTargetNeedsChrome('de')).toBe(false);
  });
});

describe('typed input', () => {
  it('normalizes line endings and horizontal runs but keeps blank-line structure', () => {
    expect(normalizeTypedInput('a\r\nb\r\n\r\nc')).toBe('a\nb\n\nc');
    expect(normalizeTypedInput('  two   spaces\tand a tab  ')).toBe('two spaces and a tab');
    expect(normalizeTypedInput('line\nnext')).toBe('line\nnext');
    expect(normalizeTypedInput('')).toBe('');
    expect(normalizeTypedInput('   \n  ')).toBe('');
  });

  it('keeps the per-request ceiling in step with the engine protocol', () => {
    // `MAX_SEGMENT_TEXT` in the offscreen protocol is 20,000 characters; a longer typed
    // segment would be rejected before it reached the model.
    expect(MAX_TYPED_CHARS).toBe(20_000);
  });
});

describe('the run shortcut', () => {
  it('runs on Ctrl+Enter and Cmd+Enter', () => {
    expect(isTranslateShortcut({ key: 'Enter', ctrlKey: true })).toBe(true);
    expect(isTranslateShortcut({ key: 'Enter', metaKey: true })).toBe(true);
  });

  it('leaves a plain Enter to insert a line break', () => {
    // The box is for paragraphs, so Enter has to keep its normal meaning.
    expect(isTranslateShortcut({ key: 'Enter' })).toBe(false);
    expect(isTranslateShortcut({ key: 'Enter', shiftKey: true } as never)).toBe(false);
  });

  it('never fires from an IME composition or with Alt held', () => {
    expect(isTranslateShortcut({ key: 'Enter', ctrlKey: true, isComposing: true })).toBe(false);
    expect(isTranslateShortcut({ key: 'Enter', ctrlKey: true, altKey: true })).toBe(false);
  });

  it('ignores every other key', () => {
    expect(isTranslateShortcut({ key: 'a', ctrlKey: true })).toBe(false);
    expect(isTranslateShortcut({ key: 'Tab', ctrlKey: true })).toBe(false);
  });
});

describe('copying a translation', () => {
  it('copies the text when the clipboard accepts it', async () => {
    const written: string[] = [];
    const ok = await copyTranslation('訳文', {
      writeText: async (text) => {
        written.push(text);
      },
    });
    expect(ok).toBe(true);
    expect(written).toEqual(['訳文']);
  });

  it('reports a refused clipboard instead of throwing', async () => {
    expect(
      await copyTranslation('訳文', {
        writeText: async () => {
          throw new Error('NotAllowedError');
        },
      }),
    ).toBe(false);
    expect(await copyTranslation('訳文', null)).toBe(false);
    expect(await copyTranslation('   ', { writeText: async () => undefined })).toBe(false);
  });
});
