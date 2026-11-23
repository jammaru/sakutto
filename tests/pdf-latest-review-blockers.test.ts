// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { OcrQuad, OcrRegion, OcrResult, ReadingLine } from '@/engine/ocr/types';
import { compareReadingOrder, layoutPage, type LayoutBlock } from '@/pdf/layout';
import { groupLines, lineFrom } from '@/pdf/lines';
import { metricsPass, pageMetrics } from '@/pdf/metrics';
import { ocrResultToPageLayout, ocrResultToTextLines } from '@/pdf/ocr';
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
});
