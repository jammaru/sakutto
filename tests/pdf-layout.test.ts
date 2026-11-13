import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractPage, type PdfPage } from '@/pdf/extract';
import { groupLines, type TextPiece } from '@/pdf/lines';
import {
  isCodeToken,
  isNumericCell,
  isNumericRow,
  layoutPage,
  looksLikeCodeLine,
  orphanLineCount,
} from '@/pdf/layout';
import { openPdfBytes } from './support/open-fixture-pdf';
import {
  BIG_PROSE,
  CITE_RICH_PROSE,
  CODE_LINE_CORPUS,
  DISCUSSION_PROSE,
  ENUM_SEMI_PROSE,
  LC_NUMBERED_PROSE,
  LEGEND_PROSE,
  LISTING_LINES,
  NUMBERED_CODE,
} from './support/pdf-code-line-corpus';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  it('does not absorb a distant table row into a leading caption', () => {
    const lines = groupLines([
      piece('Table 3: Results for several epsilon values.', 40, 100, 220),
      piece('ε=0.3', 80, 172, 40),
      piece('Combo', 40, 184, 50),
      piece('Method', 120, 184, 50),
      piece('ε=0.1', 200, 184, 40),
    ]);
    const layout = layoutPage(lines);
    const captions = layout.blocks.filter((block) => block.role === 'caption');
    expect(captions).toHaveLength(1);
    expect(captions[0]?.text).toBe('Table 3: Results for several epsilon values.');
    expect(captions[0]?.lines).toHaveLength(1);
  });

  it('keeps a wrapped caption line with the caption block', () => {
    const lines = groupLines([
      piece('Table 2: A caption that continues on the next line of text.', 40, 100, 220),
      piece('with more words on the wrap.', 52, 112, 180),
      piece('Value', 40, 200, 50),
    ]);
    const layout = layoutPage(lines);
    const captions = layout.blocks.filter((block) => block.role === 'caption');
    expect(captions).toHaveLength(1);
    expect(captions[0]?.text).toContain('continues on the next line');
    expect(captions[0]?.text).toContain('with more words on the wrap');
  });

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

  it('keeps a reference entry’s hanging-indent continuation lines together', () => {
    const lines = groupLines([
      piece(
        '[1] A. Author and others. A compact translation model that fits on a column line.',
        49,
        100,
        240,
      ),
      piece('Technical report with a wrapped continuation on the hanging indent.', 64, 112, 210),
      piece('The final line of the same entry also sits on the hanging indent.', 64, 124, 220),
      piece('[2] A second entry with its own short title.', 49, 148, 220),
    ]);
    const layout = layoutPage(lines);
    expect(
      layout.blocks.some(
        (block) =>
          block.text.includes('[1]') &&
          block.text.includes('wrapped continuation') &&
          block.text.includes('final line of the same entry'),
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

  it('splits single-line paragraphs when the only gaps are paragraph gaps', () => {
    const lines = groupLines([
      piece('The first paragraph is a complete sentence on its own line.', 40, 100, 260),
      piece('The second paragraph is also a complete sentence on one line.', 40, 150, 260),
      piece('The third paragraph closes the column with another sentence.', 40, 200, 260),
    ]);
    const layout = layoutPage(lines);
    expect(layout.blocks.map((block) => block.text)).toEqual([
      'The first paragraph is a complete sentence on its own line.',
      'The second paragraph is also a complete sentence on one line.',
      'The third paragraph closes the column with another sentence.',
    ]);
  });

  it('splits an overlong paragraph whose lines end mid-sentence', () => {
    const lines = groupLines(
      Array.from({ length: 30 }, (_, index) =>
        piece(
          index % 5 === 4
            ? 'The detector closes this sentence before the next one begins.'
            : 'A wrapped line continues the same sentence without any final period',
          40,
          100 + index * 12,
          320,
        ),
      ),
    );
    const layout = layoutPage(lines);
    const prose = layout.blocks.filter((block) => block.role === 'prose');
    expect(prose.length).toBeGreaterThan(1);
    expect(prose.every((block) => block.text.length <= 600)).toBe(true);
    expect(prose.every((block) => /[.!?]$/u.test(block.text.trim()))).toBe(true);
  });

  it('splits indent-only paragraphs in both columns instead of fusing each column', () => {
    const em = 10;
    const y = (row: number) => 100 + row * 12;
    const column = (x: number): ReturnType<typeof piece>[] => [
      piece('Opening paragraph in this column begins with an indented line', x + em, y(0), 250),
      piece('and continues on the column wall without any extra leading here', x, y(1), 250),
      piece('before closing the first paragraph with a full sentence.', x, y(2), 250),
      piece('The second paragraph also starts with an indented first line', x + em, y(3), 250),
      piece('and continues on the same column wall for another whole line', x, y(4), 250),
      piece('before closing the second paragraph with a full sentence.', x, y(5), 250),
      piece('A third paragraph starts indented and keeps the same leading', x + em, y(6), 250),
      piece('and continues on the column wall just like the paragraphs above', x, y(7), 250),
      piece('before closing the third paragraph with a full sentence.', x, y(8), 250),
    ];
    const lines = groupLines([...column(40), ...column(320)]);
    const layout = layoutPage(lines, { images: [] }, { width: 600, height: 800 });
    const prose = layout.blocks.filter(
      (block) => block.role === 'prose' || block.role === 'heading',
    );
    expect(prose).toHaveLength(6);
    expect(prose.every((block) => block.lines.length <= 3)).toBe(true);
    expect(prose.some((block) => block.text.includes('first paragraph'))).toBe(true);
    expect(prose.some((block) => block.text.includes('second paragraph'))).toBe(true);
    expect(prose.some((block) => block.text.includes('third paragraph'))).toBe(true);
  });

  it('caps an overlong prose block at a sentence boundary', () => {
    const sentence = 'The detector compares each configuration on the same stream of tokens.';
    const lines = groupLines(
      Array.from({ length: 20 }, (_, index) => piece(sentence, 40, 100 + index * 12, 320)),
    );
    const layout = layoutPage(lines);
    const prose = layout.blocks.filter((block) => block.role === 'prose');
    expect(prose.length).toBeGreaterThan(1);
    expect(prose.every((block) => block.text.length <= 600)).toBe(true);
    expect(prose.every((block) => /[.!?]$/u.test(block.text.trim()))).toBe(true);
  });

  it('flushes a long paragraph that only crosses the cap on its last line', () => {
    const sentence = 'The detector compares each configuration on the same stream of tokens.';
    const lines = groupLines(
      Array.from({ length: 9 }, (_, index) => piece(sentence, 40, 100 + index * 12, 320)),
    );
    const layout = layoutPage(lines);
    const prose = layout.blocks.filter((block) => block.role === 'prose');
    expect(prose.length).toBeGreaterThan(1);
    expect(prose.every((block) => block.text.length <= 600)).toBe(true);
    expect(prose.every((block) => /[.!?]$/u.test(block.text.trim()))).toBe(true);
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

  it('keeps a Japanese paragraph as prose even when pdf.js reports monospace', () => {
    const lines = groupLines([
      piece('本文は日本語の段落であり、ソースコードの掲載ではない。', 40, 100, 280, {
        family: 'monospace',
      }),
      piece('次の行も同じ段落の続きで、翻訳の対象になる。', 40, 114, 240, {
        family: 'monospace',
      }),
    ]);
    const layout = layoutPage(lines);
    expect(layout.skipped.some((block) => block.role === 'code')).toBe(false);
    expect(layout.blocks.some((block) => block.role === 'prose')).toBe(true);
    expect(layout.blocks.some((block) => block.text.includes('日本語の段落'))).toBe(true);
    expect(orphanLineCount(lines, layout)).toBe(0);
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

  it('classifies bold table column titles as labels, not headings', () => {
    const lines = groupLines([
      piece('Settings', 80, 200, 36, { bold: true, em: 8 }),
      piece('Precision', 140, 200, 40, { bold: true, em: 8 }),
      piece('0.98', 80, 212, 24, { em: 8 }),
      piece('0.70', 140, 212, 24, { em: 8 }),
    ]);
    const layout = layoutPage(lines);
    const titles = layout.blocks.filter((block) => /Settings|Precision/u.test(block.text));
    expect(titles.every((block) => block.role === 'label')).toBe(true);
    expect(layout.blocks.some((block) => block.role === 'heading')).toBe(false);
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

  it('keeps justified body as one prose block, not word-sized cells', () => {
    const em = 10;
    const gap = 0.62 * em;
    const words = (row: string, y: number): ReturnType<typeof piece>[] => {
      let x = 40;
      return row.split(' ').map((word) => {
        const width = word.length * em * 0.5;
        const run = piece(word, x, y, width, { em });
        x += width + gap;
        return run;
      });
    };
    const lines = groupLines([
      ...words('Justified body text keeps its word gaps inside one paragraph block.', 100),
      ...words('A second line of the same paragraph continues at the same measure.', 114),
    ]);
    const layout = layoutPage(lines);
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0]?.role).toBe('prose');
    expect(orphanLineCount(lines, layout)).toBe(0);
    expect(layout.blocks[0]?.text).toContain('Justified body text');
    expect(layout.blocks[0]?.text).toContain('second line');
  });

  it('keeps a bold run-in heading on the same line as its sentence', () => {
    const lines = groupLines([
      piece('Reported completion over untranslated prose.', 40, 100, 260, { bold: true }),
      piece('A page that still shows English has no cover on that line.', 306, 100, 280),
      piece('The next line continues the same paragraph without a new heading.', 40, 114, 320),
    ]);
    const layout = layoutPage(lines);
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0]?.role).toBe('prose');
    expect(layout.blocks[0]?.text).toContain('Reported completion over untranslated prose.');
    expect(layout.blocks[0]?.text).toContain('A page that still shows English');
    expect(orphanLineCount(lines, layout)).toBe(0);
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

  it('translates numbered lead-ins and body paragraphs, not as code or identity', () => {
    const lines = groupLines([
      piece('4) Encoder-Decoder: a diagram of the two stacks.', 40, 100, 280, { italic: true }),
      piece(
        'Data quality is crucial for training a model that generalizes to new tasks.',
        40,
        160,
        300,
      ),
      piece('The research team published a comparison of chat models.', 40, 220, 280),
      piece('as a chat model that follows instructions written in the prompt.', 40, 280, 300),
    ]);
    const layout = layoutPage(lines, { images: [] }, { width: 400, height: 600, index: 2 });
    const texts = layout.blocks.map((block) => block.text);
    const skippedRoles = layout.skipped.map((block) => block.role);
    expect(skippedRoles).not.toContain('code');
    expect(skippedRoles).not.toContain('identity');
    expect(texts.some((text) => text.includes('Encoder-Decoder'))).toBe(true);
    expect(texts.some((text) => text.includes('Data quality is crucial'))).toBe(true);
    expect(texts.some((text) => text.includes('research team published'))).toBe(true);
    expect(texts.some((text) => text.includes('follows instructions'))).toBe(true);
    expect(layout.blocks.every((block) => block.role !== 'code' && block.role !== 'identity')).toBe(
      true,
    );
    expect(orphanLineCount(lines, layout)).toBe(0);
  });

  it('keeps a section number with its title', () => {
    // `I.` and `INTRODUCTION` are set with a wide gap, which is not a table cell boundary.
    const lines = groupLines([piece('I.', 134, 200, 6), piece('INTRODUCTION', 150, 200, 66)]);
    const layout = layoutPage(lines);
    expect(layout.blocks.map((block) => block.text)).toEqual(['I. INTRODUCTION']);
    expect(layout.blocks[0]?.role).toBe('heading');
  });

  it('joins justified word fragments into the sentence before them', () => {
    const lines = groupLines([
      piece('The paragraph starts on this line and then continues', 40, 100, 240),
      piece('with a phrase whose words are set apart', 40, 112, 120),
      piece('help', 170, 112, 22),
      piece('reduce', 203, 112, 30),
      piece('the', 244, 112, 14),
      piece('effort', 269, 112, 28),
      piece('required.', 308, 112, 34),
    ]);
    const layout = layoutPage(lines);
    const text = layout.blocks.map((block) => block.text).join(' ');
    expect(text).toContain('help reduce the effort required.');
    expect(layout.blocks.some((block) => block.text === 'help')).toBe(false);
    expect(layout.blocks.some((block) => block.text === 'the effort')).toBe(false);
  });

  it('joins body-size label fragments on one baseline into a prose line', () => {
    const lines = groupLines([
      piece('Shown', 40, 100, 30),
      piece('with', 80, 100, 20),
      piece('These', 110, 100, 28),
      piece('values', 148, 100, 34),
    ]);
    const layout = layoutPage(lines);
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0]?.text).toBe('Shown with These values');
    expect(layout.blocks[0]?.role).toBe('prose');
  });

  it('keeps a reference row with author and title runs as one entry', () => {
    const lines = groupLines([
      piece('[3] T. Author,', 55, 100, 50),
      piece('B. Writer', 125, 100, 50),
      piece('and C. Editor, “A study,”', 180, 100, 110),
      piece('Journal of Examples,', 76, 112, 120),
      piece('vol. 1, pp. 1-10, 2020.', 76, 124, 140),
      piece('[4] Next entry.', 55, 148, 80),
    ]);
    const layout = layoutPage(lines);
    const references = layout.blocks.filter((block) => block.text.startsWith('['));
    expect(references).toHaveLength(2);
    expect(references[0]?.text).toContain('[3]');
    expect(references[0]?.text).toContain('B. Writer');
    expect(references[0]?.text).toContain('and C. Editor');
    expect(references[0]?.text).toContain('Journal of Examples');
    expect(references[0]?.text).toContain('vol. 1');
    expect(references[1]?.text).toContain('[4]');
  });

  it('treats a row of axis ticks or legend values as a cell, not prose', () => {
    const lines = groupLines([
      piece('ε=0.1', 40, 100, 28, { em: 8 }),
      piece('1', 40, 112, 5, { em: 8 }),
      piece('0.8', 40, 124, 14, { em: 8 }),
      piece('0.6', 40, 136, 14, { em: 8 }),
    ]);
    const layout = layoutPage(lines);
    expect(layout.blocks.some((block) => block.role === 'prose')).toBe(false);
    expect(
      layout.skipped.some((block) => block.role === 'cell' && block.text.includes('ε=0.1')),
    ).toBe(true);
    expect(isNumericRow('TS 0.87 0.62 0.58 0.74')).toBe(true);
    expect(isNumericRow('ε=0.1 1 0.8 0.6 0.4 0.2 0')).toBe(true);
    expect(isNumericRow('Settings b=5, t=11 N/A')).toBe(true);
    expect(isNumericRow('CPU, 8 threads')).toBe(false);
    expect(isNumericRow('We compared 30 tools in 4 settings.')).toBe(false);
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

  it('leaves a short flowchart word untranslated so it cannot overflow the box beside it', () => {
    // A diagram's node labels sit inside the drawing. Translating them overwrites the
    // neighbouring box or a tick; they stay on the canvas and a marker can still open them.
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
    expect(layout.blocks.map((block) => block.text)).not.toContain('Router');
    expect(
      layout.skipped.some((block) => block.text === 'Router' && block.role === 'figure-label'),
    ).toBe(true);
    expect(
      layout.skipped.some((block) => block.text === '0.5' && block.role === 'figure-label'),
    ).toBe(true);
  });

  it('keeps a short reference entry with its hanging-indent continuation in one block', () => {
    const lines = groupLines([
      piece('[1]', 49, 100, 12),
      piece('A wrapped continuation line on the hanging indent.', 64, 112, 220),
      piece('2024. A year-like continuation that looks like a new list item.', 64, 124, 240),
      piece('[2] Second entry.', 49, 148, 80),
      piece('Its own continuation on the hanging indent.', 64, 160, 220),
    ]);
    const layout = layoutPage(lines);
    const references = layout.blocks.filter((block) => block.text.startsWith('['));
    expect(references).toHaveLength(2);
    expect(references[0]?.text).toContain('[1]');
    expect(references[0]?.text).toContain('wrapped continuation');
    expect(references[0]?.text).toContain('year-like continuation');
    expect(references[1]?.text).toContain('[2]');
    expect(references[1]?.text).toContain('own continuation');
  });

  it('splits a run that crosses a figure boundary into prose and figure-label lines', () => {
    const lines = groupLines([
      piece('The opening sentence of this paragraph is outside the drawing.', 49, 100, 320),
      piece('The middle line is drawn inside the diagram and must stay there.', 49, 112, 320),
      piece('The closing line is also part of the diagram artwork.', 49, 124, 320),
    ]);
    const figures = { images: [{ x: 40, y: 101, width: 360, height: 30 }] };
    const layout = layoutPage(lines, figures, { width: 600, height: 800 });
    expect(
      layout.blocks.some(
        (block) =>
          block.role === 'prose' && block.text.includes('opening sentence of this paragraph'),
      ),
    ).toBe(true);
    expect(layout.blocks.some((block) => block.text.includes('middle line'))).toBe(false);
    expect(layout.blocks.some((block) => block.text.includes('closing line'))).toBe(false);
    const labels = layout.skipped.filter((block) => block.role === 'figure-label');
    expect(labels.map((block) => block.text).join(' ')).toContain('middle line');
    expect(labels.map((block) => block.text).join(' ')).toContain('closing line');
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
    expect(isCodeToken('ABSTRACT')).toBe(false);
    expect(isCodeToken('INTRODUCTION')).toBe(false);
    expect(isNumericCell('48')).toBe(true);
    expect(isNumericCell('600')).toBe(true);
    expect(isNumericCell('1.9 s')).toBe(true);
    expect(isNumericCell('CPU, 8 threads')).toBe(false);
  });
});

describe('pseudocode line shapes', () => {
  it('recognises assignment, for-each, and camelCase listing lines', () => {
    expect(looksLikeCodeLine('evalModules = modules for the evaluation;')).toBe(true);
    expect(looksLikeCodeLine('for each (m : evalModules) {')).toBe(true);
    expect(looksLikeCodeLine('devEval = the readability of m by a')).toBe(true);
    expect(looksLikeCodeLine('output evaluation = calibModel.predict(m);')).toBe(true);
    expect(looksLikeCodeLine('The collector walks the document rather than selecting tags.')).toBe(
      false,
    );
    expect(looksLikeCodeLine('5. Conclusions and next steps for the study')).toBe(false);
    expect(looksLikeCodeLine('For each module the reader records a score.')).toBe(false);
    expect(
      looksLikeCodeLine(
        '[3] A. Author. “wllama: WebAssembly bindings for llama.cpp.” Software, 2024–2026.',
      ),
    ).toBe(false);
  });

  it('keeps English prose with a parenthetical reference as prose, not code', () => {
    expect(
      looksLikeCodeLine('Translation quality improves (Table 2) if the model sees the heading.'),
    ).toBe(false);
    expect(
      looksLikeCodeLine('The queue grows (Figure 2) while the reader keeps scrolling down.'),
    ).toBe(false);
    expect(looksLikeCodeLine('The update is written (Eq. 2) if the step is accepted.')).toBe(false);
    expect(
      looksLikeCodeLine('The appendix cites the result (Section 3) while the body continues.'),
    ).toBe(false);

    const lines = groupLines([
      piece('Translation quality improves (Table 2) if the model sees the heading.', 40, 100, 400),
      piece('The queue grows (Figure 2) while the reader keeps scrolling down.', 40, 128, 400),
      piece(
        'A later paragraph cites the same table (Table 2) if the reader asks for it.',
        40,
        160,
        400,
      ),
      piece(
        'The appendix points at the figure (Section 3) while the body continues.',
        40,
        188,
        400,
      ),
      piece('The fitted cover is compared (Eq. 2) if the block still overflows.', 40, 216, 400),
    ]);
    const layout = layoutPage(lines);
    expect(layout.skipped.some((block) => block.role === 'code')).toBe(false);
    expect(layout.blocks.length).toBeGreaterThanOrEqual(3);
    expect(layout.blocks.every((block) => block.role === 'prose')).toBe(true);
    expect(layout.blocks.some((block) => block.text.includes('Translation quality improves'))).toBe(
      true,
    );
    expect(layout.blocks.some((block) => block.text.includes('queue grows'))).toBe(true);
  });

  it('still treats real listing lines as code', () => {
    const listing = [
      'if (x) {',
      'const y = 1;',
      'for each (m : evalModules) {',
      '1 for each (m) {',
      'emit(translate(block))',
      'return result;',
      'break;',
      'continue;',
      'if (x) { return y; }',
      'for (item of items) continue;',
      '{ return a; }',
      'switch (kind) {',
      'catch (error) {',
      '1  for block in page:',
      '2 if ready:',
      '3 while waiting:',
      '4 def layout(page):',
      '5 repeat:',
      '6 until done:',
      '1 For block in page:',
      '1 While queue:',
    ];
    expect(listing.length).toBeGreaterThanOrEqual(16);
    for (const line of listing) {
      expect(looksLikeCodeLine(line), line).toBe(true);
    }

    const lines = groupLines([
      piece('evalModules = modules for the evaluation;', 80, 200, 220),
      piece('for each (m : evalModules) {', 80, 214, 180),
      piece('if (m.ready) {', 80, 228, 120),
      piece('const y = calibModel.predict(m);', 80, 242, 200),
      piece('switch (kind) {', 80, 256, 140),
      piece('catch (error) {', 80, 270, 140),
      piece('return result;', 80, 284, 100),
      piece('}', 80, 298, 10),
      piece('The listing is the procedure a reader follows on each module.', 49, 340, 400),
    ]);
    const layout = layoutPage(lines);
    const code = layout.skipped.filter((block) => block.role === 'code');
    expect(code.length).toBeGreaterThan(0);
    const joined = code.map((block) => block.text).join(' ');
    expect(joined).toContain('for each');
    expect(joined).toContain('if (m.ready)');
    expect(joined).toContain('const y =');
    expect(joined).toContain('switch (kind)');
    expect(joined).toContain('catch (error)');
    expect(joined).toContain('return result;');
    expect(layout.blocks.some((block) => block.text.includes('listing is the procedure'))).toBe(
      true,
    );
  });

  it('keeps English return/break/continue/yield verbs with a parenthetical as prose', () => {
    const sentences = [
      'We return to the fitting question (Section 4) after describing the scheduler.',
      'We continue the discussion of memory (Figure 7) with the eviction policy.',
      'We break ties between two equally visible pages (Section 3.1) by their top edge.',
      'The measurement yields a bound on repaints (Theorem 1) for every input we tested.',
      'The generator will yield a bound on repaints (Theorem 1) for every input we tested.',
    ];
    for (const sentence of sentences) {
      expect(looksLikeCodeLine(sentence), sentence).toBe(false);
    }

    const wrapped = groupLines([
      piece('We return to the fitting question (Section 4) after', 40, 100, 400),
      piece('describing the scheduler in the next paragraph.', 40, 112, 280),
      piece('We continue the discussion of memory (Figure 7) with', 40, 140, 400),
      piece('the eviction policy the reader already knows.', 40, 152, 280),
    ]);
    const wrappedLayout = layoutPage(wrapped);
    expect(wrappedLayout.skipped.some((block) => block.role === 'code')).toBe(false);
    expect(wrappedLayout.blocks.every((block) => block.role === 'prose')).toBe(true);
    expect(wrappedLayout.blocks.some((block) => block.text.includes('fitting question'))).toBe(
      true,
    );
    expect(wrappedLayout.blocks.some((block) => block.text.includes('eviction policy'))).toBe(true);

    const discussion = [
      'We return to the fitting question (Section 4) after describing the scheduler.',
      'We continue the discussion of memory (Figure 7) with the eviction policy.',
      'We break ties between two equally visible pages (Section 3.1) by their top edge.',
      'The measurement yields a bound on repaints (Theorem 1) for every input we tested.',
      'A later paragraph returns to that bound (Table 2) after the queue is drained.',
      'The reader will continue from the last visible page (Figure 2) once it is ready.',
      'Nothing should break the column measure (Section 2) when a heading is skipped.',
      'The next pass will yield the same cover (Eq. 2) if the tokens still fit.',
      'We return the unused budget (Section 5) once the last line of the block is set.',
      'The scheduler will continue to the far page (Figure 4) after the focused one.',
      'Two covers break even (Section 3.2) when both sit inside the viewport band.',
      'The check yields no overflow (Theorem 2) for a short English caption.',
      'We return here only after the listing (Algorithm 1) has been classified.',
      'The body will continue in English (Table 3) until the model is loaded.',
      'A gap should not break a wrapped sentence (Section 1) across two columns.',
      'Each trial yields one number (Figure 1) and a short note under it.',
      'We return a marker (Section 6) rather than clip a line that still overflows.',
      'The compare pane will continue to share scroll (Figure 8) with the original.',
      'The rule must not break ordinary discussion (Section 4.1) into a listing.',
      'The probe yields a content type (Appendix B) without reading the whole file.',
      'We return to the original canvas (Figure 9) when compare is turned off.',
      'The queue will continue to drain (Section 7) after a visible page is aborted.',
      'Layout must not break a heading (Table 4) that happens to mention return.',
      'The run yields a translated page (Section 8) whose status matches the boxes.',
    ];
    expect(discussion).toHaveLength(24);
    for (const sentence of discussion) {
      expect(looksLikeCodeLine(sentence), sentence).toBe(false);
    }
    const page = groupLines(discussion.map((text, index) => piece(text, 40, 80 + index * 36, 420)));
    const layout = layoutPage(page);
    expect(layout.skipped.some((block) => block.role === 'code')).toBe(false);
    expect(layout.blocks.every((block) => block.role === 'prose')).toBe(true);
    const painted = layout.blocks.map((block) => block.text).join('\n');
    for (const sentence of discussion) {
      expect(painted.includes(sentence.slice(0, 32)), sentence).toBe(true);
    }
  });

  it('keeps two-line English prose that wraps on pages; / forms; as prose, not code', () => {
    const lines = groupLines([
      piece('A translation that still does not fit is offered on two', 40, 100, 260),
      piece('pages;', 40, 112, 40),
      piece('The GPU path packs short blocks into one of several', 40, 140, 250),
      piece('forms;', 40, 152, 40),
      piece('A following paragraph continues in the body face.', 40, 180, 240),
    ]);
    const layout = layoutPage(lines);
    expect(layout.skipped.some((block) => block.role === 'code')).toBe(false);
    expect(layout.blocks.some((block) => block.text.includes('pages;'))).toBe(true);
    expect(layout.blocks.some((block) => block.text.includes('forms;'))).toBe(true);
    expect(layout.blocks.every((block) => block.role === 'prose')).toBe(true);
  });

  it('keeps paper.pdf page 1 at one code block and page 3 bibliography as prose', async () => {
    const bytes = new Uint8Array(await readFile(resolve(root, 'bench/pdf/paper.pdf')));
    const document = await openPdfBytes(bytes);
    try {
      const first = (await document.getPage(1)) as PdfPage;
      const extractedFirst = await extractPage(first, 0, null);
      const layoutFirst = layoutPage(extractedFirst.lines, extractedFirst.figures, {
        width: extractedFirst.width,
        height: extractedFirst.height,
        index: 0,
      });
      expect(layoutFirst.skipped.filter((block) => block.role === 'code')).toHaveLength(1);

      const page = (await document.getPage(3)) as PdfPage;
      const extracted = await extractPage(page, 2, null);
      const layout = layoutPage(extracted.lines, extracted.figures, {
        width: extracted.width,
        height: extracted.height,
        index: 2,
      });
      const codeBlocks = layout.skipped.filter((block) => block.role === 'code');
      expect(codeBlocks).toHaveLength(0);
      expect(layout.blocks).toHaveLength(6);
      const three = layout.blocks.find((block) => block.text.includes('[3]'));
      const six = layout.blocks.find((block) => block.text.includes('[6]'));
      expect(three?.role).toBe('prose');
      expect(six?.role).toBe('prose');
    } finally {
      await document.destroy();
    }
  });

  it('matches the round 16–22 prose and listing corpus, line by line and as a block', () => {
    expect(LISTING_LINES.filter((entry) => entry.code).length).toBeGreaterThanOrEqual(16);
    expect(LC_NUMBERED_PROSE).toHaveLength(10);
    expect(DISCUSSION_PROSE.length).toBeGreaterThanOrEqual(18);
    expect(BIG_PROSE).toHaveLength(27);
    expect(CITE_RICH_PROSE.length).toBeGreaterThanOrEqual(18);
    expect(NUMBERED_CODE.length).toBeGreaterThanOrEqual(9);
    expect(ENUM_SEMI_PROSE.length).toBeGreaterThanOrEqual(5);
    expect(LEGEND_PROSE.length).toBeGreaterThanOrEqual(6);

    const compact = (value: string): string => value.replace(/\s+/gu, ' ').trim();
    for (const entry of CODE_LINE_CORPUS) {
      expect(looksLikeCodeLine(entry.text), `${entry.tag}: ${entry.text}`).toBe(entry.code);
      const page = groupLines([piece(entry.text, 40, 100, Math.min(420, entry.text.length * 6))]);
      const layout = layoutPage(page);
      const skipped = layout.skipped.filter((block) => block.role === 'code');
      const painted = [...layout.blocks, ...layout.skipped];
      const compactText = compact(entry.text);
      const needle = compactText.length < 24 ? compactText : compactText.slice(0, 24);
      const hit = painted.find((block) => compact(block.text).includes(needle));
      const paintedSummary = painted
        .map((block) => `${block.role}:${JSON.stringify(compact(block.text))}`)
        .join(' | ');
      const where = `${entry.tag}: expected ${entry.role} for ${JSON.stringify(entry.text)}; needle=${JSON.stringify(needle)}; painted=[${paintedSummary}]`;
      if (entry.code) {
        expect(skipped.length, where).toBeGreaterThan(0);
        expect(hit, `${where} (missing hit)`).toBeTruthy();
        expect(hit?.role, where).toBe('code');
      } else {
        expect(skipped, where).toHaveLength(0);
        expect(hit, `${where} (missing hit)`).toBeTruthy();
        expect(hit?.role, where).toBe(entry.role);
      }
    }
  });

  it('keeps discussion, big-prose, cite-rich, lowercase-numbered, enum-semi, and legend pages free of code', () => {
    const pages = [
      DISCUSSION_PROSE,
      BIG_PROSE,
      CITE_RICH_PROSE,
      LC_NUMBERED_PROSE,
      ENUM_SEMI_PROSE,
      LEGEND_PROSE,
    ];
    for (const corpus of pages) {
      const page = groupLines(
        corpus.map((entry, index) => piece(entry.text, 40, 80 + index * 40, 420)),
      );
      const layout = layoutPage(page);
      expect(layout.skipped.filter((block) => block.role === 'code')).toHaveLength(0);
      expect(layout.blocks.every((block) => block.role !== 'code')).toBe(true);
    }
  });

  it('keeps a page of numbered listings with commas and brackets as code', () => {
    const page = groupLines(
      NUMBERED_CODE.map((entry, index) => piece(entry.text, 80, 80 + index * 16, 280)),
    );
    const layout = layoutPage(page);
    const codeBlocks = layout.skipped.filter((block) => block.role === 'code');
    expect(codeBlocks.length).toBeGreaterThan(0);
    const compact = (value: string): string => value.replace(/\s+/gu, ' ').trim();
    const joined = [
      ...codeBlocks.map((block) => block.text),
      ...layout.blocks.map((block) => block.text),
    ]
      .map(compact)
      .join('\n');
    for (const entry of NUMBERED_CODE) {
      expect(joined.includes(compact(entry.text)), entry.tag).toBe(true);
    }
    expect(layout.blocks.every((block) => block.role !== 'code')).toBe(true);
    const painted = layout.blocks.map((block) => compact(block.text)).join('\n');
    for (const entry of NUMBERED_CODE) {
      expect(painted.includes(compact(entry.text)), entry.tag).toBe(false);
    }
  });
});
