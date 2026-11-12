import { describe, expect, it } from 'vitest';
import { fitText, growBudgetFor, wrapText } from '@/pdf/fit';
import type { Box } from '@/pdf/geometry';

/** A monospace-ish measure: one character is `size * 0.5` wide. */
function measure(text: string, size: number): number {
  return text.length * size * 0.5;
}

function box(x: number, y: number, width: number, height: number): Box {
  return { x, y, width, height };
}

describe('wrapText', () => {
  it('breaks Latin text at word boundaries', () => {
    const lines = wrapText('the quick brown fox jumps', 78, (value) => measure(value, 10));
    expect(lines).toEqual(['the quick brown', 'fox jumps']);
    expect(lines.join(' ')).toBe('the quick brown fox jumps');
  });

  it('breaks Japanese text between characters', () => {
    const lines = wrapText('高速な翻訳を提供する小さなモデルです', 50, (value) =>
      measure(value, 10),
    );
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measure(line, 10)).toBeLessThanOrEqual(50);
    expect(lines.join('')).toBe('高速な翻訳を提供する小さなモデルです');
  });

  it('does not start a Japanese line with a closing mark', () => {
    const lines = wrapText('です。次は本文', 20, (value) => measure(value, 10), true);
    expect(lines.join('')).toBe('です。次は本文');
    expect(lines.some((line) => line.startsWith('。'))).toBe(false);
    expect(lines[0]?.includes('。')).toBe(true);
  });

  it('never puts 。 at the start of a line, even in a column narrower than the mark', () => {
    const lines = wrapText('です。次は本文', 10, (value) => measure(value, 10), true);
    expect(lines.join('')).toBe('です。次は本文');
    expect(lines.some((line) => line.startsWith('。'))).toBe(false);
  });

  it('keeps a URL unbroken when it fits', () => {
    const url = 'https://example.org/a/b';
    const lines = wrapText(`see ${url} now`, 200, (value) => measure(value, 10));
    expect(lines).toEqual([`see ${url} now`]);
  });

  it('breaks one token wider than the column rather than overflowing', () => {
    const lines = wrapText('abcdefghijklmnop', 40, (value) => measure(value, 10));
    for (const line of lines) expect(measure(line, 10)).toBeLessThanOrEqual(40);
    expect(lines.join('')).toBe('abcdefghijklmnop');
  });

  it('width-checks a token that starts a new line, including narrow columns', () => {
    for (const width of [8, 12, 20, 40]) {
      const lines = wrapText('aa bbbbbbbbbbbbb cccc', width, (value) => measure(value, 10));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.length).toBeGreaterThan(0);
        expect(measure(line, 10)).toBeLessThanOrEqual(width);
      }
      expect(lines.join('').replace(/\s+/g, '')).toBe('aabbbbbbbbbbbbbcccc');
    }
  });
});

function expectLinesFit(lines: readonly string[], width: number, size: number): void {
  for (const line of lines) {
    expect(line.length).toBeGreaterThan(0);
    expect(measure(line, size)).toBeLessThanOrEqual(width);
  }
}

describe('fitText', () => {
  it('keeps the source size when the translation is short', () => {
    const result = fitText(
      {
        box: box(0, 0, 200, 40),
        growBudget: 40,
        fontSize: 10,
        lineHeight: 1.4,
        width: 200,
        measure,
      },
      'short text',
      'en',
    );
    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.fontSize).toBe(10);
    expect(result.lines).toHaveLength(1);
    expect(result.grown).toBe(false);
    expect(result.width).toBe(200);
    expectLinesFit(result.lines, 200, result.fontSize);
  });

  it('records the wrap width the layout fitted against', () => {
    const result = fitText(
      {
        box: box(0, 0, 100, 40),
        growBudget: 20,
        fontSize: 10,
        lineHeight: 1.2,
        width: 128,
        measure,
      },
      '短い訳',
      'ja',
    );
    expect(result.width).toBe(128);
  });

  it('shrinks a translation that would overflow, but never below the floor', () => {
    const text = 'a rather long translation that needs several lines of room to fit at all';
    const result = fitText(
      {
        box: box(0, 0, 120, 30),
        growBudget: 0,
        fontSize: 10,
        lineHeight: 1.3,
        width: 120,
        measure,
      },
      text,
      'en',
    );
    expect(result.fontSize).toBeLessThan(10);
    expect(result.fontSize).toBeGreaterThanOrEqual(10 * 0.72 - 1e-9);
    expectLinesFit(result.lines, 120, result.fontSize);
  });

  it('uses room below before shrinking', () => {
    const text = 'a translation that needs about two lines';
    const tight = fitText(
      {
        box: box(0, 0, 150, 16),
        growBudget: 0,
        fontSize: 10,
        lineHeight: 1.4,
        width: 150,
        measure,
      },
      text,
      'en',
    );
    const roomy = fitText(
      {
        box: box(0, 0, 150, 16),
        growBudget: 40,
        fontSize: 10,
        lineHeight: 1.4,
        width: 150,
        measure,
      },
      text,
      'en',
    );
    expect(roomy.fontSize).toBeGreaterThan(tight.fontSize);
    if (roomy.fits) expect(roomy.grown).toBe(true);
  });

  it('reports what has to be clipped when nothing fits', () => {
    const text = 'x'.repeat(400);
    const result = fitText(
      { box: box(0, 0, 60, 14), growBudget: 0, fontSize: 10, lineHeight: 1.4, width: 60, measure },
      text,
      'en',
    );
    expect(result.fits).toBe(false);
    if (result.fits) return;
    expect(result.visibleLines.length).toBeGreaterThan(0);
    expect(result.visibleLines.length).toBeLessThan(result.lines.length);
  });

  it('gives Japanese a floor on leading, and keeps a source that was already generous', () => {
    const text = 'これは翻訳された文章です';
    const tight = {
      box: box(0, 0, 400, 60),
      growBudget: 0,
      fontSize: 10,
      // The leading a paper sets for Latin text: tight for a Gothic Japanese face.
      lineHeight: 1.2,
      width: 400,
      measure,
    };
    const ja = fitText(tight, text, 'ja');
    const en = fitText(tight, text, 'en');
    if (!ja.fits || !en.fits) throw new Error('expected both to fit');
    expect(ja.lineHeight / ja.fontSize).toBeGreaterThan(en.lineHeight / en.fontSize);

    // A source that already set generous leading is not squeezed back down to the floor.
    const loose = { ...tight, lineHeight: 1.6 };
    const jaLoose = fitText(loose, text, 'ja');
    if (!jaLoose.fits) throw new Error('expected the loose case to fit');
    expect(jaLoose.lineHeight / jaLoose.fontSize).toBeCloseTo(1.6, 5);
  });

  it('fits a one-line Japanese label in a tight Latin box', () => {
    const cjkMeasure = (text: string, size: number): number => {
      let cjk = 0;
      for (const character of text) {
        if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)) cjk += 1;
      }
      return cjk * size + (text.length - cjk) * size * 0.5;
    };
    const result = fitText(
      {
        box: box(0, 0, 80, 8),
        growBudget: 0,
        fontSize: 8,
        lineHeight: 1.15,
        width: 80,
        measure: cjkMeasure,
      },
      'これは訳',
      'ja',
    );
    expect(result.fits).toBe(true);
    expect(result.fontSize).toBeGreaterThanOrEqual(6.5 - 1e-9);
  });

  it('lets a 9pt body paragraph shrink to 6pt when that is what fits', () => {
    const text = 'x'.repeat(80);
    const result = fitText(
      {
        box: box(0, 0, 90, 12),
        growBudget: 0,
        fontSize: 9,
        lineHeight: 1.2,
        width: 90,
        measure,
        role: 'prose',
      },
      text,
      'en',
    );
    expect(result.fontSize).toBeGreaterThanOrEqual(6 - 1e-9);
    expect(result.fontSize).toBeLessThan(6.5);
    for (const line of result.lines) expect(measure(line, result.fontSize)).toBeLessThanOrEqual(90);
  });

  it('grows a last one-line paragraph by at least one Japanese line when the page has room', () => {
    const cjkMeasure = (text: string, size: number): number => {
      let cjk = 0;
      for (const character of text) {
        if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)) cjk += 1;
      }
      return cjk * size + (text.length - cjk) * size * 0.5;
    };
    const text = 'これは翻訳された文章ですレイアウトを測るための長い一段落';
    const result = fitText(
      {
        box: box(0, 0, 120, 8),
        growBudget: 40,
        fontSize: 8,
        lineHeight: 1.15,
        width: 120,
        measure: cjkMeasure,
      },
      text,
      'ja',
    );
    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.grown).toBe(true);
    expect(result.lines.length).toBeGreaterThan(1);
  });
});

describe('growBudgetFor', () => {
  it('returns the gap to the next box in the same column, less a clearance', () => {
    const block = box(0, 100, 200, 40);
    const below = [box(0, 160, 200, 20), box(300, 110, 200, 200)];
    // The gap is 20 points; two points are kept clear so the boxes do not touch.
    expect(growBudgetFor(block, below, 220)).toBe(18);
  });

  it('ignores a box in another column', () => {
    const block = box(0, 100, 200, 40);
    const below = [box(240, 105, 200, 200)];
    expect(growBudgetFor(block, below, 220)).toBe(120);
  });

  it('does not zero growth for a figure that only sits beside the block', () => {
    const block = box(0, 100, 200, 40);
    const beside = [box(210, 80, 80, 200)];
    expect(growBudgetFor(block, beside, 300)).toBe(120);
  });
});
