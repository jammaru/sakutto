import { describe, expect, it } from 'vitest';
import { groupLines } from '@/pdf/lines';
import { layoutPage } from '@/pdf/layout';
import { protectInlineMath, restoreInlineMath, shouldSkipInlineMath } from '@/pdf/protect';
import { piece } from './support/pdf-pieces';

describe('protectInlineMath', () => {
  it('replaces a mixed sentence’s variables with placeholders and restores them', () => {
    const lines = groupLines([
      piece('with query and key vectors ', 49, 100, 120),
      piece('q', 170, 100, 6, { math: true, italic: true }),
      piece(', ', 176, 100, 4),
      piece('k', 180, 100, 6, { math: true, italic: true }),
      piece(' and value vectors ', 186, 100, 90),
      piece('v', 278, 100, 6, { math: true, italic: true }),
      piece(', plus a recurrent state.', 284, 100, 100),
    ]);
    const layout = layoutPage(lines);
    expect(layout.blocks).toHaveLength(1);
    const block = layout.blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toEqual(['q, k', 'v']);
    expect(protectedText.text).toContain('<i0>');
    expect(protectedText.text).toContain('<i1>');
    expect(protectedText.text).not.toMatch(/(?<!<i0>)\bq\b/u);

    const restored = restoreInlineMath(
      'クエリ <i0> および値ベクトル <i1>、加えて状態。',
      protectedText.slots,
    );
    expect(restored).toBe('クエリ q, k および値ベクトル v、加えて状態。');
  });

  it('keeps the source spaces around a replaced variable', () => {
    const lines = groupLines([
      piece('the', 40, 100, 16),
      piece('vector', 60, 100, 32),
      piece('q', 96, 100, 6, { math: true, italic: true }),
      piece('that', 106, 100, 22),
    ]);
    const layout = layoutPage(lines);
    const block = layout.blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.text).toContain('vector <i0> that');
    expect(protectedText.text).not.toContain('vector<i0>that');
  });

  it('allows reordering placeholders and refuses drop, duplicate, invent, and malformed tags', () => {
    expect(restoreInlineMath('値 <i1> とクエリ <i0>', ['q', 'k'])).toBe('値 k とクエリ q');
    expect(restoreInlineMath('クエリとキー', ['q', 'k'])).toBeNull();
    expect(restoreInlineMath('クエリ <i0> だけ', ['q', 'k'])).toBeNull();
    expect(restoreInlineMath('クエリ <i0> <i0>', ['q', 'k'])).toBeNull();
    expect(restoreInlineMath('クエリ <i0> <i1> <i0>', ['q', 'k'])).toBeNull();
    expect(restoreInlineMath('クエリ <i0> <i1> <i2>', ['q', 'k'])).toBeNull();
    expect(restoreInlineMath('クエリ <i0> <i9>', ['q'])).toBeNull();
    expect(restoreInlineMath('クエリ <ix> <i1>', ['q', 'k'])).toBeNull();
  });

  it('protects a subscript that is set smaller than the line', () => {
    const lines = groupLines([
      piece('Let ', 49, 100, 18),
      piece('S', 67, 100, 8, { italic: true }),
      piece('t', 74, 100, 6, { size: 7, em: 10 }),
      piece(' = (I − β)', 80, 100, 48),
      piece('k', 128, 100, 6, { italic: true }),
      piece(' hold the recurrent state of the layer.', 134, 100, 200),
    ]);
    const layout = layoutPage(lines);
    const block = layout.blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots.length).toBeGreaterThan(0);
    expect(protectedText.text).toContain('<i0>');
    expect(protectedText.slots.some((slot) => slot.includes('t'))).toBe(true);
  });

  it('skips a sentence that is mostly inline mathematics', () => {
    const lines = groupLines([
      piece('where ', 49, 100, 30),
      piece('S', 80, 100, 8, { math: true, italic: true }),
      piece('t', 88, 100, 6, { math: true, size: 7, em: 10 }),
      piece(' = (I − ', 94, 100, 36, { math: true }),
      piece('β', 130, 100, 8, { math: true }),
      piece('t', 138, 100, 6, { math: true, size: 7, em: 10 }),
      piece(') ', 144, 100, 8, { math: true }),
      piece('k', 152, 100, 6, { math: true, italic: true }),
      piece(' Diag(', 158, 100, 28, { math: true }),
      piece('α', 186, 100, 8, { math: true }),
      piece('t', 194, 100, 6, { math: true, size: 7, em: 10 }),
      piece(') ', 200, 100, 8, { math: true }),
      piece('S', 208, 100, 8, { math: true, italic: true }),
      piece('t−1', 216, 100, 16, { math: true, size: 7, em: 10 }),
      piece('.', 232, 100, 4),
    ]);
    const layout = layoutPage(lines);
    const block = layout.blocks[0] ?? layout.skipped[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(shouldSkipInlineMath(protectedText, block.text)).toBe(true);
  });

  it('does not protect a hyphen inside a word as inline mathematics', () => {
    const lines = groupLines([
      piece('Additionally, we used F', 40, 100, 120),
      piece('-', 160, 100, 4),
      piece('score as one of the evaluation', 164, 100, 200),
    ]);
    const layout = layoutPage(lines);
    const block = layout.blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toEqual([]);
    expect(protectedText.text).toContain('F-score');
  });

  it('does not protect an ordinal suffix as a subscript', () => {
    const lines = groupLines([
      piece('Table 3. Selection at the 150', 40, 100, 140),
      piece('th', 180, 98, 8, { size: 6 }),
      piece(' iteration', 188, 100, 40),
    ]);
    const layout = layoutPage(lines);
    const block = layout.blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toEqual([]);
    expect(protectedText.text).toContain('150th');
  });

  it('does not protect sentence punctuation as inline mathematics', () => {
    const lines = groupLines([
      piece('Table 3', 40, 100, 50),
      piece('.', 90, 100, 3),
      piece(' Percentage of the selected configuration', 93, 100, 220),
    ]);
    const layout = layoutPage(lines);
    const block = layout.blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toEqual([]);
    expect(protectedText.text).toContain('Table 3.');
  });

  it('leaves a sentence with no mathematics unchanged', () => {
    const lines = groupLines([
      piece('The collector walks the document rather than selecting tags.', 40, 100, 400),
    ]);
    const layout = layoutPage(lines);
    const block = layout.blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toEqual([]);
    expect(protectedText.text).toBe(block.text);
  });
});
