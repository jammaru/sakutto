import { describe, expect, it } from 'vitest';
import { isEquation, layoutPage } from '@/pdf/layout';
import { groupLines, lineFrom } from '@/pdf/lines';
import { placePage } from '@/pdf/place';
import { stubExpand } from '@/pdf/stub';
import { measure, piece } from './support/pdf-pieces';

describe('math layout and equation fragment handling (#171)', () => {
  it('rejoins a footnote line split around a tall inline summation operator', () => {
    // Mirrors Attention Is All You Need p.4 footnote 4:
    // Line 1: "... independent random"
    // Line 2: "variables with mean 0 ... q · k =" + tall ∑^{d_k} + "i=1 q_i k_i, has mean 0 ..."
    const pieces = [
      piece(
        '4 To illustrate why the dot products get large, assume that the components are independent random',
        121,
        704.8,
        383,
        { em: 9 },
      ),
      piece(
        'variables with mean 0 and variance 1. Then their dot product, q · k =',
        108,
        720.0,
        248,
        {
          em: 9,
        },
      ),
      piece('P', 358.9, 713.3, 9.7, { em: 9, math: true }),
      piece('d', 368.6, 715.8, 3.8, { em: 6, math: true }),
      piece('k', 372.4, 717.2, 3.8, { em: 5, math: true }),
      piece('i', 368.6, 722.8, 2.7, { em: 6, math: true }),
      piece('=1', 371.2, 722.8, 9.2, { em: 6 }),
      piece('q_i k_i, has mean 0 and variance d_k.', 382.5, 720.0, 121, { em: 9 }),
    ];

    const lines = groupLines(pieces);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.text).toContain('q · k =');
    expect(lines[1]?.text).toContain('has mean 0 and variance');

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
        'On each of these projected versions of queries, keys and values we then perform the attention',
        108,
        689.8,
        396,
        { em: 10 },
      ),
      piece('4', 120.7, 704.8, 3.0, { em: 6 }),
      piece(
        'To illustrate why the dot products get large, assume that the components are independent random',
        123.7,
        708.6,
        380.3,
        { em: 9 },
      ),
      piece(
        'variables with mean 0 and variance 1. Then their dot product, q · k =',
        108,
        720.0,
        248,
        { em: 9 },
      ),
      piece('P', 358.9, 713.3, 9.7, { em: 9, math: true }),
      piece('d', 368.6, 715.8, 3.8, { em: 6, math: true }),
      piece('k', 372.4, 717.2, 3.8, { em: 5, math: true }),
      piece('i', 368.6, 722.8, 2.7, { em: 6, math: true }),
      piece('=1', 371.2, 722.8, 9.2, { em: 6 }),
      piece('q_i k_i, has mean 0 and variance d_k.', 382.5, 720.0, 121, { em: 9 }),
    ];

    const lines = groupLines(pieces);
    expect(lines).toHaveLength(3);

    const layout = layoutPage(lines, undefined, { width: 612, height: 792 });
    expect(layout.blocks).toHaveLength(2);
    expect(layout.blocks[0]?.align).toBe('left');
    expect(layout.blocks[1]?.align).toBe('left');
    expect(layout.blocks[1]?.text).toContain('To illustrate why');
    expect(layout.blocks[1]?.text).toContain('has mean 0 and variance');

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
        'For any configuration with FLOPs F and total parameters N, we define the equivalent sparsity as:',
        70,
        410,
        470,
        { em: 10 },
      ),
      // Left side of display equation: N_{\text{act}}^{\text{eq}} =
      piece('N', 233, 448, 8, { em: 10, math: true }),
      piece('act', 241, 450, 10, { em: 7 }),
      piece('=', 255, 448, 8, { em: 10 }),
      piece('eq', 241, 442, 8, { em: 7 }),
      // Confirmed equation body beside it
      piece('N0,', 285, 448, 16, { em: 10, math: true }),
      piece('S = 1 −', 318, 448, 34, { em: 10, math: true }),
      // Right side fragment: N_{\text{act}}^{\text{eq}}
      piece('N', 356, 441, 8, { em: 10, math: true }),
      piece('act', 364, 443, 10, { em: 7 }),
      piece('eq', 364, 435, 8, { em: 7 }),
      // Following body prose
      piece(
        'This metric scales the control parameter count by the FLOPs ratio across every configuration.',
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
