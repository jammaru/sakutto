import { describe, expect, it } from 'vitest';
import { isEquation, layoutPage } from '@/pdf/layout';
import { groupLines, lineFrom } from '@/pdf/lines';
import { placePage } from '@/pdf/place';
import { stubExpand } from '@/pdf/stub';
import { measure, piece } from './support/pdf-pieces';

describe('math layout and equation fragment handling (#171)', () => {
  it('rejoins a footnote line split around a tall inline summation operator', () => {
    // Synthetic page-bottom note: the text row is interrupted by a tall summation
    // and its superscript/subscript fragments, which sit off the text baseline.
    const pieces = [
      piece(
        '3 In a toy model, suppose the entries of two sampled vectors are independent draws',
        130,
        710,
        383,
        { em: 9 },
      ),
      piece('with zero mean and variance one; their dot product, s · t =', 117, 725, 248, {
        em: 9,
      }),
      piece('P', 368, 719, 10, { em: 9, math: true }),
      piece('d', 378, 721, 4, { em: 6, math: true }),
      piece('k', 382, 722, 4, { em: 5, math: true }),
      piece('i', 378, 728, 3, { em: 6, math: true }),
      piece('=1', 381, 728, 9, { em: 6 }),
      piece('s_i t_i keeps zero mean and variance d_k.', 392, 725, 121, { em: 9 }),
    ];

    const lines = groupLines(pieces);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.text).toContain('s · t =');
    expect(lines[1]?.text).toContain('zero mean and variance');

    const layout = layoutPage(lines, undefined, { width: 612, height: 792 });
    expect(layout.blocks).toHaveLength(1);
    const placed = placePage({
      layout,
      translationOf: (block) => stubExpand(block.text),
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 792,
      pageWidth: 612,
    });
    expect(placed[0]?.paint).toBe(true);
    expect(placed[0]?.overflow).toBe(false);
  });

  it('keeps a superscript-numbered footnote separate and left-aligned below an unfinished body line', () => {
    const pieces = [
      piece(
        'For each sampled batch we feed the normalized scores through the gating',
        117,
        695,
        396,
        { em: 10 },
      ),
      piece('3', 130, 710, 3, { em: 6 }),
      piece(
        'In a toy model, suppose the entries of two sampled vectors are independent draws',
        133,
        714,
        380,
        { em: 9 },
      ),
      piece('with zero mean and variance one; their dot product, s · t =', 117, 725, 248, {
        em: 9,
      }),
      piece('P', 368, 719, 10, { em: 9, math: true }),
      piece('d', 378, 721, 4, { em: 6, math: true }),
      piece('k', 382, 722, 4, { em: 5, math: true }),
      piece('i', 378, 728, 3, { em: 6, math: true }),
      piece('=1', 381, 728, 9, { em: 6 }),
      piece('s_i t_i keeps zero mean and variance d_k.', 392, 725, 121, { em: 9 }),
    ];

    const lines = groupLines(pieces);
    expect(lines).toHaveLength(3);

    const layout = layoutPage(lines, undefined, { width: 612, height: 792 });
    expect(layout.blocks).toHaveLength(2);
    expect(layout.blocks[0]?.align).toBe('left');
    expect(layout.blocks[1]?.align).toBe('left');
    expect(layout.blocks[1]?.text).toContain('In a toy model');
    expect(layout.blocks[1]?.text).toContain('zero mean and variance');

    const placed = placePage({
      layout,
      translationOf: (block) => stubExpand(block.text),
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 792,
      pageWidth: 612,
    });
    expect(placed.every((item) => item.paint && !item.overflow)).toBe(true);
  });

  it('treats Unicode Mathematical Alphanumeric Symbols as math characters in equation detection', () => {
    const unicodeMathLine = lineFrom([piece('𝐹1𝑐 .', 330, 250, 17, { em: 10 })]);
    expect(unicodeMathLine.mathRatio).toBeGreaterThanOrEqual(0.4);
    expect(unicodeMathLine.proseChars).toBe(0);
    expect(isEquation([unicodeMathLine], 70)).toBe(true);

    const pureUnicodeEq = lineFrom([
      piece('𝜋 ∧ = ((pr𝑋, 𝜋(𝑌 | 𝑋)) ◦ (id𝑆, 𝜋𝑋)) ∧', 120, 300, 220, { em: 10 }),
    ]);
    expect(isEquation([pureUnicodeEq], 70)).toBe(true);
  });

  it('absorbs tiny \\text{...} subscript fragments beside a display equation without skipping prose', () => {
    const pieces = [
      piece(
        'For each trial we record the operation count F and the parameter total N, then compute a normalized sparsity score:',
        70,
        410,
        470,
        { em: 10 },
      ),
      // Left side of the display expression: N with small "act" and "eq" annotations
      piece('N', 233, 448, 8, { em: 10, math: true }),
      piece('act', 241, 450, 10, { em: 7 }),
      piece('=', 255, 448, 8, { em: 10 }),
      piece('eq', 241, 442, 8, { em: 7 }),
      // Confirmed expression body beside it
      piece('N0,', 285, 448, 16, { em: 10, math: true }),
      piece('S = 1 −', 318, 448, 34, { em: 10, math: true }),
      // Companion fragment carrying the same annotations
      piece('N', 356, 441, 8, { em: 10, math: true }),
      piece('act', 364, 443, 10, { em: 7 }),
      piece('eq', 364, 435, 8, { em: 7 }),
      // Following body prose
      piece(
        'This score rescales the usable parameter count by the operation ratio measured in each trial.',
        70,
        480,
        470,
        { em: 10 },
      ),
    ];
    const lines = groupLines(pieces);
    const layout = layoutPage(lines, undefined, { width: 612, height: 792 });

    expect(layout.blocks.map((block) => block.role)).toEqual(['prose', 'prose']);
    expect(layout.blocks.some((block) => block.text.includes('act'))).toBe(false);
    expect(layout.skipped.some((block) => block.role === 'equation')).toBe(true);
  });
});
