import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: {
    i18n: {
      getMessage: () => '',
    },
  },
}));

const { displayTargetLanguage } = await import('@/ui/language-label');

describe('target language labels', () => {
  it('uses the catalog name for Easy Japanese instead of its raw tag', () => {
    expect(displayTargetLanguage('ja-easy', 'en')).toBe('Easy Japanese (PLaMo)');
    expect(displayTargetLanguage('ja-easy', 'en')).not.toBe('ja-easy');
  });

  it('keeps the existing display names for ordinary targets', () => {
    expect(displayTargetLanguage('en', 'ja')).toBe('英語');
    expect(displayTargetLanguage('not-a-language', 'en')).toBe('not-a-language');
  });
});
