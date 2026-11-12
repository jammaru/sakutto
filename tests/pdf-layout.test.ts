import { describe, expect, it } from 'vitest';
import { groupLines, type TextPiece } from '@/pdf/lines';
import { isCodeToken, isNumericCell, layoutPage } from '@/pdf/layout';

/** A synthetic piece: a run of text at a position, in top-left space. */
function piece(
  text: string,
  x: number,
  baseline: number,
  width: number,
  options: {
    em?: number;
    bold?: boolean;
    italic?: boolean;
    math?: boolean;
    family?: TextPiece['family'];
    size?: number;
  } = {},
): TextPiece {
  const em = options.em ?? 10;
  return {
    text,
    box: { x, y: baseline - em, width, height: em },
    baseline,
    fontName: options.bold === true ? 'bold' : 'regular',
    family: options.family ?? 'serif',
    bold: options.bold === true,
    italic: options.italic === true,
    math: options.math === true,
    orientation: 0,
    size: options.size ?? em,
    displayed: 0,
  };
}

describe('groupLines', () => {
  it('puts pieces on one baseline into one line', () => {
    const lines = groupLines([piece('Hello', 10, 100, 30), piece('world', 43, 100, 30)]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Hello world');
  });

  it('keeps two columns on the same baseline apart', () => {
    const lines = groupLines([
      piece('left column text', 40, 120, 120),
      piece('right column text', 320, 120, 120),
    ]);
    expect(lines.map((line) => line.text)).toEqual(['left column text', 'right column text']);
  });

  it('adds the space a PDF dropped between two runs', () => {
    const lines = groupLines([piece('the', 10, 100, 18), piece('reader', 30, 100, 34)]);
    expect(lines[0]?.text).toBe('the reader');
  });

  it('does not insert a space where two runs join a word', () => {
    const lines = groupLines([piece('hyphen', 10, 100, 32), piece('ation', 42, 100, 24)]);
    expect(lines[0]?.text).toBe('hyphenation');
  });

  it('orders a page top to bottom', () => {
    // In top-left space a larger baseline sits further down the page, so `first` is the one
    // with the smallest baseline.
    const lines = groupLines([
      piece('second', 10, 100, 40),
      piece('first', 10, 80, 30),
      piece('third', 10, 120, 30),
    ]);
    expect(lines.map((line) => line.text)).toEqual(['first', 'second', 'third']);
  });

  it('keeps a rotated stamp out of the body’s lines', () => {
    // A repository writes its identifier up the left margin. Its letters share no baseline
    // with the body, and its box spans the column, so it must not join a paragraph.
    const stamp = piece('PREPRINT:demo-2024-v3 23 Mar 2025', 32, 232, 20, { em: 20 });
    stamp.orientation = 90;
    stamp.box = { x: 32, y: 212, width: 20, height: 245 };
    const lines = groupLines([
      piece('The recent advances on transformer-based large language', 49, 563, 522),
      stamp,
    ]);
    expect(lines.map((line) => line.text).sort()).toEqual([
      'PREPRINT:demo-2024-v3 23 Mar 2025',
      'The recent advances on transformer-based large language',
    ]);
    expect(lines.filter((line) => line.text.startsWith('The recent'))).toHaveLength(1);
  });
});

describe('layoutPage', () => {
  it('keeps a hanging-indent wrap as one block', () => {
    const lines = groupLines([
      piece(
        '[1] A. Author and others. A compact translation model that fits on one line of a column.',
        49,
        100,
        240,
      ),
      piece('Technical report, 2026.', 64, 112, 120),
      piece('A following paragraph in the same column of the page.', 49, 140, 240),
    ]);
    const layout = layoutPage(lines);
    expect(
      layout.blocks.some(
        (block) => block.text.includes('Technical report') && block.text.includes('[1]'),
      ),
    ).toBe(true);
  });

  it('groups a paragraph and keeps the hyphenation out of its words', () => {
    const lines = groupLines([
      piece('A reader who wants an article', 40, 100, 200),
      piece('in Japanese has three choi-', 40, 112, 200),
      piece('ces: paste it somewhere.', 40, 124, 150),
    ]);
    const layout = layoutPage(lines);
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0]?.text).toBe(
      'A reader who wants an article in Japanese has three choices: paste it somewhere.',
    );
    expect(layout.blocks[0]?.role).toBe('prose');
  });

  it('starts a new paragraph after extra leading', () => {
    const lines = groupLines([
      piece('The first paragraph ends here.', 40, 100, 200),
      piece('The second paragraph starts here.', 40, 112, 220),
      piece('It continues on this line.', 40, 124, 160),
      piece('A third paragraph, after a gap.', 40, 148, 210),
    ]);
    const layout = layoutPage(lines);
    expect(layout.blocks.map((block) => block.text)).toEqual([
      'The first paragraph ends here. The second paragraph starts here. It continues on this line.',
      'A third paragraph, after a gap.',
    ]);
  });

  it('reads the left column before the right one', () => {
    // Long lines, as prose has: two short cells per row would be a table, and a table is read
    // cell by cell.
    const lines = groupLines([
      piece('left top line that fills the column of the page', 40, 100, 240),
      piece('left bottom line that fills the column too', 40, 112, 240),
      piece('right top line that fills the other column', 320, 100, 240),
      piece('right bottom line that fills it as well', 320, 112, 240),
    ]);
    const layout = layoutPage(lines);
    expect(layout.blocks.map((block) => block.text)).toEqual([
      'left top line that fills the column of the page left bottom line that fills the column too',
      'right top line that fills the other column right bottom line that fills it as well',
    ]);
  });

  it('keeps a table cell’s wrapped lines together and its columns apart', () => {
    // Two rows, the first cell wrapping mid-word in the first row. The hyphen is soft
    // because the next line continues in lower case.
    const lines = groupLines([
      piece('Constant', 40, 100, 50),
      piece('Value', 200, 100, 30),
      piece('maxSegment‐', 40, 112, 60),
      piece('48', 200, 112, 14),
      piece('tokens', 40, 124, 40),
    ]);
    const layout = layoutPage(lines);
    const texts = layout.blocks.map((block) => block.text);
    const skipped = layout.skipped.map((block) => block.text);
    expect(skipped).toContain('maxSegmenttokens');
    expect(skipped).toContain('48');
    expect(texts).not.toContain('maxSegmenttokens');
    expect(texts).not.toContain('48');
    expect(texts).toContain('Constant');
    expect(texts).toContain('Value');
  });

  it('keeps indented continuation lines of a monospace listing as code', () => {
    const lines = groupLines([
      piece('1  emit(token);', 50, 100, 90, { family: 'monospace' }),
      piece('    continue', 90, 112, 50, { family: 'monospace' }),
      piece('    more();', 90, 124, 48, { family: 'monospace' }),
    ]);
    const layout = layoutPage(lines);
    expect(layout.blocks.some((block) => /\bcontinue\b/u.test(block.text))).toBe(false);
    const code = layout.skipped.filter((block) => block.role === 'code');
    expect(code.length).toBeGreaterThanOrEqual(1);
    expect(code.some((block) => block.text.includes('continue'))).toBe(true);
    expect(code.some((block) => block.text.includes('emit(token)'))).toBe(true);
  });

  it('splits a table per cell and per row, and leaves numbers and identifiers alone', () => {
    const lines = groupLines([
      piece('Setting', 40, 100, 50),
      piece('Value', 200, 100, 30),
      piece('maxSegmentTo-', 40, 114, 72),
      piece('48', 200, 114, 14),
      piece('kens', 170, 126, 28),
      piece('pieceChars', 40, 140, 55),
      piece('600', 101, 140, 22),
      piece('CPU, 8 threads', 40, 160, 78),
      piece('34.8', 200, 160, 22),
      piece('CPU, 4 threads', 40, 174, 78),
      piece('18.1', 200, 174, 22),
    ]);
    const layout = layoutPage(lines);
    const texts = layout.blocks.map((block) => block.text);
    const skipped = layout.skipped.map((block) => block.text);
    expect(texts.some((text) => text.includes('CPU, 8') && text.includes('CPU, 4'))).toBe(false);
    expect(texts.filter((text) => text.startsWith('CPU,'))).toEqual([
      'CPU, 8 threads',
      'CPU, 4 threads',
    ]);
    expect(skipped).toContain('48');
    expect(skipped).toContain('600');
    expect(skipped).toContain('34.8');
    expect(skipped).toContain('18.1');
    expect(skipped.some((text) => /maxSegmentTo-?kens/iu.test(text.replace(/\s/gu, '')))).toBe(
      true,
    );
    expect(texts.some((text) => text.includes('kens') && !text.includes('maxSegment'))).toBe(false);
    expect(texts.some((text) => /\b600\b/u.test(text) && text !== '600')).toBe(false);
  });

  it('keeps each bulleted list item as its own block', () => {
    const lines = groupLines([
      piece('• Latency is the time to the first token.', 40, 100, 240),
      piece('• Memory is the resident size of the run.', 40, 114, 240),
      piece('• Quality is the share of fitted boxes.', 40, 128, 240),
    ]);
    const layout = layoutPage(lines);
    const items = layout.blocks.map((block) => block.text);
    expect(items).toHaveLength(3);
    expect(items[0]?.startsWith('•')).toBe(true);
    expect(items[1]?.startsWith('•')).toBe(true);
    expect(items[2]?.startsWith('•')).toBe(true);
    expect(items.some((text) => text.includes('•') && text.indexOf('•') > 0)).toBe(false);
  });

  it('makes a larger line a heading and marks it', () => {
    const lines = groupLines([
      piece('1. Introduction', 40, 100, 90, { em: 14, bold: true }),
      piece('A reader who wants an article', 40, 124, 200),
      piece('and reads on for a while.', 40, 136, 180),
    ]);
    const layout = layoutPage(lines);
    expect(layout.blocks[0]?.role).toBe('heading');
    expect(layout.blocks[0]?.text).toBe('1. Introduction');
    expect(layout.blocks[1]?.text).toBe('A reader who wants an article and reads on for a while.');
  });

  it('reports the body size as the size most letters are set in', () => {
    const lines = groupLines([
      piece('A title that is set large', 40, 80, 260, { em: 18 }),
      ...Array.from({ length: 6 }, (_, index) =>
        piece('Body text that runs across the column and keeps going.', 40, 110 + index * 12, 300),
      ),
    ]);
    const layout = layoutPage(lines);
    expect(layout.bodySize).toBe(10);
  });

  it('widens a block’s room to its column, not its last line', () => {
    const lines = groupLines([
      piece('A paragraph whose first line is long', 40, 100, 260),
      piece('and whose last line is short.', 40, 112, 150),
      piece('A following paragraph in the same column.', 40, 140, 240),
    ]);
    const layout = layoutPage(lines);
    const first = layout.blocks[0];
    expect(first?.box.width).toBe(260);
    // The room is the box's own measure, less the gutter it keeps clear.
    expect(first?.room.width).toBeGreaterThanOrEqual(256);
  });

  it('reads a two-column page whose title and abstract span both columns', () => {
    // The shape of a two-column first page: a full-width title, a full-width abstract, then
    // two columns. There is no x that every line avoids, so a gutter has to be found from the
    // rows that are split rather than from a band nothing crosses.
    const lines = groupLines([
      piece('Large Language Models: A Survey', 137, 60, 346, { em: 24 }),
      // Abstract, one column wide in this fixture but only on the left, then the body.
      piece('Abstract: large language models have drawn attention', 49, 260, 252),
      piece('from the research community and the wider public.', 49, 272, 252),
      // Two columns below.
      piece('Language modeling is a long-standing research topic', 49, 300, 252),
      piece('that dates back to the 1950s, and the field has', 49, 312, 252),
      piece('and the systems people build with them, in one place.', 319, 260, 252),
      piece('These models are large-scale and pre-trained on text.', 319, 300, 252),
      piece('They are statistical language models with many layers.', 319, 312, 252),
    ]);
    const layout = layoutPage(lines);
    const columns = new Set(layout.blocks.map((block) => block.column));
    expect(columns.size).toBeGreaterThan(1);
    const left = layout.blocks.filter((block) => block.box.x === 49);
    const right = layout.blocks.filter((block) => block.box.x === 319);
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
  });

  it('keeps a section number with its title', () => {
    // `I.` and `INTRODUCTION` are set with a wide gap, which is not a table cell boundary.
    const lines = groupLines([piece('I.', 134, 200, 6), piece('INTRODUCTION', 150, 200, 66)]);
    const layout = layoutPage(lines);
    expect(layout.blocks.map((block) => block.text)).toEqual(['I. INTRODUCTION']);
    expect(layout.blocks[0]?.role).toBe('heading');
  });

  it('leaves a figure’s labels alone', () => {
    // A diagram's labels are set at a fraction of the body size. Replacing them paints text on
    // top of the drawing, which is what made a translated figure unreadable.
    const lines = groupLines([
      piece('The recent advances on transformer-based models', 49, 100, 252),
      piece('have changed how a language model is built.', 49, 112, 252),
      piece('Summarization', 76, 300, 29, { em: 4 }),
      piece('Multi choice QA', 58, 314, 25, { em: 3.3 }),
      piece('Figure 1: LLM capabilities.', 49, 400, 180),
    ]);
    const layout = layoutPage(lines);
    const texts = layout.blocks.map((block) => block.text);
    expect(texts.some((text) => text.includes('Summarization'))).toBe(false);
    expect(texts.some((text) => text.includes('Multi choice'))).toBe(false);
    expect(texts.some((text) => text.includes('The recent advances'))).toBe(true);
    expect(texts.some((text) => text.includes('Figure 1'))).toBe(true);
  });

  /**
   * A display equation is the one part of a paper the reader must give back unchanged.
   *
   * A formula is set in the paper's own math fonts, and translating it as if it were a
   * sentence replaces typeset mathematics with prose that lands in the same box. The signal is
   * the font — LaTeX sets math in CMMI/CMSY/CMEX and nothing else uses them — so a synthetic
   * page can reproduce it by marking those pieces as `math`.
   */
  it('leaves a display equation in the page’s own typesetting', () => {
    const lines = groupLines([
      piece('The recurrence is extended with a channel-wise gate', 49, 100, 420),
      piece('on a single head, with query and key vectors of that head.', 49, 112, 420),
      piece('The update is then written as', 49, 124, 200),
      piece('St', 150, 152, 12, { math: true }),
      piece('= I − β', 163, 152, 30, { math: true }),
      piece('t', 193, 152, 4, { math: true }),
      piece('k', 198, 152, 4, { math: true }),
      piece('Diag', 203, 152, 22, { math: true }),
      piece('(α', 225, 152, 9, { math: true }),
      piece('t', 234, 152, 4, { math: true }),
      piece(')', 238, 152, 4, { math: true }),
      piece('S', 242, 152, 6, { math: true }),
      piece('t−1', 248, 152, 14, { math: true }),
      piece(',', 262, 152, 3, { math: true }),
      piece('Here the retention factor is learned per channel.', 49, 180, 420),
    ]);
    const layout = layoutPage(lines);
    const kept = layout.blocks.map((block) => block.text);
    expect(kept.some((text) => text.includes('St='))).toBe(false);
    expect(kept.some((text) => text.includes('retention factor'))).toBe(true);
    expect(layout.skipped.some((block) => block.role === 'equation')).toBe(true);
  });
  it('keeps a sentence that mentions a variable', () => {
    // The same page's prose names `q`, `k` and `v` in the math face. A rule that only looked
    // at the math share would call this line an equation and leave the paragraph untranslated.
    const lines = groupLines([
      piece('with query and key vectors ', 49, 100, 120),
      piece('q', 170, 100, 6, { math: true }),
      piece(', ', 176, 100, 4),
      piece('k', 180, 100, 6, { math: true }),
      piece(' and value vectors ', 186, 100, 90),
      piece('v', 278, 100, 6, { math: true }),
      piece(', plus a recurrent state.', 284, 100, 100),
    ]);
    const layout = layoutPage(lines);
    expect(layout.blocks).toHaveLength(1);
    expect(layout.skipped).toEqual([]);
  });

  it('translates a word inside a figure and leaves an axis tick', () => {
    // A diagram's box names are real words and a reader wants them; a tick is a number and
    // belongs to the drawing. Both sit inside the picture's rectangle.
    const lines = groupLines([
      piece('The model routes each token to two of its experts', 49, 600, 250),
      piece('Router', 150, 300, 30),
      piece('0.5', 190, 340, 16),
    ]);
    const figures = { images: [{ x: 120, y: 270, width: 300, height: 120 }] };
    const layout = layoutPage(lines, figures);
    expect(layout.blocks.map((block) => block.text)).toContain(
      'The model routes each token to two of its experts',
    );
    expect(layout.blocks.map((block) => block.text)).toContain('Router');
    expect(
      layout.skipped.some((block) => block.text === '0.5' && block.role === 'figure-label'),
    ).toBe(true);
  });
});

describe('isCodeToken / isNumericCell', () => {
  it('treats camelCase, snake_case, hyphen-broken identifiers, and numbers as untranslatable', () => {
    expect(isCodeToken('maxSegmentTokens')).toBe(true);
    expect(isCodeToken('maxSegmentTo-')).toBe(true);
    expect(isCodeToken('maxSegmentTo-kens')).toBe(true);
    expect(isCodeToken('piece_chars')).toBe(true);
    expect(isCodeToken('kens')).toBe(false);
    expect(isCodeToken('Constant')).toBe(false);
    expect(isCodeToken('Router')).toBe(false);
    expect(isCodeToken('Maximum')).toBe(false);
    expect(isNumericCell('48')).toBe(true);
    expect(isNumericCell('600')).toBe(true);
    expect(isNumericCell('1.9 s')).toBe(true);
    expect(isNumericCell('CPU, 8 threads')).toBe(false);
  });
});
