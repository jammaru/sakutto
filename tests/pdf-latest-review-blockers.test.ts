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

  function block(text: string, x: number, y: number, column: number): LayoutBlock {
    return { text, box: { x, y, width: 100, height: 20 }, column, writing: 0 } as LayoutBlock;
  }

  it('B4: compareReadingOrder is a total order with a spanning block', () => {
    const leftTop = block('left-top', 45, 100, 0);
    const leftBottom = block('left-bottom', 45, 300, 0);
    const rightTop = block('right-top', 315, 100, 1);
    const spanning = block('spanning', 45, 200, -1);
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
    const spanning = block('spanning', 45, 200, -1);
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
    ).toEqual(['left-top', 'spanning', 'left-bottom', 'right-top']);
  });
});
