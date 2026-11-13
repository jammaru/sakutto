import { describe, expect, it } from 'vitest';
import { isSameLanguage, pdfBlockLanguage, pdfPageLanguage } from '@/pdf/language';
import type { LayoutBlock } from '@/pdf/layout';

function block(role: LayoutBlock['role'], text: string): LayoutBlock {
  return {
    box: { x: 0, y: 0, width: 100, height: 12 },
    room: { x: 0, y: 0, width: 100, height: 12 },
    lines: [],
    text,
    role,
    fontSize: 10,
    lineHeight: 1.2,
    align: 'left',
    bold: false,
    italic: false,
    column: 0,
    advance: 100,
    writing: 0,
  };
}

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

  it('does not treat Latin body as Japanese because a running header is Japanese', () => {
    const body =
      'Methodological evaluation uses cyclomatic complexity metrics across sampled modules.';
    expect(pdfBlockLanguage(body)).toBeNull();
    expect(isSameLanguage(body, 'ja', 'ja')).toBe(false);
    expect(
      pdfPageLanguage([
        block('heading', '5. 結論と今後の課題について述べる。'),
        block(
          'prose',
          'The collector walks the document rather than selecting tags on this page and keeps every paragraph.',
        ),
      ]),
    ).toBe('en');
  });
});
