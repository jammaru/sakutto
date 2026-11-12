import { describe, expect, it } from 'vitest';
import { groupLines } from '@/pdf/lines';
import { layoutPage } from '@/pdf/layout';
import { protectInlineMath, restoreInlineMath } from '@/pdf/protect';
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

  it('refuses a translation that dropped a placeholder', () => {
    expect(restoreInlineMath('クエリとキー', ['q', 'k'])).toBeNull();
    expect(restoreInlineMath('クエリ <i0> だけ', ['q', 'k'])).toBeNull();
    expect(restoreInlineMath('クエリ <i0> <i9>', ['q'])).toBeNull();
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
