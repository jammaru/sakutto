// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { OcrQuad, OcrRegion, OcrResult, ReadingLine } from '@/engine/ocr/types';
import { compareReadingOrder, layoutPage, type LayoutBlock } from '@/pdf/layout';
import { groupLines, lineFrom } from '@/pdf/lines';
import { metricsPass, pageMetrics } from '@/pdf/metrics';
import { ocrResultToPageLayout, ocrResultToTextLines } from '@/pdf/ocr';
import { protectInlineMath, restoreInlineMath } from '@/pdf/protect';
import { paintIntegrityMetrics, placePage } from '@/pdf/place';
import { PdfReader } from '@/pdf/reader';
import type { BlockState } from '@/pdf/session';
import { stubExpand } from '@/pdf/stub';
import { measure, piece } from './support/pdf-pieces';

function quad(x: number, y: number, width: number, height: number): OcrQuad {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function region(text: string, bounds: OcrQuad): OcrRegion {
  return {
    quad: bounds,
    confidence: 0.95,
    vertical: false,
    text,
    recognitionConfidence: 0.9,
    symbolScores: [0.9],
  };
}

function readingLine(items: readonly OcrRegion[]): ReadingLine<OcrRegion> {
  return { orientation: 'horizontal', items, indices: items.map((_, index) => index) };
}

function ocrResult(items: readonly OcrRegion[]): OcrResult {
  return {
    regions: [...items],
    lines: [readingLine(items)],
    text: items.map((i) => i.text).join(' '),
  };
}

describe('latest DSH review blockers', () => {
  it('B1: keeps a two-piece full-width sentence whole at a 10pt word gap', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const items = [
      region('This sentence continues with a normal', quad(45, 100, 250, 20)),
      region('word gap in a single column line.', quad(305, 100, 250, 20)),
    ];
    const result = ocrResult(items);
    const full = 'This sentence continues with a normal word gap in a single column line.';

    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([full]);
    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.map((block) => block.text)).toEqual([full]);
    expect(layout.blocks.map((block) => block.column)).toEqual([0]);
  });

  it('B1: keeps a centred two-piece title with a 20pt gap on one line', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const items = [
      region('Short Paper', quad(120, 100, 160, 20)),
      region('Title Here', quad(300, 100, 160, 20)),
    ];
    const result = ocrResult(items);
    const full = 'Short Paper Title Here';

    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([full]);
    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.map((block) => block.text)).toEqual([full]);
    expect(layout.skipped).toEqual([]);
  });

  it('B1: keeps a long two-piece title above a two-column body on one line', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const title = [
      region('Attention Is All You Need', quad(50, 60, 220, 20)),
      region('But This Title Has More Than Twelve Words', quad(280, 60, 270, 20)),
    ];
    const body = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on the same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: [...title, ...body.flat()],
      lines: [readingLine(title), ...body.map(readingLine)],
      text: '',
    };
    const full = 'Attention Is All You Need But This Title Has More Than Twelve Words';
    const lines = ocrResultToTextLines(result, options);

    expect(lines[0]?.text).toBe(full);
    expect(lines[0]?.columnHint).toBeUndefined();
    expect(lines.filter((line) => line.columnHint === 0)).toHaveLength(2);
    expect(lines.filter((line) => line.columnHint === 1)).toHaveLength(2);
    expect(lines.map((line) => line.text)).not.toContain(
      'But This Title Has More Than Twelve Words',
    );

    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks[0]?.text).toBe(full);
    expect(layout.blocks.filter((block) => block.text.includes('But This Title'))).toHaveLength(1);
    expect(layout.blocks.map((block) => block.text)).not.toContain(
      'But This Title Has More Than Twelve Words',
    );
  });

  it('B1: merges a scientific title above body when the first half exceeds 8 words', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const title = [
      region('mRNA vaccines are highly effective and generally safe for', quad(45, 60, 250, 20)),
      region('Older Adults', quad(305, 60, 250, 20)),
    ];
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on the same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: [...title, ...bodyRows.flat()],
      lines: [readingLine(title), ...bodyRows.map(readingLine)],
      text: '',
    };
    const full = 'mRNA vaccines are highly effective and generally safe for Older Adults';

    const lines = ocrResultToTextLines(result, options);
    expect(lines[0]?.text).toBe(full);
    expect(lines[0]?.columnHint).toBeUndefined();

    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks[0]?.text).toBe(full);
    expect(layout.blocks.filter((block) => block.text.includes('Older Adults'))).toHaveLength(1);
    expect(layout.skipped).toEqual([]);
  });

  it('B1: merges a scientific title above body when the tail exceeds 6 words', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const title = [
      region('mRNA vaccines are effective', quad(45, 60, 250, 20)),
      region('In Older Adults with Type 2 Diabetes', quad(305, 60, 250, 20)),
    ];
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on the same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: [...title, ...bodyRows.flat()],
      lines: [readingLine(title), ...bodyRows.map(readingLine)],
      text: '',
    };
    const full = 'mRNA vaccines are effective In Older Adults with Type 2 Diabetes';

    const lines = ocrResultToTextLines(result, options);
    expect(lines[0]?.text).toBe(full);
    expect(lines[0]?.columnHint).toBeUndefined();
    expect(
      lines.filter(
        (line) =>
          line.columnHint === 0 &&
          line.text.startsWith('mRNA vaccines are effective') &&
          line.text !== full,
      ),
    ).toHaveLength(0);

    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks[0]?.text).toBe(full);
    expect(layout.blocks.filter((block) => block.text.includes('Older Adults'))).toHaveLength(1);
    expect(layout.skipped).toEqual([]);
  });

  it('B2: keeps a sentence-case mRNA title whole above two-column body', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on that same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving two columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const title = [
      region('mRNA vaccines are effective', quad(45, 60, 250, 20)),
      region('In Older Adults', quad(305, 60, 250, 20)),
    ];
    const result: OcrResult = {
      regions: [...title, ...bodyRows.flat()],
      lines: [readingLine(title), ...bodyRows.map(readingLine)],
      text: '',
    };
    const full = 'mRNA vaccines are effective In Older Adults';
    expect(ocrResultToTextLines(result, options).map((line) => line.text)[0]).toBe(full);
  });

  it('B1: keeps a long scientific title above two-column body whole on one line', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const title = [
      region('mRNA vaccines are highly effective', quad(45, 60, 250, 20)),
      region('In Older Adults', quad(305, 60, 250, 20)),
    ];
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on the same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: [...title, ...bodyRows.flat()],
      lines: [readingLine(title), ...bodyRows.map(readingLine)],
      text: '',
    };
    const full = 'mRNA vaccines are highly effective In Older Adults';

    const lines = ocrResultToTextLines(result, options);
    expect(lines[0]?.text).toBe(full);
    expect(lines[0]?.columnHint).toBeUndefined();

    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.map((block) => block.text)).toContain(full);
    expect(layout.blocks.filter((block) => block.text.includes('Older Adults'))).toHaveLength(1);
    expect(layout.skipped).toEqual([]);
  });

  it.each([
    'In Older Adults without Vaccination',
    'In Older Adults during Winter',
    'In Older Adults between Trials',
  ])('B2: keeps a scientific title with tail %s whole above two-column body', (tail) => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const title = [
      region('mRNA vaccines are effective', quad(45, 60, 250, 20)),
      region(tail, quad(305, 60, 250, 20)),
    ];
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on the same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: [...title, ...bodyRows.flat()],
      lines: [readingLine(title), ...bodyRows.map(readingLine)],
      text: '',
    };
    const full = 'mRNA vaccines are effective ' + tail;

    const lines = ocrResultToTextLines(result, options);
    expect(lines[0]?.text).toBe(full);
    expect(lines[0]?.columnHint).toBeUndefined();

    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.map((block) => block.text)).toContain(full);
    expect(layout.skipped).toEqual([]);
  });

  it('B2: keeps an mRNA title without a colon whole on one line', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const items = [
      region('mRNA Vaccine Design', quad(45, 60, 250, 20)),
      region('From Bench to Bedside', quad(305, 60, 250, 20)),
    ];
    const result = ocrResult(items);
    const full = 'mRNA Vaccine Design From Bench to Bedside';
    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([full]);
  });

  it('B2: keeps an mRNA title whole above two-column body', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const bodyRows = [
      [
        region('Machine translation of web pages is usually a', quad(45, 100, 250, 20)),
        region('client of a remote service in this browser', quad(305, 100, 250, 20)),
      ],
      [
        region('The extension runs the model on the local device', quad(45, 130, 250, 20)),
        region('and keeps the page text inside the browser', quad(305, 130, 250, 20)),
      ],
    ];
    const title = [
      region('mRNA Vaccine Design', quad(45, 60, 250, 20)),
      region('From Bench to Bedside', quad(305, 60, 250, 20)),
    ];
    const result: OcrResult = {
      regions: [...title, ...bodyRows.flat()],
      lines: [readingLine(title), ...bodyRows.map(readingLine)],
      text: '',
    };
    const full = 'mRNA Vaccine Design From Bench to Bedside';
    expect(ocrResultToTextLines(result, options).map((line) => line.text)[0]).toBe(full);
  });

  it('B1: does not treat camelCase body rows as titles on a two-column page', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const bodyRows = [
      [
        region('mRNA expression levels are', quad(45, 100, 250, 20)),
        region('The model is trained on this data', quad(305, 100, 250, 20)),
      ],
      [
        region('mRNA expression levels are high in', quad(45, 120, 250, 20)),
        region('The model is trained on this data', quad(305, 120, 250, 20)),
      ],
      [
        region('eDNA samples were collected from', quad(45, 130, 250, 20)),
        region('The results show a strong signal', quad(305, 130, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: bodyRows.flat(),
      lines: bodyRows.map(readingLine),
      text: '',
    };
    const lines = ocrResultToTextLines(result, options);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.map((line) => line.text)).toContain('mRNA expression levels are high in');
    expect(lines.map((line) => line.text)).toContain('The model is trained on this data');
  });

  it.each([
    ['mRNA vaccines reduce', 'Severe disease in older adults'],
    ['CRISPR editing enables', 'The precise repair of genes'],
  ])('B2: column-splits scientific prose %s | %s', (left, right) => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on the same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const scientific = [
      region(left, quad(45, 140, 250, 20)),
      region(right, quad(305, 140, 250, 20)),
    ];
    const result: OcrResult = {
      regions: [...scientific, ...bodyRows.flat()],
      lines: [readingLine(scientific), ...bodyRows.map(readingLine)],
      text: '',
    };

    const lines = ocrResultToTextLines(result, options);
    const split = lines.filter((line) => line.text === left || line.text === right);
    expect(split).toHaveLength(2);
    expect(split.find((line) => line.text === left)?.columnHint).toBe(0);
    expect(split.find((line) => line.text === right)?.columnHint).toBe(1);
    expect(lines.map((line) => line.text)).not.toContain(`${left} ${right}`);

    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.some((block) => block.box.width >= 500)).toBe(false);
    expect(layout.blocks.some((block) => block.text === `${left} ${right}`)).toBe(false);
  });

  it('B2: splits a scientific colon body row on a two-column page', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on that same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving two columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const colonBody = [
      region('mRNA expression levels: x', quad(45, 200, 250, 20)),
      region('The model is trained on this data', quad(305, 200, 250, 20)),
    ];
    const result: OcrResult = {
      regions: [...bodyRows.flat(), ...colonBody],
      lines: [...bodyRows.map(readingLine), readingLine(colonBody)],
      text: '',
    };
    const lines = ocrResultToTextLines(result, options).map((line) => line.text);
    expect(lines).toContain('mRNA expression levels: x');
    expect(lines).toContain('The model is trained on this data');
    expect(lines).not.toContain('mRNA expression levels: x The model is trained on this data');
  });

  it('B2: splits notation-with-colon body rows on a two-column page', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on that same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving two columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const colonBody = [
      region('we use the notation: X', quad(45, 200, 250, 20)),
      region('The model is trained on this data', quad(305, 200, 250, 20)),
    ];
    const result: OcrResult = {
      regions: [...bodyRows.flat(), ...colonBody],
      lines: [...bodyRows.map(readingLine), readingLine(colonBody)],
      text: '',
    };
    const lines = ocrResultToTextLines(result, options).map((line) => line.text);
    expect(lines).toContain('we use the notation: X');
    expect(lines).toContain('The model is trained on this data');
    expect(lines).not.toContain('we use the notation: X The model is trained on this data');
  });

  it('B2: splits a colon body row on a two-column page', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on that same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving two columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const colonBody = [
      region('we use the following notation: x', quad(45, 200, 250, 20)),
      region('The model is trained on this data', quad(305, 200, 250, 20)),
    ];
    const result: OcrResult = {
      regions: [...bodyRows.flat(), ...colonBody],
      lines: [...bodyRows.map(readingLine), readingLine(colonBody)],
      text: '',
    };
    const lines = ocrResultToTextLines(result, options).map((line) => line.text);
    expect(lines).toContain('we use the following notation: x');
    expect(lines).toContain('The model is trained on this data');
    expect(lines).not.toContain(
      'we use the following notation: x The model is trained on this data',
    );
  });

  it('B2: keeps a lowercase-prefixed colon title whole on one line', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const items = [
      region('mRNA Vaccine Design: From', quad(45, 60, 250, 20)),
      region('Bench to Bedside', quad(305, 60, 250, 20)),
    ];
    const result = ocrResult(items);
    const full = 'mRNA Vaccine Design: From Bench to Bedside';
    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([full]);
    expect(ocrResultToPageLayout(result, options).blocks.map((block) => block.text)).toEqual([
      full,
    ]);
  });

  it('B2: keeps a two-piece title with U.S. whole on one line', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const items = [
      region('U.S. Policy for On-Device', quad(45, 60, 250, 20)),
      region('OCR in Modern Web Browsers', quad(305, 60, 250, 20)),
    ];
    const result = ocrResult(items);
    const full = 'U.S. Policy for On-Device OCR in Modern Web Browsers';
    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([full]);
    expect(ocrResultToPageLayout(result, options).blocks.map((block) => block.text)).toEqual([
      full,
    ]);
  });

  it('B2: keeps a two-piece title with Node.js whole on one line', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const items = [
      region('On-Device Translation with Node.js', quad(45, 60, 250, 20)),
      region('In Modern Browser Extensions', quad(305, 60, 250, 20)),
    ];
    const result = ocrResult(items);
    const full = 'On-Device Translation with Node.js In Modern Browser Extensions';
    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([full]);
    expect(ocrResultToPageLayout(result, options).blocks.map((block) => block.text)).toEqual([
      full,
    ]);
  });

  it('B2: keeps two full-width sentence rows whole on a single-column page', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const row1 = [
      region('This paper studies on-device machine translation of scanned', quad(45, 100, 250, 20)),
      region('documents in the browser without sending text to a server.', quad(305, 100, 250, 20)),
    ];
    const row2 = [
      region('We describe the layout reconstruction pipeline and evaluate', quad(45, 130, 250, 20)),
      region('its reading order and overlay quality on real PDF pages.', quad(305, 130, 250, 20)),
    ];
    const result: OcrResult = {
      regions: [...row1, ...row2],
      lines: [readingLine(row1), readingLine(row2)],
      text: '',
    };
    const lines = ocrResultToTextLines(result, options).map((line) => line.text);
    expect(lines).toEqual([
      'This paper studies on-device machine translation of scanned documents in the browser without sending text to a server.',
      'We describe the layout reconstruction pipeline and evaluate its reading order and overlay quality on real PDF pages.',
    ]);
  });

  it('B2: keeps a long two-region title whole', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const items = [
      region('Attention Is All You Need', quad(50, 60, 220, 20)),
      region('But This Title Has More Than Twelve Words', quad(280, 60, 270, 20)),
    ];
    const result = ocrResult(items);
    const full = 'Attention Is All You Need But This Title Has More Than Twelve Words';

    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([full]);
    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.map((block) => block.text)).toEqual([full]);
  });

  it('B2: wide two-region title rows are not two-column evidence', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const titleRows = [
      [
        region('Attention Is All You Need', quad(50, 60, 220, 20)),
        region('But This Title Has More Than Twelve Words', quad(280, 60, 270, 20)),
      ],
      [
        region('Another Long Title With Many Words', quad(50, 90, 220, 20)),
        region('That Still Spans The Full Page Width', quad(280, 90, 270, 20)),
      ],
    ];
    const body = region(
      'A single column body line with an ordinary word gap here.',
      quad(45, 140, 500, 20),
    );
    const result: OcrResult = {
      regions: [...titleRows.flat(), body],
      lines: [...titleRows.map(readingLine), readingLine([body])],
      text: '',
    };
    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
      'Attention Is All You Need But This Title Has More Than Twelve Words',
      'Another Long Title With Many Words That Still Spans The Full Page Width',
      body.text,
    ]);
  });

  it('B2: a two-piece title with a colon survives two-column page evidence', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const title = [
      region('Attention Is All You Need:', quad(45, 60, 250, 20)),
      region('A Study of Long Context Windows', quad(305, 60, 250, 20)),
    ];
    const body = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on that same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving two columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: [...title, ...body.flat()],
      lines: [readingLine(title), ...body.map(readingLine)],
      text: '',
    };
    const lines = ocrResultToTextLines(result, options);
    expect(lines[0]?.text).toBe('Attention Is All You Need: A Study of Long Context Windows');
    expect(lines[0]?.columnHint).toBeUndefined();
  });

  it('B1: a decimal point does not make a full-width sentence two columns', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const items = [
      region('The score increased from 3.2', quad(45, 100, 250, 20)),
      region('points in this single column line.', quad(305, 100, 250, 20)),
    ];
    const full = 'The score increased from 3.2 points in this single column line.';
    expect(ocrResultToTextLines(ocrResult(items), options).map((line) => line.text)).toEqual([
      full,
    ]);
  });

  it('B3: does not report a single-column full-width prose line as a cross-column cover', () => {
    const pageWidth = 595;
    const lines = groupLines([
      piece('This is the first half of the sentence', 45, 112, 240),
      piece('and this is the second half of it.', 292, 112, 258),
    ]);
    const layout = layoutPage(lines, undefined, { width: pageWidth, height: 800 });
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0]?.column).toBe(0);
    const placed = placePage({
      layout,
      translationOf: (block) => stubExpand(block.text),
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 800,
    });
    const metrics = pageMetrics(layout, placed, { x: 0, y: 0, width: pageWidth, height: 800 });
    expect(metrics.crossColumnCovers).toBe(0);
    expect(metricsPass(metrics)).toBe(true);
  });

  it('B3: a genuinely fused heading row is still a cross-column cover', () => {
    const pageWidth = 595;
    const text = 'Left half of a fused heading row right half of the same row';
    const block: LayoutBlock = {
      box: { x: 45, y: 100, width: 505, height: 24 },
      room: { x: 45, y: 100, width: 505, height: 24 },
      lines: [
        lineFrom([
          piece('Left half of a fused heading row', 45, 112, 205),
          piece('right half of the same row', 275, 112, 275),
        ]),
      ],
      text,
      role: 'heading',
      fontSize: 10,
      lineHeight: 1.2,
      align: 'left',
      bold: false,
      italic: false,
      column: 0,
      advance: 505,
      writing: 0,
    };
    const fit = {
      fits: true as const,
      fontSize: 10,
      lineHeight: 12,
      lines: ['横断する見出し'],
      height: 24,
      grown: false,
      width: 505,
    };
    const metrics = paintIntegrityMetrics(
      [
        {
          block,
          translation: '横断する見出し',
          fit,
          paint: true,
          drawn: { x: 45, y: 100, width: 505, height: 24 },
          overflow: false,
        },
      ],
      pageWidth,
    );
    expect(metrics.crossColumnCovers).toBe(1);
  });

  it('B5: a wide heading gap left of the gutter is not a cross-column cover', () => {
    // Native XY-cut gives the full-width heading column 0; its 20pt word gap is at x=175,
    // far left of the 595pt page gutter at ~291.55. Only a gap at the printed gutter counts.
    const pageWidth = 595;
    const block: LayoutBlock = {
      box: { x: 45, y: 100, width: 390, height: 22 },
      room: { x: 45, y: 100, width: 390, height: 22 },
      lines: [
        lineFrom([
          piece('Left half of heading', 45, 112, 120),
          piece('Right half of heading', 185, 112, 250),
        ]),
      ],
      text: 'Left half of heading Right half of heading',
      role: 'heading',
      fontSize: 10,
      lineHeight: 1.2,
      align: 'left',
      bold: false,
      italic: false,
      column: 0,
      advance: 390,
      writing: 0,
    };
    const fit = {
      fits: true as const,
      fontSize: 10,
      lineHeight: 12,
      lines: ['横断する見出し'],
      height: 24,
      grown: false,
      width: 390,
    };
    const metrics = paintIntegrityMetrics(
      [
        {
          block,
          translation: '横断する見出し',
          fit,
          paint: true,
          drawn: { x: 45, y: 100, width: 390, height: 24 },
          overflow: false,
        },
      ],
      pageWidth,
    );
    expect(metrics.crossColumnCovers).toBe(0);
  });

  it('B5: a centred two-piece title with a 20pt gap is not a cross-column cover', () => {
    // The B1 title merge keeps both halves on one line. Their 20pt gap sits at the page
    // centre, so a gutter-width heuristic alone mistakes the title for a fused column row.
    const pageWidth = 595;
    const block: LayoutBlock = {
      box: { x: 120, y: 60, width: 340, height: 24 },
      room: { x: 120, y: 60, width: 340, height: 24 },
      lines: [lineFrom([piece('Short Paper', 120, 72, 160), piece('Title Here', 300, 72, 160)])],
      text: 'Short Paper Title Here',
      role: 'prose',
      fontSize: 12,
      lineHeight: 1.2,
      align: 'left',
      bold: false,
      italic: false,
      column: -1,
      advance: 340,
      writing: 0,
    };
    const fit = {
      fits: true as const,
      fontSize: 12,
      lineHeight: 14,
      lines: ['短い論文タイトル'],
      height: 24,
      grown: false,
      width: 340,
    };
    const metrics = paintIntegrityMetrics(
      [
        {
          block,
          translation: '短い論文タイトル',
          fit,
          paint: true,
          drawn: { x: 120, y: 60, width: 340, height: 24 },
          overflow: false,
        },
      ],
      pageWidth,
    );
    expect(metrics.crossColumnCovers).toBe(0);
  });

  it('B5: an OCR-merged centred title keeps the spanning exemption in page metrics', () => {
    const options = { pageIndex: 0, pageWidth: 595, pageHeight: 800 };
    const title = [
      region('Short Paper', quad(120, 60, 160, 20)),
      region('Title Here', quad(300, 60, 160, 20)),
    ];
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 240, 20)),
        region('Right column prose on the same printed row.', quad(305, 140, 240, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 240, 20)),
        region('A second right column line proving columns.', quad(305, 170, 240, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: [...title, ...bodyRows.flat()],
      lines: [readingLine(title), ...bodyRows.map(readingLine)],
      text: '',
    };
    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks[0]?.text).toBe('Short Paper Title Here');
    expect(layout.blocks[0]?.column).toBe(-1);

    const placed = placePage({
      layout,
      translationOf: (block) => stubExpand(block.text),
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 800,
    });
    const metrics = pageMetrics(layout, placed, { x: 0, y: 0, width: 595, height: 800 });
    expect(metrics.crossColumnCovers).toBe(0);
  });

  it('B5: a long OCR-merged title above body is not a cross-column cover', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const title = [
      region('mRNA vaccines are highly effective and generally safe for', quad(45, 60, 250, 20)),
      region('Older Adults', quad(305, 60, 250, 20)),
    ];
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on the same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: [...title, ...bodyRows.flat()],
      lines: [readingLine(title), ...bodyRows.map(readingLine)],
      text: '',
    };
    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks[0]?.text).toBe(
      'mRNA vaccines are highly effective and generally safe for Older Adults',
    );
    expect(layout.blocks[0]?.titleRow).toBe(true);

    const placed = placePage({
      layout,
      translationOf: (block) => stubExpand(block.text),
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 800,
    });
    const metrics = pageMetrics(layout, placed, { x: 0, y: 0, width: 600, height: 800 });
    expect(metrics.crossColumnCovers).toBe(0);
  });

  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
      permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
        item,
        ...rest,
      ]),
    );
  }

  type BilingualElement = {
    bilingual: HTMLElement;
    bilingualRows: Map<object, HTMLElement>;
  };

  function block(
    text: string,
    x: number,
    y: number,
    column: number,
    width = column < 0 ? 510 : 100,
  ): LayoutBlock {
    return { text, box: { x, y, width, height: 20 }, column, writing: 0 } as LayoutBlock;
  }

  it('B1: does not merge uppercase two-column body rows as a title', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const bodyRows = [
      [
        region('Machine translation of web pages is usually a', quad(45, 100, 250, 20)),
        region('client of a remote service in this browser', quad(305, 100, 250, 20)),
      ],
      [
        region('The extension runs the model on the local device', quad(45, 130, 250, 20)),
        region('and keeps the page text inside the browser', quad(305, 130, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: bodyRows.flat(),
      lines: bodyRows.map(readingLine),
      text: '',
    };
    const lines = ocrResultToTextLines(result, options);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.filter((line) => line.columnHint === 1).length).toBeGreaterThanOrEqual(2);
  });

  it('B1: splits two-piece rows on a two-column page at the gutter', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const bodyRows = [
      [
        region('machine translation of web pages is usually a', quad(45, 100, 250, 20)),
        region('client of a remote service in this browser', quad(305, 100, 250, 20)),
      ],
      [
        region('the extension runs the model on the local device', quad(45, 130, 250, 20)),
        region('and keeps the page text inside the browser', quad(305, 130, 250, 20)),
      ],
      [
        region('this paper describes a browser extension that', quad(45, 160, 250, 20)),
        region('translates pages without sending them to a server', quad(305, 160, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: bodyRows.flat(),
      lines: bodyRows.map(readingLine),
      text: '',
    };
    const lines = ocrResultToTextLines(result, options);
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(lines.filter((line) => line.columnHint === 0).length).toBeGreaterThanOrEqual(3);
    expect(lines.filter((line) => line.columnHint === 1).length).toBeGreaterThanOrEqual(3);
    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.some((block) => block.box.width >= 500)).toBe(false);
  });

  it('B2: keeps a Japanese two-region title whole on one line', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const items = [
      region('スキャンしたPDFの翻訳品質を改善する', quad(45, 100, 250, 20)),
      region('ための端末内OCRパイプライン', quad(305, 100, 250, 20)),
    ];
    const full = 'スキャンしたPDFの翻訳品質を改善する ための端末内OCRパイプライン';
    expect(ocrResultToTextLines(ocrResult(items), options).map((line) => line.text)).toEqual([
      full,
    ]);
  });

  it('B4: compareReadingOrder is a total order with a spanning block', () => {
    const leftTop = block('left-top', 45, 100, 0);
    const leftBottom = block('left-bottom', 45, 300, 0);
    const rightTop = block('right-top', 315, 100, 1);
    const spanning = block('spanning', 45, 200, -1, 100);
    const blocks = [leftBottom, rightTop, spanning, leftTop];
    const expected = ['left-top', 'spanning', 'left-bottom', 'right-top'];
    // A non-transitive comparator gives different results for different input orders.
    for (const permutation of permutations(blocks)) {
      const actual = [...permutation].sort(compareReadingOrder).map((b) => b.text);
      expect(actual, permutation.map((b) => b.text).join(',')).toEqual(expected);
    }
  });

  it('B4: paints bilingual rows with a spanning block at its reading position', () => {
    const reader = Object.create(PdfReader.prototype) as PdfReader;
    (reader as unknown as { target: string }).target = 'ja';
    const paint = (
      reader as unknown as {
        paintBilingual: (e: BilingualElement, s: readonly BlockState[]) => void;
      }
    ).paintBilingual.bind(reader);
    const leftTop = block('left-top', 45, 100, 0);
    const leftBottom = block('left-bottom', 45, 300, 0);
    const rightTop = block('right-top', 315, 100, 1);
    const spanning = block('spanning', 45, 200, -1, 100);
    const element: BilingualElement = {
      bilingual: document.createElement('div'),
      bilingualRows: new Map(),
    };
    paint(
      element,
      [leftBottom, rightTop, spanning, leftTop].map((b) => ({
        block: b,
        state: 'done',
        translation: '訳',
      })) as unknown as readonly BlockState[],
    );
    expect(
      [...element.bilingual.children].map((row) => row.firstElementChild?.textContent),
    ).toEqual(['left-top', 'right-top', 'spanning', 'left-bottom']);
  });

  it('B1: merges a scientific noun-phrase title above body without skipping its tail', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const title = [
      region('mRNA expression levels in older adults', quad(45, 60, 250, 20)),
      region('A Systematic Review', quad(305, 60, 250, 20)),
    ];
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on the same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: [...title, ...bodyRows.flat()],
      lines: [readingLine(title), ...bodyRows.map(readingLine)],
      text: '',
    };
    const full = 'mRNA expression levels in older adults A Systematic Review';

    const lines = ocrResultToTextLines(result, options);
    expect(lines[0]?.text).toBe(full);
    expect(lines[0]?.columnHint).toBeUndefined();
    expect(lines.map((line) => line.text)).not.toContain('A Systematic Review');

    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks[0]?.text).toBe(full);
    expect(layout.blocks.map((block) => block.text)).not.toContain('A Systematic Review');
    expect(layout.skipped).toEqual([]);
  });

  it('B1: merges a scientific verb title above body without skipping its tail', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const title = [
      region('mRNA vaccines reduce mortality', quad(45, 60, 250, 20)),
      region('In Older Adults', quad(305, 60, 250, 20)),
    ];
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on the same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: [...title, ...bodyRows.flat()],
      lines: [readingLine(title), ...bodyRows.map(readingLine)],
      text: '',
    };
    const full = 'mRNA vaccines reduce mortality In Older Adults';

    const lines = ocrResultToTextLines(result, options);
    expect(lines[0]?.text).toBe(full);
    expect(lines[0]?.columnHint).toBeUndefined();
    expect(lines.map((line) => line.text)).not.toContain('In Older Adults');

    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks[0]?.text).toBe(full);
    expect(layout.blocks.map((block) => block.text)).not.toContain('In Older Adults');
    expect(layout.skipped).toEqual([]);
  });

  it('B1: keeps a scientific body row in its column instead of merging it as a title', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const firstRow = [
      region('mRNA vaccines reduce', quad(45, 100, 250, 20)),
      region('Severe disease in older adults', quad(305, 100, 250, 20)),
    ];
    const bodyRows = [
      [
        region('Left column prose for the first printed row.', quad(45, 140, 250, 20)),
        region('Right column prose on the same printed row.', quad(305, 140, 250, 20)),
      ],
      [
        region('A second left column line proving two columns.', quad(45, 170, 250, 20)),
        region('A second right column line proving columns.', quad(305, 170, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: [...firstRow, ...bodyRows.flat()],
      lines: [readingLine(firstRow), ...bodyRows.map(readingLine)],
      text: '',
    };

    const lines = ocrResultToTextLines(result, options);
    expect(lines).toHaveLength(6);
    expect(lines.find((line) => line.text === 'mRNA vaccines reduce')?.columnHint).toBe(0);
    expect(lines.find((line) => line.text === 'Severe disease in older adults')?.columnHint).toBe(
      1,
    );
    expect(lines.some((line) => line.titleRow === true)).toBe(false);

    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.every((block) => block.box.width < 500)).toBe(true);
  });

  it('B2: splits short capitalised two-column body rows at a 10pt gutter', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const rows = [
      [
        region('Results show strong effects on', quad(45, 100, 250, 20)),
        region('mrna in treated mice', quad(305, 100, 250, 20)),
      ],
      [
        region('Further analysis confirms these findings', quad(45, 130, 250, 20)),
        region('across all measured groups', quad(305, 130, 250, 20)),
      ],
      [
        region('the treated cohort showed a', quad(45, 160, 250, 20)),
        region('clear response in every assay.', quad(305, 160, 250, 20)),
      ],
    ];
    const result: OcrResult = {
      regions: rows.flat(),
      lines: rows.map(readingLine),
      text: '',
    };

    const lines = ocrResultToTextLines(result, options);
    expect(lines.map((line) => line.text)).toEqual([
      'Results show strong effects on',
      'Further analysis confirms these findings',
      'the treated cohort showed a',
      'mrna in treated mice',
      'across all measured groups',
      'clear response in every assay.',
    ]);
    expect(lines.filter((line) => line.columnHint === 0)).toHaveLength(3);
    expect(lines.filter((line) => line.columnHint === 1)).toHaveLength(3);
    expect(lines.some((line) => line.titleRow === true)).toBe(false);

    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.some((block) => block.titleRow === true)).toBe(false);
    expect(layout.blocks.every((block) => block.box.width < 500)).toBe(true);
  });

  it('B2: a fused body block marked titleRow is still a cross-column cover', () => {
    const pageWidth = 600;
    const fusedRow = (y: number) =>
      lineFrom([
        piece('Results show strong effects on', 45, y + 12, 250),
        piece('mrna in treated mice', 305, y + 12, 250),
      ]);
    const block: LayoutBlock = {
      box: { x: 45, y: 100, width: 510, height: 52 },
      room: { x: 45, y: 100, width: 510, height: 52 },
      lines: [fusedRow(100), fusedRow(130)],
      text: 'Results show strong effects on mrna in treated mice Further analysis confirms these findings across all measured groups',
      role: 'prose',
      fontSize: 10,
      lineHeight: 1.2,
      align: 'left',
      bold: false,
      italic: false,
      column: -1,
      advance: 510,
      writing: 0,
      titleRow: true,
    };
    const placed = [
      {
        block,
        translation: '訳',
        fit: {
          fits: true as const,
          fontSize: 10,
          lineHeight: 12,
          lines: ['訳'],
          height: 24,
          grown: false,
          width: 510,
        },
        paint: true,
        drawn: { x: 45, y: 100, width: 510, height: 24 },
        overflow: false,
      },
    ];
    const metrics = pageMetrics(
      { blocks: [block], skipped: [] } as unknown as Parameters<typeof pageMetrics>[0],
      placed as unknown as Parameters<typeof pageMetrics>[1],
      { x: 0, y: 0, width: pageWidth, height: 800 },
    );
    expect(metrics.crossColumnCovers).toBeGreaterThanOrEqual(1);
    expect(metricsPass(metrics)).toBe(false);
  });

  it('B2: does not merge a narrow two-column body row with a short right fragment', () => {
    // The whole row is narrower than 60% of the page and its right column is only a short
    // fragment, so a width-only "centred heading" guess would keep it as one spanning title line.
    // The fragment's casing/script and the page's left margin must not change that: a capital, a
    // numeral or a CJK fragment is ordinary column text, and US Letter's 1-inch margin (72pt on
    // 612pt) is a left-aligned row, not a centred title (review 0ab8032 blocker 2).
    const scenarios = [
      {
        name: 'lowercase, 45pt margins',
        pageWidth: 600,
        pageHeight: 800,
        leftX: 45,
        rightX: 305,
        columnWidth: 250,
        rightWidth: 45,
        rightText: 'mice',
      },
      {
        name: 'capitalised fragment',
        pageWidth: 600,
        pageHeight: 800,
        leftX: 45,
        rightX: 305,
        columnWidth: 250,
        rightWidth: 45,
        rightText: 'Mice',
      },
      {
        name: 'numeric fragment',
        pageWidth: 600,
        pageHeight: 800,
        leftX: 45,
        rightX: 305,
        columnWidth: 250,
        rightWidth: 45,
        rightText: '42',
      },
      {
        name: 'compact CJK fragment',
        pageWidth: 600,
        pageHeight: 800,
        leftX: 45,
        rightX: 305,
        columnWidth: 250,
        rightWidth: 45,
        rightText: '结果',
      },
      {
        name: 'US Letter, 1-inch margins',
        pageWidth: 612,
        pageHeight: 792,
        leftX: 72,
        rightX: 312,
        columnWidth: 228,
        rightWidth: 118,
        rightText: 'mice and rats',
      },
    ] as const;

    for (const scenario of scenarios) {
      const { name, pageWidth, pageHeight, leftX, rightX, columnWidth, rightWidth, rightText } =
        scenario;
      const options = { pageIndex: 0, pageWidth, pageHeight };
      const corroborating = [
        [
          region('Left column prose for the first printed row.', quad(leftX, 100, columnWidth, 20)),
          region('Right column prose on the same printed row.', quad(rightX, 100, columnWidth, 20)),
        ],
        [
          region(
            'A second left column line proving two columns.',
            quad(leftX, 130, columnWidth, 20),
          ),
          region('A second right column line proving columns.', quad(rightX, 130, columnWidth, 20)),
        ],
      ];
      const narrow = [
        region('Results show strong effects on', quad(leftX, 200, columnWidth, 20)),
        region(rightText, quad(rightX, 200, rightWidth, 20)),
      ];
      const result: OcrResult = {
        regions: [...corroborating.flat(), ...narrow],
        lines: [...corroborating.map(readingLine), readingLine(narrow)],
        text: '',
      };
      const fused = `Results show strong effects on ${rightText}`;

      const lines = ocrResultToTextLines(result, options);
      expect(lines, name).toHaveLength(6);
      expect(
        lines.map((line) => line.text),
        name,
      ).toContain('Results show strong effects on');
      expect(
        lines.map((line) => line.text),
        name,
      ).toContain(rightText);
      expect(
        lines.map((line) => line.text),
        name,
      ).not.toContain(fused);
      expect(
        lines.find((line) => line.text === 'Results show strong effects on')?.columnHint,
        name,
      ).toBe(0);
      expect(lines.find((line) => line.text === rightText)?.columnHint, name).toBe(1);
      expect(
        lines.some((line) => line.titleRow === true),
        name,
      ).toBe(false);

      const layout = ocrResultToPageLayout(result, options);
      expect(
        layout.blocks.some((block) => block.titleRow === true),
        name,
      ).toBe(false);
      expect(
        layout.blocks.every((block) => block.box.width < 500),
        name,
      ).toBe(true);
      expect(
        layout.blocks.map((block) => block.text),
        name,
      ).not.toContain(fused);
      const leftEnd = leftX + columnWidth;
      for (const block of layout.blocks) {
        const crosses = block.room.x < leftEnd && block.room.x + block.room.width > rightX;
        expect(crosses, `${name}: ${block.text}`).toBe(false);
      }

      const placed = placePage({
        layout,
        translationOf: (block) => stubExpand(block.text),
        target: 'ja',
        measure: (_block, text, size) => measure(text, size),
        pageHeight,
      });
      const metrics = pageMetrics(layout, placed, {
        x: 0,
        y: 0,
        width: pageWidth,
        height: pageHeight,
      });
      expect(metrics.crossColumnCovers, name).toBe(0);
    }
  });
});

describe('2053d13 review blocker 2: centre guards on every title merge path', () => {
  const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
  const bodyRows = [
    [
      region('Left column prose for the first printed row.', quad(45, 100, 250, 20)),
      region('Right column prose on the same printed row.', quad(305, 100, 250, 20)),
    ],
    [
      region('A second left column line proving two columns.', quad(45, 130, 250, 20)),
      region('A second right column line proving columns.', quad(305, 130, 250, 20)),
    ],
  ];

  it.each([
    { name: 'scientific prefix', left: 'mRNA Vaccine Design', right: 'Older Adults' },
    { name: 'colon prefix', left: 'Key results:', right: 'Mice' },
  ])(
    'splits a $name row with a capital right fragment at a 10pt gutter',
    ({ name, left, right }) => {
      const narrow = [region(left, quad(45, 200, 250, 20)), region(right, quad(305, 200, 45, 20))];
      const result: OcrResult = {
        regions: [...bodyRows.flat(), ...narrow],
        lines: [...bodyRows.map(readingLine), readingLine(narrow)],
        text: '',
      };
      const fused = `${left} ${right}`;

      const lines = ocrResultToTextLines(result, options);
      expect(
        lines.map((line) => line.text),
        name,
      ).not.toContain(fused);
      expect(lines.find((line) => line.text === left)?.columnHint, name).toBe(0);
      expect(lines.find((line) => line.text === right)?.columnHint, name).toBe(1);
      expect(
        lines.some((line) => line.titleRow === true),
        name,
      ).toBe(false);

      const layout = ocrResultToPageLayout(result, options);
      expect(
        layout.blocks.map((block) => block.text),
        name,
      ).not.toContain(fused);
      expect(
        layout.blocks.every((block) => block.box.width < 500),
        name,
      ).toBe(true);
      const placed = placePage({
        layout,
        translationOf: (block) => stubExpand(block.text),
        target: 'ja',
        measure: (_block, text, size) => measure(text, size),
        pageHeight: options.pageHeight,
      });
      const metrics = pageMetrics(layout, placed, {
        x: 0,
        y: 0,
        width: options.pageWidth,
        height: options.pageHeight,
      });
      expect(metrics.crossColumnCovers, name).toBe(0);
    },
  );

  it('still merges a centred row with a capital right fragment', () => {
    for (const [left, right] of [
      ['mRNA Vaccine Design', 'Older Adults'],
      ['Key results:', 'Mice'],
    ] as const) {
      const centred = [
        region(left, quad(190, 200, 120, 20)),
        region(right, quad(320, 200, 45, 20)),
      ];
      const result: OcrResult = {
        regions: centred,
        lines: [readingLine(centred)],
        text: '',
      };
      const lines = ocrResultToTextLines(result, options);
      expect(lines.map((line) => line.text)).toEqual([`${left} ${right}`]);
      expect(lines[0]?.columnHint).toBeUndefined();
    }
  });

  // A wide centred section title between two-column body rows must not inherit the 60%
  // width cap of the short-centred-heading rule. Its own balanced page margins are the
  // centring evidence, even though a 10pt gap sits over the body gutter.
  it.each([
    {
      name: 'scientific prefix',
      left: 'mRNA Vaccine Design in',
      right: 'Older Adults and Children',
    },
    {
      name: 'colon prefix',
      left: 'Key results from the trial:',
      right: 'Older Adults and Children',
    },
  ])(
    'merges a 65%-wide centred $name title between two-column body rows',
    ({ name, left, right }) => {
      const bodyBelow = [
        [
          region('Left column prose after the title.', quad(45, 300, 250, 20)),
          region('Right column prose after the title.', quad(305, 300, 250, 20)),
        ],
        [
          region('Another left column line below the title.', quad(45, 330, 250, 20)),
          region('Another right column line below the title.', quad(305, 330, 250, 20)),
        ],
      ];
      // 105..495 = 390pt = 65% of the page width, with equal 105pt margins.
      const title = [region(left, quad(105, 200, 200, 20)), region(right, quad(315, 200, 180, 20))];
      const result: OcrResult = {
        regions: [...bodyRows.flat(), ...title, ...bodyBelow.flat()],
        lines: [...bodyRows.map(readingLine), readingLine(title), ...bodyBelow.map(readingLine)],
        text: '',
      };
      const fused = `${left} ${right}`;

      const lines = ocrResultToTextLines(result, options);
      expect(
        lines.map((line) => line.text),
        name,
      ).toContain(fused);
      const titleLine = lines.find((line) => line.text === fused);
      expect(titleLine?.columnHint, name).toBeUndefined();
      expect(titleLine?.titleRow, name).toBe(true);

      const layout = ocrResultToPageLayout(result, options);
      const block = layout.blocks.find((candidate) => candidate.text === fused);
      expect(block, name).toBeDefined();
      expect(block?.titleRow, name).toBe(true);
      expect(block?.column, name).toBeLessThan(0);
    },
  );
});

describe('9a60966 review blockers: combined regression suite', () => {
  const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
  const bodyAbove = [
    [
      region('Left column prose for the first printed row.', quad(45, 100, 250, 20)),
      region('Right column prose on the same printed row.', quad(305, 100, 250, 20)),
    ],
    [
      region('A second left column line proving two columns.', quad(45, 130, 250, 20)),
      region('A second right column line proving columns.', quad(305, 130, 250, 20)),
    ],
  ];
  const bodyBelow = [
    [
      region('Left column prose after the title.', quad(45, 300, 250, 20)),
      region('Right column prose after the title.', quad(305, 300, 250, 20)),
    ],
    [
      region('Another left column line below the title.', quad(45, 330, 250, 20)),
      region('Another right column line below the title.', quad(305, 330, 250, 20)),
    ],
  ];
  function pageWithMiddleRow(middle: readonly OcrRegion[]): OcrResult {
    const rows = [...bodyAbove, middle, ...bodyBelow];
    return { regions: rows.flat(), lines: rows.map(readingLine), text: '' };
  }

  it.each([
    {
      name: 'scientific heading',
      left: 'mRNA Vaccine Design in',
      right: 'Older Adults and Children',
    },
    {
      name: 'colon heading',
      left: 'Key results from the trial:',
      right: 'Older Adults and Children',
    },
  ])('merges a 65%-wide centred $name between two-column body rows', ({ name, left, right }) => {
    // 105..495 = 390pt = 65% of the page, with equal 105pt margins. Body rows sit both above
    // and below it, so only the heading's own size/margins can prove it is not a body row.
    const heading = [region(left, quad(105, 200, 200, 20)), region(right, quad(315, 200, 180, 20))];
    const result = pageWithMiddleRow(heading);
    const fused = `${left} ${right}`;

    const lines = ocrResultToTextLines(result, options);
    expect(
      lines.filter((line) => line.text === fused),
      name,
    ).toHaveLength(1);
    const titleLine = lines.find((line) => line.text === fused);
    expect(titleLine?.columnHint, name).toBeUndefined();
    expect(titleLine?.titleRow, name).toBe(true);
    expect(
      lines.filter((line) => line.text === right),
      name,
    ).toHaveLength(0);

    const layout = ocrResultToPageLayout(result, options);
    const block = layout.blocks.find((candidate) => candidate.text === fused);
    expect(block, name).toBeDefined();
    expect(block?.column, name).toBeLessThan(0);
    expect(block?.titleRow, name).toBe(true);
    expect(
      layout.blocks.some((candidate) => candidate.text === right),
      name,
    ).toBe(false);
  });

  it.each([
    { name: '85%', leftX: 45, leftWidth: 250, rightX: 305, rightWidth: 250 },
    { name: '75%', leftX: 75, leftWidth: 225, rightX: 315, rightWidth: 210 },
    { name: '90%', leftX: 30, leftWidth: 265, rightX: 305, rightWidth: 265 },
  ])(
    'splits a $name-wide colon body row between two-column body rows',
    ({ name, leftX, leftWidth, rightX, rightWidth }) => {
      const left = 'The results are as follows:';
      const right = 'and the second column text continues here now';
      const result = pageWithMiddleRow([
        region(left, quad(leftX, 200, leftWidth, 20)),
        region(right, quad(rightX, 200, rightWidth, 20)),
      ]);

      const lines = ocrResultToTextLines(result, options);
      expect(lines.find((line) => line.text === left)?.columnHint, name).toBe(0);
      expect(lines.find((line) => line.text === right)?.columnHint, name).toBe(1);
      expect(
        lines.map((line) => line.text),
        name,
      ).not.toContain(`${left} ${right}`);
      expect(
        lines.some((line) => line.titleRow === true),
        name,
      ).toBe(false);

      const layout = ocrResultToPageLayout(result, options);
      expect(
        layout.blocks.some((block) => block.text === `${left} ${right}`),
        name,
      ).toBe(false);
      expect(
        layout.blocks.some((block) => block.titleRow === true),
        name,
      ).toBe(false);
      expect(
        layout.blocks.every((block) => block.box.width < 500),
        name,
      ).toBe(true);
    },
  );

  it('splits the reported colon body row with two-column body rows above', () => {
    const left = 'The results are as follows:';
    const right = 'and the second column text continues here now';
    const colonBody = [
      region(left, quad(45, 200, 250, 20)),
      region(right, quad(305, 200, 250, 20)),
    ];
    const result: OcrResult = {
      regions: [...bodyAbove.flat(), ...colonBody],
      lines: [...bodyAbove.map(readingLine), readingLine(colonBody)],
      text: '',
    };

    const lines = ocrResultToTextLines(result, options);
    expect(lines.find((line) => line.text === left)?.columnHint).toBe(0);
    expect(lines.find((line) => line.text === right)?.columnHint).toBe(1);
    expect(lines.map((line) => line.text)).not.toContain(`${left} ${right}`);
    expect(lines.some((line) => line.titleRow === true)).toBe(false);
    expect(
      ocrResultToPageLayout(result, options).blocks.some((block) => block.titleRow === true),
    ).toBe(false);
  });

  it('keeps a wide-gap title above two-column body whole on one line', () => {
    const title = [
      region('Attention Is All You Need', quad(50, 60, 220, 20)),
      region('But This Title Has More Than Twelve Words', quad(280, 60, 270, 20)),
    ];
    const result: OcrResult = {
      regions: [...title, ...bodyAbove.flat()],
      lines: [readingLine(title), ...bodyAbove.map(readingLine)],
      text: '',
    };
    const fused = 'Attention Is All You Need But This Title Has More Than Twelve Words';

    const lines = ocrResultToTextLines(result, options);
    expect(lines[0]?.text).toBe(fused);
    expect(lines[0]?.columnHint).toBeUndefined();
    expect(
      lines.filter((line) => line.text === 'But This Title Has More Than Twelve Words'),
    ).toEqual([]);
  });

  it('column-splits the scientific body row mRNA vaccines reduce | Severe disease in older adults', () => {
    const [left, right] = ['mRNA vaccines reduce', 'Severe disease in older adults'] as const;
    const scientific = [
      region(left, quad(45, 200, 250, 20)),
      region(right, quad(305, 200, 250, 20)),
    ];
    const result: OcrResult = {
      regions: [...scientific, ...bodyBelow.flat()],
      lines: [readingLine(scientific), ...bodyBelow.map(readingLine)],
      text: '',
    };

    const lines = ocrResultToTextLines(result, options);
    expect(lines.find((line) => line.text === left)?.columnHint).toBe(0);
    expect(lines.find((line) => line.text === right)?.columnHint).toBe(1);
    expect(lines.some((line) => line.titleRow === true)).toBe(false);
    expect(lines.map((line) => line.text)).not.toContain(`${left} ${right}`);

    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.some((block) => block.box.width >= 500)).toBe(false);
    expect(layout.blocks.some((block) => block.text === `${left} ${right}`)).toBe(false);
  });

  it('keeps Wi/Wq dimension expressions inside one protected slot', () => {
    const cases = [
      {
        source: 'Each head uses Wi ∈ R d model × d k for its projection.',
        slot: 'Wi ∈ R d model × d k',
      },
      {
        source: 'The query matrix Wq ∈ R d model × d k is learned.',
        slot: 'Wq ∈ R d model × d k',
      },
    ];
    for (const { source, slot } of cases) {
      const block = layoutPage(groupLines([piece(source, 49, 100, 430)])).blocks[0];
      if (!block) throw new Error('expected a block');
      const protectedText = protectInlineMath(block);
      expect(
        protectedText.slots.map((entry) => entry.text),
        source,
      ).toEqual([slot]);
      expect(protectedText.text, source).not.toContain(slot.slice(0, 2));
      const restored = restoreInlineMath('訳文 <i0> です。', protectedText.slots);
      expect(restored).toBe(`訳文 ${slot} です。`);
    }
  });
});
