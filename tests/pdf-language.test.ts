import { describe, expect, it } from 'vitest';
import { isSameLanguage, pdfBlockLanguage } from '@/pdf/language';

describe('pdf language', () => {
  it('treats English prose as English and skips it when the target is English', () => {
    const text = 'The collector walks the document rather than selecting tags on this page.';
    expect(pdfBlockLanguage(text)).toBe('en');
    expect(isSameLanguage(text, 'en', null)).toBe(true);
    expect(isSameLanguage(text, 'ja', null)).toBe(false);
  });

  it('uses the page language for a short label that has no words of its own', () => {
    expect(isSameLanguage('Abstract', 'en', 'en')).toBe(true);
    expect(isSameLanguage('Abstract', 'ja', 'en')).toBe(false);
  });
});
