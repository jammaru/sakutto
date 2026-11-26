import { describe, expect, it } from 'vitest';
import { groupLines } from '@/pdf/lines';
import { layoutPage } from '@/pdf/layout';
import { protectInlineMath, restoreInlineMath, shouldSkipInlineMath } from '@/pdf/protect';
import { piece } from './support/pdf-pieces';

/** A placeholder must stand for whole notation, never for half of an ordinary word. */
function expectSourcePreserved(
  protectedText: { text: string; slots: { text: string }[] },
  source: string,
): void {
  const original = protectedText.text.replace(/<i(\d+)>/gu, (match, index: string) => {
    return protectedText.slots[Number(index)]?.text ?? match;
  });
  expect(original).toBe(source);
}

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
    expect(protectedText.slots.map((slot) => slot.text)).toEqual(['q, k', 'v']);
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
      piece('t', 74, 101.2, 6, { size: 7, em: 10 }),
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
    expect(protectedText.slots.some((slot) => slot.text.includes('t'))).toBe(true);
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

  it('does not mistake a long word on a shifted line for a superscript', () => {
    const lines = groupLines([
      piece(
        'The dominant sequence transduction models are based on complex recurrent',
        49,
        100,
        420,
      ),
      piece('Experiments on two machine translation tasks show these models to', 38, 100, 360),
      piece('be superior in quality while being more parallelizable and requiring', 27, 100, 360),
    ]);
    const layout = layoutPage(lines);
    const block = layout.blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toEqual([]);
    expect(protectedText.text).toBe(block.text);
  });

  it('protects notation set in an ordinary text face and restores fullwidth tags', () => {
    const source = 'Where the projections are matrices Q ∈ R d model × d k and W O ∈ R h×d .';
    const lines = groupLines([piece(source, 49, 100, 430)]);
    const layout = layoutPage(lines);
    const block = layout.blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.text).toContain('<i0>');
    expect(protectedText.slots.some((slot) => slot.text.includes('∈'))).toBe(true);
    expectSourcePreserved(protectedText, source);
    // No slot may begin or end in the middle of a prose word.
    expect(protectedText.text).not.toMatch(/matrice<i|mode<i|d W O|an<i/u);
    expect(protectedText.slots.map((slot) => slot.text)).not.toContain('s Q ∈ R');
    const tags = protectedText.slots.map((_slot, index) => `＜i${String(index)}＞`).join('');
    const restored = restoreInlineMath(`射影は ${tags} である。`, protectedText.slots);
    expect(restored).not.toBeNull();
    expect(restored).toContain('∈');
    expect(restored).not.toContain('<i0>');
  });

  it('translates leading prose instead of protecting it with the formula', () => {
    const cases = [
      { source: 'Let A ∈ R n×n be an invertible matrix.', lead: 'Let ', word: 'Let' },
      { source: 'For x ∈ R n we define f(x).', lead: 'For ', word: 'For' },
      { source: 'If x ∈ R n then f(x) ∈ R m.', lead: 'If ', word: 'If' },
      { source: 'This is a 3 × 3 kernel.', lead: 'This is a ', word: 'a' },
      { source: 'A 3 × 3 kernel is used.', lead: 'A ', word: 'A' },
    ];
    for (const { source, lead, word } of cases) {
      const lines = groupLines([piece(source, 49, 100, 430)]);
      const block = layoutPage(lines).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(protectedText.text.startsWith(lead), source).toBe(true);
      expect(protectedText.slots.length, source).toBeGreaterThan(0);
      for (const slot of protectedText.slots) {
        expect(slot.text.startsWith(word + ' '), source).toBe(false);
        expect(slot.text.startsWith(lead), source).toBe(false);
      }
      expectSourcePreserved(protectedText, source);
      // The model sees the prose, so a normal Japanese response restores only the notation.
      const tags = protectedText.slots.map((_slot, index) => `<i${String(index)}>`).join('');
      expect(restoreInlineMath('訳文 ' + tags + ' です。', protectedText.slots)).not.toBeNull();
    }
  });

  it('leaves an ordinary sentence containing a multiplication sign untouched', () => {
    const source = 'This is a 10× speedup over the baseline.';
    const lines = groupLines([piece(source, 49, 100, 300)]);
    const block = layoutPage(lines).blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toEqual([]);
    expect(protectedText.text).toBe(source);
  });

  it('does not swallow the word before a numeric expression', () => {
    const source = 'We used 3 × 3 convolutions and a batch size of 32.';
    const lines = groupLines([piece(source, 49, 100, 320)]);
    const block = layoutPage(lines).blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.text).toContain('We used ');
    expect(protectedText.slots).not.toContainEqual({ text: 'd 3 × 3', script: 'none' });
    expectSourcePreserved(protectedText, source);
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

describe('latest review notation blockers', () => {
  it('B6: leaves prepositions after a formula in the prompt', () => {
    const cases = [
      {
        source: 'The projection is Q ∈ R in this paper.',
        slot: 'Q ∈ R',
        prompt: 'The projection is <i0> in this paper.',
      },
      {
        source: 'The vector x ∈ R out of the encoder is reused.',
        slot: 'x ∈ R',
        prompt: 'The vector <i0> out of the encoder is reused.',
      },
    ];
    for (const { source, slot, prompt } of cases) {
      const lines = groupLines([piece(source, 49, 100, 430)]);
      const block = layoutPage(lines).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((entry) => entry.text),
        source,
      ).toContain(slot);
      expect(protectedText.text, source).toBe(prompt);
      expectSourcePreserved(protectedText, source);
    }
  });
});

describe('latest DSH review blockers', () => {
  it('B5: protects the full tail of a chained dimension expression', () => {
    const cases = [
      { source: 'A 3 × 3 × 3 kernel is used.', slot: '3 × 3 × 3' },
      { source: 'A × B × C appears below.', slot: 'A × B × C' },
      { source: 'A 4 × 4 × 4 matrix follows.', slot: '4 × 4 × 4' },
    ];
    for (const { source, slot } of cases) {
      const lines = groupLines([piece(source, 49, 100, 430)]);
      const block = layoutPage(lines).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((entry) => entry.text),
        source,
      ).toContain(slot);
      expect(protectedText.text, source).not.toMatch(/<i\d+>\s*×/u);
      expectSourcePreserved(protectedText, source);
      const tags = protectedText.slots.map((_slot, index) => '<i' + String(index) + '>').join('');
      expect(restoreInlineMath('訳文 ' + tags + ' です。', protectedText.slots)).not.toBeNull();
    }
  });
});

describe('latest DSH review report blockers', () => {
  it('B2: leaves common sentence openers outside the protected notation slot', () => {
    const cases = [
      { source: 'Since Q ∈ R d is fixed, the result follows.', lead: 'Since ' },
      { source: 'Because Q ∈ R d is fixed, it follows.', lead: 'Because ' },
      { source: 'Here Q ∈ R d is fixed.', lead: 'Here ' },
      { source: 'Note Q ∈ R d is fixed.', lead: 'Note ' },
      { source: 'Thus Q ∈ R d is fixed.', lead: 'Thus ' },
    ];
    for (const { source, lead } of cases) {
      const lines = groupLines([piece(source, 49, 100, 430)]);
      const block = layoutPage(lines).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(protectedText.slots, source).toEqual([{ text: 'Q ∈ R d', script: 'none' }]);
      expect(protectedText.text, source).toBe(lead + '<i0> ' + source.slice(lead.length + 8));
      expectSourcePreserved(protectedText, source);
      expect(restoreInlineMath('訳文 <i0> です。', protectedText.slots)).not.toBeNull();
    }
  });
});

describe('review 9166c54: leading prose before notation', () => {
  it('leaves possessive determiners and reference nouns outside the protected slot', () => {
    const notation = '3 × 3';
    const cases = [
      'Our 3 × 3 kernel is used.',
      'Their 3 × 3 kernel is used.',
      'Its 3 × 3 kernel is used.',
      'His 3 × 3 kernel is used.',
      'Her 3 × 3 kernel is used.',
      'Figure 3 × 3 shows the kernel.',
      'Table 3 × 3 lists the kernels.',
      'Section 3 × 3 explains it.',
      'Theorem 3 × 3 is stated below.',
      'Lemma 3 × 3 is proved there.',
      // Determiners and quantifiers are prose too: the model must translate them, not paste
      // them back verbatim from a protected slot (review 0ab8032 blocker 1).
      'Both 3 × 3 convolutions are applied.',
      'All 3 × 3 kernels are applied.',
      'Every 3 × 3 kernel is used.',
      'Two 3 × 3 kernels are stacked.',
      'Several 3 × 3 filters are compared.',
      'Such 3 × 3 kernels are shared.',
      'Each 3 × 3 kernel is used.',
      'Any 3 × 3 kernel works.',
      'Some 3 × 3 kernels are pruned.',
      'Many 3 × 3 filters are used.',
      'Few 3 × 3 matrices remain.',
      'Most 3 × 3 kernels are shared.',
      'Other 3 × 3 filters differ.',
      'Another 3 × 3 kernel is added.',
      'No 3 × 3 kernel is kept.',
      'Not 3 × 3 matrices are kept.',
      'Only 3 × 3 kernels are kept.',
    ];
    for (const source of cases) {
      const lead = source.slice(0, source.indexOf(notation));
      const lines = groupLines([piece(source, 49, 100, 430)]);
      const block = layoutPage(lines).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((slot) => slot.text),
        source,
      ).toEqual([notation]);
      expect(protectedText.text, source).toBe(
        lead + '<i0>' + source.slice(lead.length + notation.length),
      );
      expectSourcePreserved(protectedText, source);
      const tags = protectedText.slots.map((_slot, index) => `<i${String(index)}>`).join('');
      expect(restoreInlineMath('訳文 ' + tags + ' です。', protectedText.slots)).not.toBeNull();
    }

    // The same determiner must stay outside every slot of a multi-expression sentence.
    const source = 'Both 3 × 3 and 5 × 5 filters matter.';
    const lines = groupLines([piece(source, 49, 100, 430)]);
    const block = layoutPage(lines).blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots.map((slot) => slot.text)).toEqual(['3 × 3', '5 × 5']);
    expect(protectedText.text).toBe('Both <i0> and <i1> filters matter.');
    expectSourcePreserved(protectedText, source);
  });
});

describe('review 5 notation and typography', () => {
  it('B4: protects the whole dimension expression and keeps the sentence', () => {
    const source =
      'Where the projections are parameter matrices Wi Q ∈ R d model ×d k , Wi K ∈ R d model ×d k , and W O ∈ R hd v ×d model .';
    const lines = groupLines([piece(source, 49, 100, 430)]);
    const block = layoutPage(lines).blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    // A flattened subscripted identifier stays inside the slot together with the rest of
    // the dimension expression: leaving `Wi` in the prompt lets the model rewrite it.
    expect(protectedText.slots.map((slot) => slot.text)).toContain('Wi Q ∈ R d model ×d k');
    expect(protectedText.text).toContain('parameter matrices <i0>');
    expect(protectedText.text).toContain('parameter matrices ');
    expect(protectedText.text).toContain(', and ');
    expect(protectedText.text).not.toContain('model ×d k');
    expectSourcePreserved(protectedText, source);
    const tags = protectedText.slots.map((_slot, index) => '<i' + String(index) + '>').join('');
    expect(restoreInlineMath('射影は ' + tags + ' である。', protectedText.slots)).not.toBeNull();
  });

  it('does not NFKC-normalize the reader typography when restoring a slot', () => {
    expect(
      restoreInlineMath('モデル（注意）は ＜ｉ０＞ です。① と ㍻ と ｶﾀｶﾅ。', [
        { text: 'Q ∈ R', script: 'none' },
      ]),
    ).toBe('モデル（注意）は Q ∈ R です。① と ㍻ と ｶﾀｶﾅ。');
  });
});

describe('prepositions after a multiplied dimension', () => {
  it('B3: leaves the following preposition outside the protected slot', () => {
    const cases = [
      { source: 'The model is 3 × 3 in this paper.', slot: '3 × 3' },
      { source: 'The projection is Q ∈ R model × d k in this paper.', slot: 'Q ∈ R model × d k' },
      { source: 'A × B in this paper.', slot: 'A × B' },
    ];
    for (const { source, slot } of cases) {
      const lines = groupLines([piece(source, 49, 100, 430)]);
      const block = layoutPage(lines).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((entry) => entry.text),
        source,
      ).toContain(slot);
      expect(
        protectedText.slots.some((entry) => /\bin$/u.test(entry.text)),
        source,
      ).toBe(false);
      expect(protectedText.text, source).toContain('<i0> in ');
      expectSourcePreserved(protectedText, source);
    }
  });
});

describe('current DSH review blockers', () => {
  it('B4: leaves a trailing preposition outside the slot at punctuation or end of text', () => {
    const cases = [
      { source: 'The size is 3 × 3 in.', slot: '3 × 3', prompt: 'The size is <i0> in.' },
      { source: 'The tensor is A × B in.', slot: 'A × B', prompt: 'The tensor is <i0> in.' },
      { source: 'The result is 3 × 3 in', slot: '3 × 3', prompt: 'The result is <i0> in' },
      {
        source: 'The size is 3 × 3, in pixels.',
        slot: '3 × 3',
        prompt: 'The size is <i0>, in pixels.',
      },
    ];
    for (const { source, slot, prompt } of cases) {
      const lines = groupLines([piece(source, 49, 100, 430)]);
      const block = layoutPage(lines).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((entry) => entry.text),
        source,
      ).toContain(slot);
      expect(
        protectedText.slots.some((entry) => /\bin$/u.test(entry.text)),
        source,
      ).toBe(false);
      expect(protectedText.text, source).toBe(prompt);
      expectSourcePreserved(protectedText, source);
    }
  });
});

describe('2053d13 review blocker 1: notation heads instead of a prose whitelist', () => {
  it('keeps ordinary adjectives before a dimension chain in the prompt', () => {
    const cases = [
      'Small 3 × 3 kernels are used.',
      'Large 3 × 3 kernels are used.',
      'Deep 3 × 3 convolutions are used.',
      'More 3 × 3 filters are used.',
      'Fewer 3 × 3 kernels remain.',
      'Double 3 × 3 convolution follows.',
      'Recent 5 × 5 filters are tested.',
    ];
    for (const source of cases) {
      const notation = source.match(/\d+ × \d+/u)?.[0];
      expect(notation, source).toBeDefined();
      const lead = source.slice(0, source.indexOf(notation!));
      const block = layoutPage(groupLines([piece(source, 49, 100, 430)])).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((slot) => slot.text),
        source,
      ).toEqual([notation]);
      expect(protectedText.text, source).toBe(
        lead + '<i0>' + source.slice(lead.length + notation!.length),
      );
      expectSourcePreserved(protectedText, source);
      expect(restoreInlineMath('訳文 <i0> です。', protectedText.slots)).not.toBeNull();
    }
  });

  it('does not protect a chain that starts with an English word', () => {
    for (const source of ['Small × Large matrices differ.', 'Model × Time is tracked.']) {
      const block = layoutPage(groupLines([piece(source, 49, 100, 430)])).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(protectedText.slots, source).toEqual([]);
      expect(protectedText.text, source).toBe(source);
    }
  });

  it('protects chains whose first operand is a clear variable or number', () => {
    const cases = [
      { source: 'Q ∈ R d model × d k is fixed.', slot: 'Q ∈ R d model × d k' },
      { source: 'A × B × C appears below.', slot: 'A × B × C' },
      { source: 'x₁ × 3 denotes the shape.', slot: 'x₁ × 3' },
      { source: 'a ∈ R holds here.', slot: 'a ∈ R' },
      { source: 'a 3 × 3 kernel is used.', slot: '3 × 3' },
    ];
    for (const { source, slot } of cases) {
      const block = layoutPage(groupLines([piece(source, 49, 100, 430)])).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((entry) => entry.text),
        source,
      ).toContain(slot);
      expectSourcePreserved(protectedText, source);
    }
  });
});

describe('402e0bb review blocker 2: flattened multi-letter math identifiers', () => {
  it('keeps Wi inside the slot together with its dimension chain', () => {
    const source = 'Each head uses Wi ∈ R d model × d k for its projection.';
    const block = layoutPage(groupLines([piece(source, 49, 100, 430)])).blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots.map((slot) => slot.text)).toEqual(['Wi ∈ R d model × d k']);
    expect(protectedText.text).toBe('Each head uses <i0> for its projection.');
    expectSourcePreserved(protectedText, source);
    expect(restoreInlineMath('各ヘッドは <i0> を使う。', protectedText.slots)).not.toBeNull();
  });

  it('protects Wq/Wk/Wv identifiers wherever their chain starts', () => {
    const cases = [
      {
        source: 'The projection matrices Wq and Wk satisfy Wq ∈ R d model × d k .',
        slots: ['Wq ∈ R d model × d k'],
      },
      {
        source: 'We denote the weights Wq ∈ R d model and Wk ∈ R d model .',
        slots: ['Wq ∈ R d', 'Wk ∈ R d'],
      },
      {
        source: 'The value matrix Wv ∈ R d model × d v is learned.',
        slots: ['Wv ∈ R d model × d v'],
      },
    ];
    for (const { source, slots } of cases) {
      const block = layoutPage(groupLines([piece(source, 49, 100, 430)])).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((slot) => slot.text),
        source,
      ).toEqual(slots);
      expectSourcePreserved(protectedText, source);
      for (const slot of protectedText.slots) {
        expect(slot.text, source).toMatch(/^W[ qkv]/u);
      }
      const tags = protectedText.slots.map((_slot, index) => '<i' + String(index) + '>').join('');
      expect(restoreInlineMath('訳文 ' + tags + ' です。', protectedText.slots)).not.toBeNull();
    }
  });
});

describe('9a60966 review blockers: two-letter sentence openers', () => {
  const cases = [
    {
      source: 'If Q ∈ R d×d is orthogonal, the result follows.',
      opener: 'If',
      prompt: 'If <i0> is orthogonal, the result follows.',
      slot: 'Q ∈ R d×d',
    },
    {
      source: 'As W ∈ R d model is learned, the loss falls.',
      opener: 'As',
      prompt: 'As <i0> model is learned, the loss falls.',
      slot: 'W ∈ R d',
    },
    {
      source: 'At T ∈ R the value is fixed.',
      opener: 'At',
      prompt: 'At <i0> the value is fixed.',
      slot: 'T ∈ R',
    },
    {
      source: 'In W ∈ R d model the weights are learned.',
      opener: 'In',
      prompt: 'In <i0> model the weights are learned.',
      slot: 'W ∈ R d',
    },
  ];

  it.each(cases)(
    'leaves $opener in the prompt instead of protecting it',
    ({ source, prompt, slot }) => {
      const block = layoutPage(groupLines([piece(source, 49, 100, 430)])).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((entry) => entry.text),
        source,
      ).toEqual([slot]);
      expect(protectedText.text, source).toBe(prompt);
      expect(protectedText.text.startsWith(source.slice(0, 2)), source).toBe(true);
      expectSourcePreserved(protectedText, source);
      expect(restoreInlineMath('訳文 <i0> です。', protectedText.slots)).not.toBeNull();
    },
  );

  it('protects We/In/At directly before an operator as flattened identifiers', () => {
    const cases = [
      {
        source: 'The embedding matrix We ∈ R n×d is learned.',
        prompt: 'The embedding matrix <i0> is learned.',
        slot: 'We ∈ R n×d',
      },
      {
        source: 'In ∈ R n×n is the identity matrix.',
        prompt: '<i0> is the identity matrix.',
        slot: 'In ∈ R n×n',
      },
      {
        source: 'At ∈ R n×d is the attention matrix.',
        prompt: '<i0> is the attention matrix.',
        slot: 'At ∈ R n×d',
      },
    ];
    for (const { source, prompt, slot } of cases) {
      const block = layoutPage(groupLines([piece(source, 49, 100, 430)])).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((entry) => entry.text),
        source,
      ).toEqual([slot]);
      expect(protectedText.text, source).toBe(prompt);
      expectSourcePreserved(protectedText, source);
    }
  });

  it('leaves a non-English opener before an operand in the prompt', () => {
    const cases = [
      {
        source: 'Si Q ∈ R d×d es ortogonal, el resultado se sigue.',
        prompt: 'Si <i0> es ortogonal, el resultado se sigue.',
        slot: 'Q ∈ R d×d',
      },
      {
        source: 'Se W ∈ R d model se aprende durante el entrenamiento.',
        prompt: 'Se <i0> model se aprende durante el entrenamiento.',
        slot: 'W ∈ R d',
      },
    ];
    for (const { source, prompt, slot } of cases) {
      const block = layoutPage(groupLines([piece(source, 49, 100, 430)])).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((entry) => entry.text),
        source,
      ).toEqual([slot]);
      expect(protectedText.text, source).toBe(prompt);
      expectSourcePreserved(protectedText, source);
    }
  });

  it('still protects flattened identifiers with the same two-letter shape', () => {
    const positives = [
      {
        source: 'Each head uses Wi ∈ R d model × d k for its projection.',
        slot: 'Wi ∈ R d model × d k',
      },
      {
        source: 'The value matrix Wv ∈ R d model × d v is learned.',
        slot: 'Wv ∈ R d model × d v',
      },
    ];
    for (const { source, slot } of positives) {
      const block = layoutPage(groupLines([piece(source, 49, 100, 430)])).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((entry) => entry.text),
        source,
      ).toEqual([slot]);
      expect(protectedText.text, source).toContain('<i0>');
      expectSourcePreserved(protectedText, source);
    }
  });
});

describe('ed88d36 review blockers: positional rule for every two-letter token', () => {
  // Position, not a vocabulary list, decides: another operand before the operator means the
  // token is a sentence opener; the operator directly after it means a flattened identifier.
  const openers = [
    {
      token: 'Et',
      source: 'Et Q ∈ R d×d est orthogonal, le résultat suit.',
      prompt: 'Et <i0> est orthogonal, le résultat suit.',
      slot: 'Q ∈ R d×d',
    },
    {
      token: 'Ou',
      source: 'Ou Q ∈ R d×d est orthogonal, le résultat suit.',
      prompt: 'Ou <i0> est orthogonal, le résultat suit.',
      slot: 'Q ∈ R d×d',
    },
    {
      token: 'Ni',
      source: 'Ni Q ∈ R d×d es ortogonal, el resultado se sigue.',
      prompt: 'Ni <i0> es ortogonal, el resultado se sigue.',
      slot: 'Q ∈ R d×d',
    },
    {
      token: 'El',
      source: 'El Q ∈ R d×d es ortogonal, el resultado se sigue.',
      prompt: 'El <i0> es ortogonal, el resultado se sigue.',
      slot: 'Q ∈ R d×d',
    },
    {
      token: 'Wo',
      source: 'Wo Q ∈ R d×d gilt, ist die Matrix symmetrisch.',
      prompt: 'Wo <i0> gilt, ist die Matrix symmetrisch.',
      slot: 'Q ∈ R d×d',
    },
    {
      token: 'Wo',
      source: '(Wo Q ∈ R d×d gilt, ist die Matrix symmetrisch.)',
      prompt: '(Wo <i0> gilt, ist die Matrix symmetrisch.)',
      slot: 'Q ∈ R d×d',
    },
    {
      token: 'Wo',
      source: '• Wo Q ∈ R d×d gilt, ist die Matrix symmetrisch.',
      prompt: '• Wo <i0> gilt, ist die Matrix symmetrisch.',
      slot: 'Q ∈ R d×d',
    },
    {
      token: 'Wo',
      source: '"Wo Q ∈ R d×d gilt, ist die Matrix symmetrisch."',
      prompt: '"Wo <i0> gilt, ist die Matrix symmetrisch."',
      slot: 'Q ∈ R d×d',
    },
    {
      token: 'Wo',
      source: '„Wo Q ∈ R d×d gilt, ist die Matrix symmetrisch.“',
      prompt: '„Wo <i0> gilt, ist die Matrix symmetrisch.“',
      slot: 'Q ∈ R d×d',
    },
    {
      token: 'Wo',
      source: '«Wo Q ∈ R d×d gilt, ist die Matrix symmetrisch.»',
      prompt: '«Wo <i0> gilt, ist die Matrix symmetrisch.»',
      slot: 'Q ∈ R d×d',
    },
  ];

  const identifiers = [
    {
      token: 'We',
      source: 'We ∈ R n×d is the embedding matrix.',
      prompt: '<i0> is the embedding matrix.',
      slot: 'We ∈ R n×d',
    },
    {
      token: 'In',
      source: 'In ∈ R n×n is the identity matrix.',
      prompt: '<i0> is the identity matrix.',
      slot: 'In ∈ R n×n',
    },
    {
      token: 'Si',
      source: 'Si ∈ R d×d is a diagonal matrix.',
      prompt: '<i0> is a diagonal matrix.',
      slot: 'Si ∈ R d×d',
    },
    {
      // Flattened W_o is the canonical output-projection matrix even with an operand before the
      // operator; only a clause-initial "Wo" is the German opener (see the openers list above).
      token: 'Wo',
      source: 'The projection Wo Q ∈ R d model ×d k is learned.',
      prompt: 'The projection <i0> is learned.',
      slot: 'Wo Q ∈ R d model ×d k',
    },
    {
      token: 'Wo',
      source: 'The projection (Wo Q ∈ R d model × d k) is learned.',
      prompt: 'The projection (<i0>) is learned.',
      slot: 'Wo Q ∈ R d model × d k',
    },
    {
      token: 'Wo',
      source: 'For Wo Q ∈ R d model × d k we use a projection.',
      prompt: 'For <i0> we use a projection.',
      slot: 'Wo Q ∈ R d model × d k',
    },
    {
      token: 'Wo',
      source: 'Given Wo Q ∈ R d model × d k we use a projection.',
      prompt: 'Given <i0> we use a projection.',
      slot: 'Wo Q ∈ R d model × d k',
    },
    {
      token: 'Wo',
      source: 'The Wo Q ∈ R d model × d k matrix is learned.',
      prompt: 'The <i0> matrix is learned.',
      slot: 'Wo Q ∈ R d model × d k',
    },
    {
      token: 'Wo',
      source: '(The projection Wo Q ∈ R d model × d k) is learned.',
      prompt: '(The projection <i0>) is learned.',
      slot: 'Wo Q ∈ R d model × d k',
    },
    {
      token: 'Wo',
      source: '• The projection Wo Q ∈ R d model × d k is learned.',
      prompt: '• The projection <i0> is learned.',
      slot: 'Wo Q ∈ R d model × d k',
    },
  ];

  it.each(openers)('peels $token before another operand', ({ source, prompt, slot }) => {
    const block = layoutPage(groupLines([piece(source, 49, 100, 430)])).blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(
      protectedText.slots.map((entry) => entry.text),
      source,
    ).toEqual([slot]);
    expect(protectedText.text, source).toBe(prompt);
    expect(restoreInlineMath('訳文 <i0> です。', protectedText.slots)).toBe(`訳文 ${slot} です。`);
  });

  it.each(identifiers)(
    'keeps $token directly before the operator in the slot',
    ({ source, prompt, slot }) => {
      const block = layoutPage(groupLines([piece(source, 49, 100, 430)])).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((entry) => entry.text),
        source,
      ).toEqual([slot]);
      expect(protectedText.text, source).toBe(prompt);
      expectSourcePreserved(protectedText, source);
    },
  );

  it('full combined suite: openers and identifiers keep their positions on one page', () => {
    const cases = [
      {
        source: 'Et Q ∈ R d×d est orthogonal, le résultat suit.',
        prompt: 'Et <i0> est orthogonal, le résultat suit.',
        slot: 'Q ∈ R d×d',
      },
      {
        source: 'Ou Q ∈ R d×d est orthogonal, le résultat suit.',
        prompt: 'Ou <i0> est orthogonal, le résultat suit.',
        slot: 'Q ∈ R d×d',
      },
      {
        source: 'Ni Q ∈ R d×d es ortogonal, el resultado se sigue.',
        prompt: 'Ni <i0> es ortogonal, el resultado se sigue.',
        slot: 'Q ∈ R d×d',
      },
      {
        source: 'El Q ∈ R d×d es ortogonal, el resultado se sigue.',
        prompt: 'El <i0> es ortogonal, el resultado se sigue.',
        slot: 'Q ∈ R d×d',
      },
      {
        source: 'If Q ∈ R d×d is orthogonal.',
        prompt: 'If <i0> is orthogonal.',
        slot: 'Q ∈ R d×d',
      },
      {
        source: 'Si Q ∈ R d×d es ortogonal, el resultado se sigue.',
        prompt: 'Si <i0> es ortogonal, el resultado se sigue.',
        slot: 'Q ∈ R d×d',
      },
      {
        source: 'We ∈ R n×d is the embedding matrix.',
        prompt: '<i0> is the embedding matrix.',
        slot: 'We ∈ R n×d',
      },
      {
        source: 'In ∈ R n×n is the identity matrix.',
        prompt: '<i0> is the identity matrix.',
        slot: 'In ∈ R n×n',
      },
      {
        source: 'Si ∈ R d×d is a diagonal matrix.',
        prompt: '<i0> is a diagonal matrix.',
        slot: 'Si ∈ R d×d',
      },
      {
        source: 'At ∈ R n×d is the attention matrix.',
        prompt: '<i0> is the attention matrix.',
        slot: 'At ∈ R n×d',
      },
      {
        // Flattened W-subscript matrix names stay notation even with an operand before `∈`.
        source: 'The projection Wi Q ∈ R d model ×d k is learned.',
        prompt: 'The projection <i0> is learned.',
        slot: 'Wi Q ∈ R d model ×d k',
      },
      {
        // W_o gets the same protection, while a clause-initial Wo stays a German prose opener.
        source: 'The projection Wo Q ∈ R d model ×d k is learned.',
        prompt: 'The projection <i0> is learned.',
        slot: 'Wo Q ∈ R d model ×d k',
      },
      {
        source: 'Wo Q ∈ R d×d gilt, ist die Matrix symmetrisch.',
        prompt: 'Wo <i0> gilt, ist die Matrix symmetrisch.',
        slot: 'Q ∈ R d×d',
      },
      {
        source: 'For Wo Q ∈ R d model × d k we use a projection.',
        prompt: 'For <i0> we use a projection.',
        slot: 'Wo Q ∈ R d model × d k',
      },
    ];
    for (const { source, prompt, slot } of cases) {
      const block = layoutPage(groupLines([piece(source, 49, 100, 430)])).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((entry) => entry.text),
        source,
      ).toEqual([slot]);
      expect(protectedText.text, source).toBe(prompt);
      expectSourcePreserved(protectedText, source);
      expect(restoreInlineMath('訳文 <i0> です。', protectedText.slots)).toBe(
        `訳文 ${slot} です。`,
      );
    }
  });

  it('does not treat a tight-leading multi-word prose line as an orphan script fragment', () => {
    const lines = groupLines([
      piece('reversing the traditional dynamic, AI-DLC ensures that human', 313, 480.7, 263),
      piece('involvement', 313, 493.0, 57),
      piece('is purposeful, concentrating on oversight, risk', 375, 493.0, 201),
      piece('mitigation, and strategic alignment, thereby enhancing both', 313, 505.0, 263),
      piece('velocity and quality. An analogy to illustrate this is Google Maps:', 313, 517.2, 263),
    ]);
    const layout = layoutPage(lines);
    const block = layout.blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toEqual([]);
    expect(protectedText.text).toBe(block.text);
  });

  it('does not pull a short word at the start of the next wrapped prose line as a superscript', () => {
    const lines = groupLines([
      piece('into independent, right-sized bounded contexts that can', 40, 100, 250),
      piece('be', 40, 111.8, 12),
      piece('rapidly built in parallel during planning and decomposition.', 56, 111.8, 234),
    ]);
    const layout = layoutPage(lines);
    const block = layout.blocks[0];
    if (!block) throw new Error('expected a block');
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toEqual([]);
    expect(protectedText.text).toBe(block.text);
  });

  it('does not protect standalone parentheses around prose acronyms while keeping (x) protected', () => {
    const proseLines = groupLines([
      piece('following Domain Driven Design ', 40, 100, 150),
      piece('(', 190, 100, 4),
      piece('DDD', 194, 100, 22),
      piece('),', 216, 100, 8),
      piece(' Behavior Driven Development', 224, 100, 140),
    ]);
    const proseLayout = layoutPage(proseLines);
    const proseBlock = proseLayout.blocks[0];
    if (!proseBlock) throw new Error('expected a prose block');
    expect(protectInlineMath(proseBlock).slots).toEqual([]);

    const mathLines = groupLines([
      piece('evaluate function ', 40, 100, 90),
      piece('(', 130, 100, 4),
      piece('x', 134, 100, 6, { italic: true }),
      piece(')', 140, 100, 4),
      piece(' over every token in the batch.', 144, 100, 150),
    ]);
    const mathLayout = layoutPage(mathLines);
    const mathBlock = mathLayout.blocks[0];
    if (!mathBlock) throw new Error('expected a math block');
    const mathProtected = protectInlineMath(mathBlock);
    expect(mathProtected.slots.map((slot) => slot.text)).toEqual(['(x)']);
  });
});
