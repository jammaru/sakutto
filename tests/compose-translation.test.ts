import { describe, expect, it } from 'vitest';
import {
  composePairOther,
  draftLooksLikeTarget,
  planComposeTranslation,
} from '@/shared/compose-translation';

describe('compose translation direction', () => {
  it('sends a Japanese draft to English when the saved target is Japanese', () => {
    const plan = planComposeTranslation('こんにちは、会議は明日です。', 'ja');
    expect(plan.targetLanguage).toBe('en');
    expect(plan.sourceLanguage).toBe('ja');
    expect(plan.other).toBe('ja');
    expect(plan.ok).toBe(true);
  });

  it('sends a Japanese draft to the saved target when that target is not Japanese', () => {
    const plan = planComposeTranslation('よろしくお願いします。', 'en');
    expect(plan.targetLanguage).toBe('en');
    expect(plan.other).toBe('ja');
  });

  it('sends a Latin draft to Japanese when the saved target is Japanese', () => {
    const plan = planComposeTranslation('See you tomorrow.', 'ja');
    expect(plan.targetLanguage).toBe('ja');
    expect(plan.other).toBe('en');
  });

  it('does not send a Latin draft to Japanese just because the saved target is English', () => {
    const english = planComposeTranslation('See you tomorrow.', 'en');
    expect(english.targetLanguage).toBe('en');
    const german = planComposeTranslation('Guten Morgen, wir treffen uns morgen.', 'en');
    expect(german.targetLanguage).toBe('en');
    expect(draftLooksLikeTarget('See you tomorrow.', 'en')).toBe(false);
    expect(draftLooksLikeTarget('Guten Morgen, wir treffen uns morgen.', 'en')).toBe(false);
    expect(draftLooksLikeTarget('こんにちは', 'ja')).toBe(true);
  });

  it('does not treat a few kanji inside an English sentence as Japanese', () => {
    expect(draftLooksLikeTarget('By the Edo period, 大坂 was the city.', 'en')).toBe(false);
    const plan = planComposeTranslation('By the Edo period, 大坂 was the city.', 'en');
    expect(plan.targetLanguage).toBe('en');
  });

  it('inverts the auto choice when the reader swaps', () => {
    const auto = planComposeTranslation('こんにちは', 'ja', false);
    const swapped = planComposeTranslation('こんにちは', 'ja', true);
    expect(auto.targetLanguage).toBe('en');
    expect(swapped.targetLanguage).toBe('ja');
    expect(swapped.other).toBe('en');
  });

  it('keeps the other half of the pair as Japanese for a non-Japanese target', () => {
    expect(composePairOther('de', 'de')).toBe('ja');
    expect(composePairOther('ja', 'de')).toBe('de');
    expect(composePairOther('ja', 'ja')).toBe('en');
  });

  it('refuses a Chrome-only target instead of handing the draft to another engine', () => {
    const plan = planComposeTranslation('こんにちは', 'pt');
    expect(plan.targetLanguage).toBe('pt');
    expect(plan.ok).toBe(false);
  });

  it('keeps an explicit target instead of flipping a Japanese draft', () => {
    const auto = planComposeTranslation('こんにちは', 'ja');
    const explicit = planComposeTranslation('こんにちは', 'ja', false, true);
    expect(auto.targetLanguage).toBe('en');
    expect(explicit.targetLanguage).toBe('ja');
    expect(planComposeTranslation('See you tomorrow.', 'ko', false, true).targetLanguage).toBe(
      'ko',
    );
  });
});
