import { describe, expect, it, vi } from 'vitest';
import type { OcrTier } from '@/engine/ocr/catalog';
import { ocrPageTimeoutMs } from '@/engine/offscreen/protocol';
import type { ImageDataLike, OcrQuad, OcrRegion, OcrResult, ReadingLine } from '@/engine/ocr/types';
import type { FigureAreas } from '@/pdf/figures';
import { lineFrom, type TextLine, type TextPiece } from '@/pdf/lines';
import {
  createPdfPageOcr,
  ocrResultToHybridPage,
  ocrResultToLayoutBlocks,
  ocrResultToPageLayout,
  ocrResultToTextLines,
  shouldRunPdfOcr,
  uncoveredPdfOcrResult,
  type PdfOcrCanvas,
} from '@/pdf/ocr';

const PAGE = { width: 600, height: 800 };
const FULL_PAGE_IMAGE: FigureAreas = {
  images: [{ x: 0, y: 0, width: PAGE.width, height: PAGE.height }],
};
const NO_IMAGES: FigureAreas = { images: [] };

function nativeLine(text: string, orientation: 0 | 90 = 0): TextLine {
  const piece: TextPiece = {
    text,
    box:
      orientation === 0
        ? { x: 30, y: 20, width: Math.max(10, text.length * 6), height: 10 }
        : { x: 30, y: 20, width: 10, height: Math.max(10, text.length * 10) },
    baseline: orientation === 0 ? 30 : 40,
    fontName: 'native',
    family: 'serif',
    bold: false,
    italic: false,
    math: false,
    orientation,
    size: 10,
    displayed: orientation,
  };
  return lineFrom([piece]);
}

function quad(x: number, y: number, width: number, height: number): OcrQuad {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function region(text: string, bounds: OcrQuad, vertical = false): OcrRegion {
  return {
    quad: bounds,
    confidence: 0.95,
    vertical,
    text,
    recognitionConfidence: 0.9,
    symbolScores: [0.9],
  };
}

function readingLine(
  orientation: 'horizontal' | 'vertical',
  items: readonly OcrRegion[],
  indices: readonly number[] = items.map((_, index) => index),
): ReadingLine<OcrRegion> {
  return { orientation, items, indices };
}

function ocrResult(
  regions: readonly OcrRegion[],
  lines: readonly ReadingLine<OcrRegion>[],
): OcrResult {
  return {
    regions,
    lines,
    text: lines.flatMap((line) => line.items.map((item) => item.text)).join('\n'),
  };
}

const CONVERSION = {
  pageIndex: 3,
  pageWidth: 200,
  pageHeight: 200,
  imageWidth: 400,
  imageHeight: 400,
};

describe('shouldRunPdfOcr', () => {
  it('detects an empty or negligible native text layer', () => {
    expect(shouldRunPdfOcr([], NO_IMAGES, PAGE.width, PAGE.height)).toBe(true);
    expect(shouldRunPdfOcr([nativeLine('Draft')], NO_IMAGES, PAGE.width, PAGE.height)).toBe(true);
    expect(
      shouldRunPdfOcr([nativeLine('ID:demo-stamp-2024', 90)], NO_IMAGES, PAGE.width, PAGE.height),
    ).toBe(true);
  });

  it('detects a full-page scan with only a short watermark', () => {
    expect(
      shouldRunPdfOcr([nativeLine('DRAFT COPY')], FULL_PAGE_IMAGE, PAGE.width, PAGE.height),
    ).toBe(true);
  });

  it('never requests OCR for an ordinary native text page', () => {
    const lines = [
      nativeLine('A normal document page has enough genuine prose for translation.'),
      nativeLine('Its second line remains useful even when an image is present.'),
    ];
    expect(shouldRunPdfOcr(lines, NO_IMAGES, PAGE.width, PAGE.height)).toBe(false);
  });

  it('checks mixed image and prose pages for uncovered scanned regions', () => {
    expect(
      shouldRunPdfOcr([nativeLine('One two three')], FULL_PAGE_IMAGE, PAGE.width, PAGE.height),
    ).toBe(true);
    expect(
      shouldRunPdfOcr(
        [nativeLine('A caption explains the scan clearly.')],
        FULL_PAGE_IMAGE,
        PAGE.width,
        PAGE.height,
      ),
    ).toBe(true);
  });

  it('checks several short native lines on a mixed page for uncovered scans', () => {
    const lines = [
      nativeLine('Useful native'),
      nativeLine('text remains'),
      nativeLine('readable here'),
    ];
    expect(shouldRunPdfOcr(lines, FULL_PAGE_IMAGE, PAGE.width, PAGE.height)).toBe(true);
  });

  it('skips OCR when a usable native text layer already covers a page with a background image', () => {
    const lines = Array.from({ length: 20 }, (_, index) => {
      const piece: TextPiece = {
        text: 'A normal paragraph line with genuine prose for translation.',
        box: { x: 30, y: 20 + index * 20, width: 500, height: 10 },
        baseline: 30 + index * 20,
        fontName: 'native',
        family: 'serif',
        bold: false,
        italic: false,
        math: false,
        orientation: 0,
        size: 10,
        displayed: 0,
      };
      return lineFrom([piece]);
    });
    expect(shouldRunPdfOcr(lines, FULL_PAGE_IMAGE, PAGE.width, PAGE.height)).toBe(false);
  });

  it('checks tiled scans whose individual images are each below 35% of the page', () => {
    const tiles: FigureAreas = {
      images: [
        { x: 0, y: 0, width: 240, height: 520 },
        { x: 240, y: 0, width: 240, height: 520 },
      ],
    };
    expect(shouldRunPdfOcr([nativeLine('Scanned report')], tiles, PAGE.width, PAGE.height)).toBe(
      true,
    );
  });

  it('checks gapped tiled scans by union coverage, not by their last strip', () => {
    // Enough native text to be a text layer, yet too little to cover the page.
    const native = nativeLine(
      'A native paragraph with enough genuine prose to keep this scanned page from looking image only.',
    );
    const strips: FigureAreas = {
      images: [0, 200, 400, 600].map((y) => ({ x: 0, y, width: PAGE.width, height: 199 })),
    };
    const bands: FigureAreas = {
      images: [
        { x: 0, y: 0, width: PAGE.width, height: 200 },
        { x: 0, y: 400, width: PAGE.width, height: 200 },
      ],
    };
    expect(shouldRunPdfOcr([native], strips, PAGE.width, PAGE.height)).toBe(true);
    expect(shouldRunPdfOcr([native], bands, PAGE.width, PAGE.height)).toBe(true);
  });

  it('does not OCR large vector figures as if they were a scan', () => {
    const figures: FigureAreas = {
      images: [
        { x: 0, y: 0, width: PAGE.width, height: 320 },
        { x: 0, y: 480, width: PAGE.width, height: 320 },
      ],
      rasters: [],
    };
    expect(
      shouldRunPdfOcr(
        [nativeLine('A normal document page has useful prose.')],
        figures,
        PAGE.width,
        PAGE.height,
      ),
    ).toBe(false);
  });

  it('keeps OCRing a mixed page whose native text is only a sparse header and footer', () => {
    const nativeAt = (y: number): TextLine =>
      lineFrom([
        {
          text: 'Header',
          box: { x: 30, y, width: 120, height: 10 },
          baseline: y + 10,
          fontName: 'native',
          family: 'serif',
          bold: false,
          italic: false,
          math: false,
          orientation: 0,
          size: 10,
          displayed: 0,
        },
      ]);
    expect(
      shouldRunPdfOcr([nativeAt(10), nativeAt(770)], FULL_PAGE_IMAGE, PAGE.width, PAGE.height),
    ).toBe(true);
  });

  it('does not OCR a non-image page merely because its native runs are labels', () => {
    expect(
      shouldRunPdfOcr([nativeLine('12345 67890 12345')], NO_IMAGES, PAGE.width, PAGE.height),
    ).toBe(false);
  });
});

describe('hybrid native and scanned PDF pages', () => {
  it('keeps the native header and adds only uncovered OCR body regions', () => {
    const header = nativeLine('Results and discussion');
    const duplicateHeader = region('Results and discussion', quad(30, 20, 132, 10));
    const scannedBody = region(
      'This body exists only in the scanned part of the page.',
      quad(30, 100, 400, 20),
    );
    const result = ocrResult(
      [duplicateHeader, scannedBody],
      [readingLine('horizontal', [duplicateHeader]), readingLine('horizontal', [scannedBody], [1])],
    );
    const options = {
      pageIndex: 0,
      pageWidth: PAGE.width,
      pageHeight: PAGE.height,
      imageWidth: PAGE.width,
      imageHeight: PAGE.height,
    };
    const uncovered = uncoveredPdfOcrResult(result, [header], options);
    expect(uncovered.regions).toEqual([scannedBody]);
    expect(uncovered.lines).toHaveLength(1);

    const hybrid = ocrResultToHybridPage(
      result,
      {
        index: 0,
        width: PAGE.width,
        height: PAGE.height,
        lines: [header],
        figures: FULL_PAGE_IMAGE,
        empty: false,
      },
      options,
    );
    expect(hybrid.lines.map((line) => line.text)).toEqual([scannedBody.text]);
    expect(hybrid.layout.blocks.map((block) => block.text)).toEqual([
      header.text,
      scannedBody.text,
    ]);
  });

  it('protects native labels in a partial figure, but not text on a full-page scan', () => {
    const label = nativeLine('Axis label inside the drawing');
    const options = {
      pageIndex: 0,
      pageWidth: PAGE.width,
      pageHeight: PAGE.height,
    };
    const extracted = (figures: FigureAreas) => ({
      index: 0,
      width: PAGE.width,
      height: PAGE.height,
      lines: [label],
      figures,
      empty: false,
    });
    const emptyOcr = ocrResult([], []);

    // Large enough to need OCR, but not a page background: its label must stay skipped.
    const partial: FigureAreas = { images: [{ x: 0, y: 0, width: 300, height: 400 }] };
    const hybrid = ocrResultToHybridPage(emptyOcr, extracted(partial), options);
    expect(hybrid.layout.blocks.map((block) => block.text)).not.toContain(label.text);
    expect(hybrid.layout.skipped.map((block) => block.text)).toContain(label.text);
    expect(hybrid.layout.skipped[0]?.role).toBe('figure-label');

    // The page-sized exception still applies: that native text remains translatable prose.
    const background = ocrResultToHybridPage(emptyOcr, extracted(FULL_PAGE_IMAGE), options);
    expect(background.layout.blocks.map((block) => block.text)).toContain(label.text);
    expect(background.layout.skipped.map((block) => block.text)).not.toContain(label.text);
  });

  it('keeps the native header when the page scan is split into tiles', () => {
    const header = nativeLine('Scanned report');
    const duplicateHeader = region('Scanned report', quad(30, 20, 84, 10));
    const scannedBody = region('Body text only in the scan', quad(30, 100, 300, 20));
    const result = ocrResult(
      [duplicateHeader, scannedBody],
      [readingLine('horizontal', [duplicateHeader]), readingLine('horizontal', [scannedBody], [1])],
    );
    const tiles: FigureAreas = {
      images: [
        { x: 0, y: 0, width: 300, height: 800 },
        { x: 300, y: 0, width: 300, height: 800 },
      ],
    };
    const hybrid = ocrResultToHybridPage(
      result,
      {
        index: 0,
        width: PAGE.width,
        height: PAGE.height,
        lines: [header],
        figures: tiles,
        empty: false,
      },
      {
        pageIndex: 0,
        pageWidth: PAGE.width,
        pageHeight: PAGE.height,
        imageWidth: PAGE.width,
        imageHeight: PAGE.height,
      },
    );
    expect(hybrid.layout.blocks.map((block) => block.text)).toEqual([
      header.text,
      scannedBody.text,
    ]);
    expect(hybrid.layout.skipped.map((block) => block.text)).not.toContain(header.text);
    expect(hybrid.lines.map((line) => line.text)).toEqual([scannedBody.text]);
  });

  it('drops a background scan while keeping a partial figure on the same page', () => {
    const at = (text: string, y: number): TextLine =>
      lineFrom([
        {
          text,
          box: { x: 30, y, width: text.length * 6, height: 10 },
          baseline: y + 10,
          fontName: 'native',
          family: 'serif',
          bold: false,
          italic: false,
          math: false,
          orientation: 0,
          size: 10,
          displayed: 0,
        },
      ]);
    const header = at('Scanned report', 20);
    const figureLabel = at('Axis label inside the drawing', 320);
    const figures: FigureAreas = {
      images: [
        { x: 0, y: 0, width: 600, height: 800 },
        { x: 0, y: 200, width: 300, height: 300 },
      ],
    };
    const hybrid = ocrResultToHybridPage(
      ocrResult([], []),
      {
        index: 0,
        width: PAGE.width,
        height: PAGE.height,
        lines: [header, figureLabel],
        figures,
        empty: false,
      },
      { pageIndex: 0, pageWidth: PAGE.width, pageHeight: PAGE.height },
    );
    expect(hybrid.layout.blocks.map((block) => block.text)).toContain(header.text);
    expect(hybrid.layout.skipped.map((block) => block.text)).toContain(figureLabel.text);
    expect(hybrid.layout.skipped.find((block) => block.text === figureLabel.text)?.role).toBe(
      'figure-label',
    );
  });
});

describe('hybrid OCR after Chrome message serialization', () => {
  it('keeps reading lines when regions and line items are distinct JSON objects', () => {
    const header = nativeLine('Results and discussion');
    const duplicateHeader = region('Results and discussion', quad(30, 20, 132, 10));
    const scannedBody = region('Only in the scanned raster', quad(30, 100, 400, 20));
    const original = ocrResult(
      [duplicateHeader, scannedBody],
      [readingLine('horizontal', [duplicateHeader]), readingLine('horizontal', [scannedBody], [1])],
    );
    // Chrome runtime messages are JSON-serialized; identity between regions and lines is lost.
    const result = JSON.parse(JSON.stringify(original)) as OcrResult;
    expect(result.regions[1]).not.toBe(result.lines[1]?.items[0]);
    const uncovered = uncoveredPdfOcrResult(result, [header], {
      pageIndex: 0,
      pageWidth: PAGE.width,
      pageHeight: PAGE.height,
      imageWidth: PAGE.width,
      imageHeight: PAGE.height,
    });
    expect(uncovered.regions).toHaveLength(1);
    expect(uncovered.lines).toHaveLength(1);
    expect(uncovered.text).toBe(scannedBody.text);
  });
});

describe('OCR geometry and layout conversion', () => {
  it('preserves image quads and maps their complete AABB into PDF page coordinates', () => {
    const source = [
      { x: 20, y: 40 },
      { x: 140, y: 50 },
      { x: 136, y: 82 },
      { x: 16, y: 72 },
    ] as const;
    const item = region('Rotated source', source);
    const result = ocrResult([item], [readingLine('horizontal', [item])]);
    const [line] = ocrResultToTextLines(result, CONVERSION);
    const piece = line?.pieces[0];

    expect(piece?.sourceQuad).toEqual(source);
    expect(piece?.sourceQuad).not.toBe(source);
    expect(piece?.quad).toEqual([
      { x: 10, y: 20 },
      { x: 70, y: 25 },
      { x: 68, y: 41 },
      { x: 8, y: 36 },
    ]);
    expect(piece?.box).toEqual({ x: 8, y: 20, width: 62, height: 21 });
    expect(piece?.baseline).toBeCloseTo(38.5);
    expect(piece?.size).toBeCloseTo(Math.hypot(2, 16));
    expect(piece).toMatchObject({
      family: 'serif',
      bold: false,
      italic: false,
      math: false,
      orientation: 0,
      displayed: 0,
    });
    expect(piece?.fontName).toBe(piece?.id);
    expect(line?.box).toEqual(piece?.box);
  });

  it('uses OCR reading lines rather than the flat region order and keeps stable IDs', () => {
    const right = region('world', quad(140, 20, 100, 40));
    const second = region('Second row', quad(20, 100, 180, 40));
    const left = region('Hello', quad(20, 20, 100, 40));
    const result = ocrResult(
      [right, second, left],
      [readingLine('horizontal', [left, right], [2, 0]), readingLine('horizontal', [second], [1])],
    );
    const lines = ocrResultToTextLines(result, CONVERSION);

    expect(lines.map((line) => line.text)).toEqual(['Hello world', 'Second row']);
    expect(lines.map((line) => line.id)).toEqual(['ocr:p3:l0', 'ocr:p3:l1']);
    expect(lines[0]?.pieces.map((piece) => piece.id)).toEqual(['ocr:p3:l0:r2', 'ocr:p3:l0:r0']);
    expect(ocrResultToTextLines(result, CONVERSION).map((line) => line.id)).toEqual(
      lines.map((line) => line.id),
    );
    expect(ocrResultToTextLines(result, { ...CONVERSION, pageIndex: 4 })[0]?.id).toBe('ocr:p4:l0');
  });

  it('preserves a word space between touching horizontal English regions', () => {
    const left = region('Hello', quad(20, 20, 100, 40));
    const right = region('world', quad(120, 20, 100, 40));
    const result = ocrResult([left, right], [readingLine('horizontal', [left, right])]);

    expect(ocrResultToTextLines(result, CONVERSION)[0]?.text).toBe('Hello world');
    expect(ocrResultToLayoutBlocks(result, CONVERSION)[0]?.text).toBe('Hello world');
  });

  it('preserves a word space between overlapping horizontal English regions', () => {
    const left = region('Hello', quad(20, 20, 100, 40));
    const right = region('world', quad(100, 20, 100, 40));
    const result = ocrResult([left, right], [readingLine('horizontal', [left, right])]);

    expect(ocrResultToTextLines(result, CONVERSION)[0]?.text).toBe('Hello world');
    expect(ocrResultToLayoutBlocks(result, CONVERSION)[0]?.text).toBe('Hello world');
  });

  it('skips blank recognitions without inventing geometry or changing source region IDs', () => {
    const blank = region('  ', quad(20, 20, 100, 40));
    const text = region('Visible', quad(140, 20, 100, 40));
    const result = ocrResult([blank, text], [readingLine('horizontal', [blank, text], [0, 1])]);
    const lines = ocrResultToTextLines(result, CONVERSION);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Visible');
    expect(lines[0]?.pieces[0]?.id).toBe('ocr:p3:l0:r1');
  });

  it('creates session-compatible horizontal blocks and page layout defaults', () => {
    const item = region(
      'This scanned sentence has several useful words for translation.',
      quad(20, 20, 300, 40),
    );
    const result = ocrResult([item], [readingLine('horizontal', [item])]);
    const [block] = ocrResultToLayoutBlocks(result, CONVERSION);
    const [line] = ocrResultToTextLines(result, CONVERSION);

    expect(block).toMatchObject({
      id: 'ocr:p3:l0:block',
      text: item.text,
      role: 'prose',
      fontSize: 20,
      lineHeight: 1.35,
      align: 'left',
      bold: false,
      italic: false,
      // A page with no body columns keeps even a wide line in its single column group.
      column: 0,
      writing: 0,
    });
    expect(block?.box).toEqual(line?.box);
    expect(block?.room).toEqual(line?.box);
    expect(block?.advance).toBe(line?.box.width);
    expect(block?.lines[0]?.pieces[0]?.math).toBe(false);

    const layout = ocrResultToPageLayout(result, CONVERSION);
    expect(layout).toMatchObject({
      bodySize: 20,
      lineHeight: 20,
      pageHeight: 200,
      pageWidth: 200,
      pageIndex: 3,
      obstacles: [],
      skipped: [],
    });
    expect(layout.blocks[0]?.id).toBe('ocr:p3:l0:block');
  });

  it('keeps a full-width title out of the body columns and their room widths', () => {
    const conversion = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const title = region('Paper title spanning both columns', quad(50, 50, 500, 30));
    const left = region(
      'Left column prose with enough words to translate.',
      quad(50, 120, 240, 20),
    );
    const leftNext = region('More left column prose with enough words.', quad(50, 145, 240, 20));
    const right = region(
      'Right column prose with enough words to translate.',
      quad(320, 120, 240, 20),
    );
    const result = ocrResult(
      [title, left, leftNext, right],
      [
        readingLine('horizontal', [title]),
        readingLine('horizontal', [left]),
        readingLine('horizontal', [leftNext]),
        readingLine('horizontal', [right]),
      ],
    );

    const layout = ocrResultToPageLayout(result, conversion);
    expect(layout.blocks.map((block) => block.column)).toEqual([-1, 0, 0, 1]);
    // The title wraps to its own measure; the body paragraphs keep the true column width
    // instead of inheriting the title's page-wide room and clipping under the cover cap.
    expect(layout.blocks[0]?.room.width).toBe(500);
    for (const block of layout.blocks.slice(1)) expect(block.room.width).toBe(240);
  });

  it('translates prose that merely starts with a programming keyword', () => {
    const sentences = [
      'For each batch we compute the loss',
      'For the first time, the model converges',
      'If the input is empty the function returns zero',
      'Return to the previous section for details',
      'While the model trains the logs are written',
    ];
    for (const text of sentences) {
      const item = region(text, quad(50, 100, 240, 20));
      const layout = ocrResultToPageLayout(ocrResult([item], [readingLine('horizontal', [item])]), {
        pageIndex: 0,
        pageWidth: 595,
        pageHeight: 800,
      });
      expect(layout.blocks.map((block) => block.text)).toEqual([text]);
      expect(layout.blocks[0]?.role).toBe('prose');
      expect(layout.skipped).toEqual([]);
    }
  });

  it('still skips bare listing lines whose punctuation survived OCR', () => {
    const statements = ['for i in range(10):', 'if loss > 0:', 'return result;', '1 while queue:'];
    const items = statements.map((text, index) =>
      region(text, quad(50, 100 + index * 30, 240, 20)),
    );
    const layout = ocrResultToPageLayout(
      ocrResult(
        items,
        items.map((item) => readingLine('horizontal', [item])),
      ),
      { pageIndex: 0, pageWidth: 595, pageHeight: 800 },
    );
    expect(layout.blocks).toEqual([]);
    expect(layout.skipped.map((block) => block.role)).toEqual(statements.map(() => 'code'));
  });

  it('keeps a small figure caption instead of withholding it as a figure label', () => {
    const first = region(
      'The runtime offers two backends for local translation.',
      quad(50, 100, 240, 20),
    );
    const second = region(
      'The CPU backend keeps one sequence on this machine.',
      quad(50, 130, 240, 20),
    );
    const caption = region(
      'Figure 1: A small caption with enough words to translate.',
      quad(50, 180, 300, 10),
    );
    const layout = ocrResultToPageLayout(
      ocrResult(
        [first, second, caption],
        [
          readingLine('horizontal', [first]),
          readingLine('horizontal', [second]),
          readingLine('horizontal', [caption]),
        ],
      ),
      { pageIndex: 0, pageWidth: 595, pageHeight: 800 },
    );
    expect(layout.blocks.map((block) => block.role)).toEqual(['prose', 'prose', 'caption']);
    expect(layout.skipped).toEqual([]);
    expect(layout.obstacles).toEqual([]);
  });

  it('splits a wide reading line that combines both body columns', () => {
    const leftText = 'The runtime offers two backends and keeps two sequences resident.';
    const rightText = 'The first two send the page and every selection to a third party.';
    const left = region(leftText, quad(45, 340, 240, 20));
    const right = region(rightText, quad(320, 340, 240, 20));
    const result = ocrResult([left, right], [readingLine('horizontal', [left, right])]);
    const conversion = { pageIndex: 0, pageWidth: 595, pageHeight: 800 };

    expect(ocrResultToTextLines(result, conversion).map((line) => line.text)).toEqual([
      leftText,
      rightText,
    ]);
    const layout = ocrResultToPageLayout(result, conversion);
    expect(layout.blocks.map((block) => block.column)).toEqual([0, 1]);
    expect(layout.blocks.map((block) => block.text)).toEqual([leftText, rightText]);
    const gutter = conversion.pageWidth * 0.49;
    for (const block of layout.blocks) {
      expect(block.box.x + block.box.width <= gutter || block.box.x >= gutter).toBe(true);
      expect(block.room.width).toBeLessThan(conversion.pageWidth * 0.6);
    }
  });

  it('splits a same-baseline row separated by a 15pt gutter', () => {
    const leftText = 'left column words here';
    const rightText = 'right column words here';
    const conversion = { pageIndex: 0, pageWidth: 595, pageHeight: 842 };
    const scenarios = [
      [region(leftText, quad(45, 340, 250, 20)), region(rightText, quad(310, 340, 250, 20))],
      [
        region('left column', quad(45, 340, 120, 20)),
        region(' words here', quad(170, 340, 125, 20)),
        region('right column', quad(310, 340, 120, 20)),
        region(' words here', quad(435, 340, 125, 20)),
      ],
    ];
    for (const items of scenarios) {
      const result = ocrResult(items, [readingLine('horizontal', items)]);
      expect(ocrResultToTextLines(result, conversion).map((line) => line.text)).toEqual([
        leftText,
        rightText,
      ]);
      const layout = ocrResultToPageLayout(result, conversion);
      expect(layout.blocks.map((block) => block.column)).toEqual([0, 1]);
      expect(layout.blocks.map((block) => block.text)).toEqual([leftText, rightText]);
    }
  });

  it('splits a merged row whose two columns sit on slightly different baselines', () => {
    const leftText = 'The runtime offers two backends here.';
    const rightText = 'The first two send the page onward.';
    const items = [
      region('The runtime offers', quad(45, 340.8, 120, 11)),
      region('two backends here.', quad(170, 340.8, 115, 11)),
      region('The first two send', quad(302, 342.3, 130, 11)),
      region('the page onward.', quad(437, 342.3, 123, 11)),
    ];
    const result = ocrResult([...items], [readingLine('horizontal', items)]);
    const conversion = { pageIndex: 0, pageWidth: 595, pageHeight: 800 };

    expect(ocrResultToTextLines(result, conversion).map((line) => line.text)).toEqual([
      leftText,
      rightText,
    ]);
    expect(ocrResultToPageLayout(result, conversion).blocks.map((block) => block.column)).toEqual([
      0, 1,
    ]);
  });

  it('keeps a full-width title whose words only straddle the gutter', () => {
    const left = region('Long paper title about translation', quad(50, 50, 240, 30));
    const right = region('quality for on-device readers', quad(300, 50, 240, 30));
    const result = ocrResult([left, right], [readingLine('horizontal', [left, right])]);
    expect(
      ocrResultToTextLines(result, { pageIndex: 0, pageWidth: 595, pageHeight: 800 }),
    ).toHaveLength(1);
  });

  it('reads a split both-column row in column order before the next left line', () => {
    const conversion = { pageIndex: 0, pageWidth: 595, pageHeight: 800 };
    const title = region('Title words spanning both columns', quad(50, 50, 500, 20));
    const left1 = region(
      'Left column prose with enough words to translate',
      quad(50, 120, 240, 20),
    );
    const right1 = region(
      'Right column prose with enough words to translate.',
      quad(320, 120, 240, 20),
    );
    const left2 = region('More left column prose with enough words', quad(50, 145, 240, 20));
    // The detector/read-line merger combines the two body columns of the same row.
    const result = ocrResult(
      [title, left1, right1, left2],
      [
        readingLine('horizontal', [title]),
        readingLine('horizontal', [left1, right1]),
        readingLine('horizontal', [left2]),
      ],
    );

    expect(ocrResultToTextLines(result, conversion).map((line) => line.text)).toEqual([
      title.text,
      left1.text,
      left2.text,
      right1.text,
    ]);
    const layout = ocrResultToPageLayout(result, conversion);
    expect(layout.blocks.map((block) => block.column)).toEqual([-1, 0, 1]);
    // Once left1 and left2 are adjacent they group into one paragraph-sized cover.
    expect(layout.blocks[1]?.lines.map((line) => line.text)).toEqual([left1.text, left2.text]);
    expect(layout.blocks[2]?.text).toBe(right1.text);
  });

  it('splits a short left heading from a right body line on the same baseline', () => {
    const heading = '1. Introduction';
    const body = 'in two places so that workers and the WebAssembly module';
    const left = region(heading, quad(45, 340, 72, 12));
    const right = region(body, quad(307, 340, 280, 12));
    const result = ocrResult([left, right], [readingLine('horizontal', [left, right])]);
    const conversion = { pageIndex: 0, pageWidth: 595, pageHeight: 842 };

    expect(ocrResultToTextLines(result, conversion).map((line) => line.text)).toEqual([
      heading,
      body,
    ]);
    const layout = ocrResultToPageLayout(result, conversion);
    expect(layout.blocks.map((block) => [block.role, block.column])).toEqual([
      ['heading', 0],
      ['prose', 1],
    ]);
    expect(layout.blocks.map((block) => block.text)).toEqual([heading, body]);
  });

  it('supports an empty OCR result', () => {
    const empty: OcrResult = { regions: [], lines: [], text: '' };
    expect(ocrResultToTextLines(empty, CONVERSION)).toEqual([]);
    expect(ocrResultToPageLayout(empty, CONVERSION)).toMatchObject({
      blocks: [],
      bodySize: 0,
      lineHeight: 0,
      skipped: [],
    });
  });
});

describe('vertical Japanese OCR', () => {
  it('keeps columns right-to-left, items top-to-bottom, and Japanese text unspaced', () => {
    const rightTop = region('縦', quad(300, 20, 40, 100), true);
    const rightNext = region('書き', quad(300, 130, 40, 100), true);
    const left = region('左列', quad(100, 20, 40, 100), true);
    const result = ocrResult(
      [left, rightNext, rightTop],
      [
        readingLine('vertical', [rightTop, rightNext], [2, 1]),
        readingLine('vertical', [left], [0]),
      ],
    );
    const lines = ocrResultToTextLines(result, CONVERSION);
    const blocks = ocrResultToLayoutBlocks(result, CONVERSION);

    expect(lines.map((line) => line.text)).toEqual(['縦書き', '左列']);
    expect(blocks.map((block) => block.text)).toEqual(['縦書き', '左列']);
    expect(lines[0]?.pieces.map((piece) => piece.orientation)).toEqual([90, 90]);
    expect(lines[0]?.pieces.map((piece) => piece.displayed)).toEqual([90, 90]);
    expect(lines[0]?.pieces[0]?.baseline).toBe(170);
    expect(lines[0]?.pieces[0]?.size).toBe(20);
    expect(blocks[0]?.writing).toBe(90);
    expect(blocks[0]?.advance).toBe(lines[0]?.box.height);
    expect(blocks[0]?.box).toEqual(lines[0]?.box);
  });

  it('uses each region vertical flag instead of the majority reading orientation', () => {
    const right = region('右列', quad(300, 100, 40, 100), true);
    const left = region('左列', quad(100, 100, 40, 100), true);
    const title = region('Horizontal title', quad(40, 20, 300, 40), false);
    const result = ocrResult(
      [right, left, title],
      [
        readingLine('vertical', [right], [0]),
        readingLine('vertical', [left], [1]),
        readingLine('vertical', [title], [2]),
      ],
    );
    const lines = ocrResultToTextLines(result, CONVERSION);
    const titlePiece = lines
      .flatMap((line) => line.pieces)
      .find((piece) => piece.text === title.text);

    expect(titlePiece).toMatchObject({ orientation: 0, displayed: 0, size: 20 });
    expect(
      lines.flatMap((line) => line.pieces).filter((piece) => piece !== titlePiece),
    ).toMatchObject([
      { orientation: 90, displayed: 90 },
      { orientation: 90, displayed: 90 },
    ]);
  });

  it('derives canonical vertical order when a caller retained only regions', () => {
    const left = region('左', quad(40, 20, 40, 120), true);
    const right = region('右', quad(300, 20, 40, 120), true);
    const result: OcrResult = { regions: [left, right], lines: [], text: '' };
    expect(ocrResultToTextLines(result, CONVERSION).map((line) => line.text)).toEqual(['右', '左']);
  });
});

describe('lazy per-page OCR', () => {
  const pixels = {
    width: 400,
    height: 200,
    data: new Uint8ClampedArray(400 * 200 * 4),
  };
  const item = region('Recognized prose for the lazy page helper.', quad(20, 20, 300, 40));
  const recognized = ocrResult([item], [readingLine('horizontal', [item])]);

  it('does no work until run, reads canvas pixels once, and caches success', async () => {
    const getImageData = vi.fn(() => pixels);
    const getContext = vi.fn(() => ({ getImageData }));
    const canvas: PdfOcrCanvas = { width: 400, height: 200, getContext };
    const recognize = vi.fn(async (image: ImageDataLike, signal: AbortSignal) => {
      expect(image).toBe(pixels);
      expect(signal).toBeInstanceOf(AbortSignal);
      return recognized;
    });
    const page = createPdfPageOcr({
      pageIndex: 2,
      pageWidth: 200,
      pageHeight: 100,
      recognize,
    });

    expect(getContext).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();
    const first = page.run(canvas);
    const concurrent = page.run(canvas);
    expect(concurrent).toBe(first);
    const value = await first;

    expect(getContext).toHaveBeenCalledTimes(1);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 400, 200);
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(recognize.mock.calls[0]?.[0]).toBe(pixels);
    expect(recognize.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(value.empty).toBe(false);
    expect(value.ocr).toBe(recognized);
    expect(value.lines[0]?.box).toEqual({ x: 10, y: 10, width: 150, height: 20 });
    expect(value.layout.blocks[0]?.box).toEqual(value.lines[0]?.box);
    expect(await page.run(canvas)).toBe(value);
    expect(recognize).toHaveBeenCalledTimes(1);
  });

  it('cancels before recognition starts and permits a clean retry', async () => {
    const recognize = vi.fn(async () => recognized);
    const page = createPdfPageOcr({
      pageIndex: 0,
      pageWidth: 400,
      pageHeight: 200,
      recognize,
    });
    const pending = page.run(pixels);
    page.cancel();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(recognize).not.toHaveBeenCalled();
    await expect(page.run(pixels)).resolves.toMatchObject({ empty: false });
    expect(recognize).toHaveBeenCalledTimes(1);
  });

  it('rejects promptly on in-flight cancellation, aborts injection, and ignores late output', async () => {
    let finish: ((value: OcrResult) => void) | undefined;
    let started: (() => void) | undefined;
    const recognitionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const injectedSignals: AbortSignal[] = [];
    const recognize = vi
      .fn()
      .mockImplementationOnce((image: ImageDataLike, signal: AbortSignal) => {
        expect(image).toBe(pixels);
        injectedSignals.push(signal);
        started?.();
        return new Promise<OcrResult>((resolve) => {
          finish = resolve;
        });
      })
      .mockResolvedValueOnce(recognized);
    const page = createPdfPageOcr({
      pageIndex: 0,
      pageWidth: 400,
      pageHeight: 200,
      recognize,
    });
    const pending = page.run(pixels);
    await recognitionStarted;

    page.cancel();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(injectedSignals[0]?.aborted).toBe(true);
    finish?.(recognized);
    await expect(page.run(pixels)).resolves.toMatchObject({ empty: false });
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it('clears a failed task so the same page can retry', async () => {
    const recognize = vi
      .fn()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValue(recognized);
    const page = createPdfPageOcr({
      pageIndex: 0,
      pageWidth: 400,
      pageHeight: 200,
      recognize,
    });
    await expect(page.run(pixels)).rejects.toThrow('failed');
    await expect(page.run(pixels)).resolves.toMatchObject({ empty: false });
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it('reports an empty scan and a missing canvas context without importing browser APIs', async () => {
    const empty = createPdfPageOcr({
      pageIndex: 0,
      pageWidth: 400,
      pageHeight: 200,
      recognize: async () => ({ regions: [], lines: [], text: '' }),
    });
    await expect(empty.run(pixels)).resolves.toMatchObject({
      empty: true,
      lines: [],
      layout: { blocks: [] },
    });

    const noContext = createPdfPageOcr({
      pageIndex: 0,
      pageWidth: 400,
      pageHeight: 200,
      recognize: async () => recognized,
    });
    const canvas: PdfOcrCanvas = { width: 400, height: 200, getContext: () => null };
    await expect(noContext.run(canvas)).rejects.toThrow('no 2D context');
  });
  it('surfaces a visible error when one scanned page exceeds the hard timeout', async () => {
    const page = createPdfPageOcr({
      pageIndex: 0,
      pageWidth: 400,
      pageHeight: 200,
      recognize: () => new Promise<OcrResult>(() => undefined),
      timeoutMs: 10,
      timeoutMessage: '設定でOCRモデルをダウンロードしてください',
    });
    await expect(page.run(pixels)).rejects.toThrow('設定でOCRモデルをダウンロードしてください');
  });

  it('takes the local timeout from a live tier getter', async () => {
    vi.useFakeTimers();
    try {
      let tier: OcrTier = 'standard';
      const page = createPdfPageOcr({
        pageIndex: 0,
        pageWidth: 400,
        pageHeight: 200,
        tier: () => tier,
        recognize: () => new Promise<OcrResult>(() => undefined),
      });
      // The settings change lands between reader boot and this page's recognition.
      tier = 'high';
      let rejected = false;
      const pending = page.run(pixels).catch(() => {
        rejected = true;
      });
      await vi.advanceTimersByTimeAsync(ocrPageTimeoutMs('standard') + 1);
      expect(rejected).toBe(false);
      await vi.advanceTimersByTimeAsync(ocrPageTimeoutMs('high') - ocrPageTimeoutMs('standard'));
      expect(rejected).toBe(true);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('review 5 blockers', () => {
  const conversion = { pageIndex: 0, pageWidth: 595, pageHeight: 842 };

  it('B1: translates body-size headings instead of skipping every short label', () => {
    for (const text of ['References', 'Abstract']) {
      const item = region(text, quad(260, 600, 70, 14));
      const layout = ocrResultToPageLayout(
        ocrResult([item], [readingLine('horizontal', [item])]),
        conversion,
      );
      expect(
        layout.blocks.map((block) => block.text),
        text,
      ).toEqual([text]);
      expect(layout.blocks[0]?.role, text).toBe('heading');
      expect(layout.skipped, text).toEqual([]);
    }
  });

  it('B2: keeps one sloped full-width line whole when word boxes have no gutter', () => {
    const words = ['This', 'is', 'a', 'single', 'full', 'width', 'line', 'of', 'ordinary', 'text'];
    const items = words.map((text, index) =>
      region(text, quad(45 + index * 50, index < 3 ? 100 : 102, 45, 18)),
    );
    const lines = ocrResultToTextLines(
      ocrResult(items, [readingLine('horizontal', items)]),
      conversion,
    );
    expect(lines.map((line) => line.text)).toEqual([words.join(' ')]);
  });

  it('B3: a short centred title precedes the columns and keeps its own room', () => {
    const title = region('BERT', quad(260, 50, 75, 30));
    const left1 = region(
      'Left column prose with enough words to translate',
      quad(45, 120, 240, 20),
    );
    const left2 = region('More left column prose with enough words', quad(45, 145, 240, 20));
    const right1 = region(
      'Right column prose with enough words to translate',
      quad(310, 120, 240, 20),
    );
    const right2 = region('Other right column prose with enough words', quad(310, 145, 240, 20));
    const result = ocrResult(
      [title, left1, left2, right1, right2],
      [
        readingLine('horizontal', [title]),
        readingLine('horizontal', [left1]),
        readingLine('horizontal', [left2]),
        readingLine('horizontal', [right1]),
        readingLine('horizontal', [right2]),
      ],
    );
    expect(ocrResultToTextLines(result, conversion).map((line) => line.text)).toEqual([
      title.text,
      left1.text,
      left2.text,
      right1.text,
      right2.text,
    ]);
    const layout = ocrResultToPageLayout(result, conversion);
    expect(layout.blocks[0]?.column).toBe(-1);
    expect(layout.blocks[0]?.room.width).toBeCloseTo(75, 5);
    for (const block of layout.blocks.slice(1)) expect(block.room.width).toBeLessThan(300);
  });
});

describe('latest review blockers', () => {
  it('B1: splits a two-column row whose gutter sits past the page midpoint', () => {
    const leftText = 'Left column body text that ends just past the page midpoint.';
    const rightText = 'Right column body text starts after a real gutter.';
    const left = region(leftText, quad(30, 100, 280, 20));
    const right = region(rightText, quad(340, 100, 230, 20));
    const result = ocrResult([left, right], [readingLine('horizontal', [left, right])]);
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };

    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
      leftText,
      rightText,
    ]);
    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.map((block) => block.column)).toEqual([0, 1]);
  });

  it('B1: picks the widest centred gutter, not a word gap inside the right column', () => {
    // pageWidth 595: the real gutter is 250..315 (65pt); the right column also has a 10pt
    // word gap at 345..355 that is centred enough to qualify. Both clear MIN_COLUMN_GUTTER,
    // so only a widest-gap rule keeps the right column's first word with its own block.
    const items = [
      region('left', quad(45, 340, 40, 20)),
      region('column', quad(90, 340, 50, 20)),
      region('words', quad(145, 340, 45, 20)),
      region('here', quad(215, 340, 35, 20)),
      region('right', quad(315, 340, 30, 20)),
      region('wide', quad(355, 340, 40, 20)),
      region('column', quad(400, 340, 50, 20)),
      region('words', quad(455, 340, 45, 20)),
      region('here', quad(505, 340, 35, 20)),
    ];
    const result = ocrResult([...items], [readingLine('horizontal', items)]);
    const options = { pageIndex: 0, pageWidth: 595, pageHeight: 842 };

    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
      'left column words here',
      'right wide column words here',
    ]);
    expect(ocrResultToPageLayout(result, options).blocks.map((block) => block.text)).toEqual([
      'left column words here',
      'right wide column words here',
    ]);
  });

  it('B2: splits a same-baseline row separated by only 10pt', () => {
    const leftText = 'left column words here';
    const rightText = 'right column words here';
    const left = region(leftText, quad(45, 100, 240, 20));
    const right = region(rightText, quad(295, 100, 240, 20));
    const result = ocrResult([left, right], [readingLine('horizontal', [left, right])]);
    const options = { pageIndex: 0, pageWidth: 595, pageHeight: 842 };

    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
      leftText,
      rightText,
    ]);
    expect(ocrResultToPageLayout(result, options).blocks.map((block) => block.column)).toEqual([
      0, 1,
    ]);
  });

  it('B3: reads a left-aligned References heading after both body columns', () => {
    const lines = [
      region('Left body one', quad(45, 100, 250, 20)),
      region('Left body two', quad(45, 120, 250, 20)),
      region('Right body one', quad(320, 100, 250, 20)),
      region('Right body two', quad(320, 120, 250, 20)),
      region('References', quad(45, 200, 70, 20)),
      region('Ref left', quad(45, 220, 250, 20)),
      region('Ref right', quad(320, 220, 250, 20)),
    ];
    const result = ocrResult(
      lines,
      lines.map((item) => readingLine('horizontal', [item])),
    );
    expect(
      ocrResultToTextLines(result, { pageIndex: 0, pageWidth: 600, pageHeight: 800 }).map(
        (line) => line.text,
      ),
    ).toEqual([
      'Left body one',
      'Left body two',
      'Right body one',
      'Right body two',
      'References',
      'Ref left',
      'Ref right',
    ]);
  });

  it('B4: keeps a centred single column in top-to-bottom source order', () => {
    const lines = [
      region('Top full source line of the single column', quad(150, 100, 300, 20)),
      region('Short source line', quad(150, 125, 240, 20)),
      region('Bottom full source line of the single column', quad(150, 150, 300, 20)),
    ];
    const result = ocrResult(
      lines,
      lines.map((item) => readingLine('horizontal', [item])),
    );
    const layout = ocrResultToPageLayout(result, {
      pageIndex: 0,
      pageWidth: 600,
      pageHeight: 800,
    });
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0]?.lines.map((line) => line.text)).toEqual([
      'Top full source line of the single column',
      'Short source line',
      'Bottom full source line of the single column',
    ]);
  });

  it('B5: keeps prose that starts with a keyword and contains parentheses', () => {
    const cases = [
      [
        'For each layer (see Figure 2), we apply normalization',
        'and the next line continues the same paragraph',
      ],
      ['Return to the previous section (Section 2) for details'],
      ['If the input (Figure 1) is unchanged we continue'],
      ['While training (see Table 3) the logs are written'],
    ];
    for (const texts of cases) {
      const items = texts.map((text, index) => region(text, quad(45, 100 + index * 25, 400, 20)));
      const result = ocrResult(
        items,
        items.map((item) => readingLine('horizontal', [item])),
      );
      const layout = ocrResultToPageLayout(result, {
        pageIndex: 0,
        pageWidth: 595,
        pageHeight: 842,
      });
      expect(
        layout.blocks.map((block) => block.text),
        texts.join(' / '),
      ).toEqual([texts.join(' ')]);
      expect(layout.blocks[0]?.role, texts.join(' / ')).toBe('prose');
      expect(layout.skipped, texts.join(' / ')).toEqual([]);
    }
  });
});

describe('latest DSH review blockers', () => {
  it('B1: groups Japanese body lines into one prose paragraph', () => {
    const texts = ['この文書はスキャンされた', '日本語のページです'];
    const items = texts.map((text, index) => region(text, quad(50, 100 + index * 25, 400, 20)));
    const result = ocrResult(
      items,
      items.map((item) => readingLine('horizontal', [item])),
    );
    const layout = ocrResultToPageLayout(result, {
      pageIndex: 0,
      pageWidth: 600,
      pageHeight: 800,
    });

    expect(layout.blocks.map((block) => block.text)).toEqual([texts.join(' ')]);
    expect(layout.blocks[0]?.role).toBe('prose');
    expect(layout.skipped).toEqual([]);
  });

  it('B1: keeps a short English body line out of the heading role', () => {
    const texts = ['This is a short', 'line of ordinary body prose'];
    const items = texts.map((text, index) => region(text, quad(50, 100 + index * 25, 400, 20)));
    const result = ocrResult(
      items,
      items.map((item) => readingLine('horizontal', [item])),
    );
    const layout = ocrResultToPageLayout(result, {
      pageIndex: 0,
      pageWidth: 600,
      pageHeight: 800,
    });

    expect(layout.blocks.map((block) => block.text)).toEqual([texts.join(' ')]);
    expect(layout.blocks[0]?.role).toBe('prose');
    expect(layout.skipped).toEqual([]);
  });

  it('B2: keeps a short left-column body line in its column', () => {
    const items = [
      region('Left body paragraph starts here', quad(45, 100, 250, 20)),
      region('Right body paragraph starts here', quad(320, 105, 250, 20)),
      region('The model is trained', quad(45, 125, 250, 20)),
      region('with more words in the column', quad(320, 140, 250, 20)),
      region('and continues on the next line', quad(45, 150, 250, 20)),
      region('and a final line of text', quad(320, 160, 250, 20)),
    ];
    const result = ocrResult(
      items,
      items.map((item) => readingLine('horizontal', [item])),
    );
    expect(
      ocrResultToTextLines(result, { pageIndex: 0, pageWidth: 600, pageHeight: 800 }).map(
        (line) => line.text,
      ),
    ).toEqual([
      items[0]?.text,
      items[2]?.text,
      items[4]?.text,
      items[1]?.text,
      items[3]?.text,
      items[5]?.text,
    ]);
  });

  it('B1 (DSH): keeps a right-column word gap inside its own column', () => {
    const items = [
      region('left', quad(45, 340, 90, 20)),
      region('column', quad(140, 340, 100, 20)),
      region('right', quad(270, 340, 10, 20)),
      region('wide', quad(290, 340, 40, 20)),
      region('column', quad(335, 340, 50, 20)),
      region('words', quad(390, 340, 45, 20)),
      region('here', quad(440, 340, 35, 20)),
    ];
    const result = ocrResult(items, [readingLine('horizontal', items)]);
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };

    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
      'left column',
      'right wide column words here',
    ]);
    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.map((block) => block.text)).toEqual(['right wide column words here']);
    expect(layout.skipped.map((block) => block.text)).toEqual(['left column']);
  });

  it('B1 (DSH): uses a gutter whose left edge is left of 0.4 x pageWidth', () => {
    const leftText = 'Left column body text that ends before the page midpoint';
    const rightText = 'Right column body text begins just after the printed gutter';
    const items = [
      region('Left column body text that ends', quad(30, 100, 120, 20)),
      region('before the page midpoint', quad(160, 100, 65, 20)),
      region(rightText, quad(255, 100, 300, 20)),
    ];
    const result = ocrResult(items, [readingLine('horizontal', items)]);
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };

    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
      leftText,
      rightText,
    ]);
  });

  it('B2 (DSH): keeps a short left-column tail out of the right column room', () => {
    const items = [
      region('left body line one', quad(45, 100, 300, 20)),
      region('left body line two', quad(45, 125, 300, 20)),
      region('short left tail', quad(260, 150, 80, 20)),
      region('right body line one', quad(355, 100, 215, 20)),
      region('right body line two', quad(355, 125, 215, 20)),
      region('right body line three', quad(355, 150, 215, 20)),
    ];
    const result = ocrResult(
      items,
      items.map((item) => readingLine('horizontal', [item])),
    );
    const options = { pageIndex: 0, pageWidth: 595, pageHeight: 842 };
    const layout = ocrResultToPageLayout(result, options);

    expect(layout.blocks.map((block) => block.column)).toEqual([0, 1]);
    expect(layout.blocks.map((block) => block.text)).toEqual([
      'left body line one left body line two short left tail',
      'right body line one right body line two right body line three',
    ]);
    const right = layout.blocks[1];
    expect(right?.box.x).toBeCloseTo(355, 5);
    expect(right?.room.x).toBeCloseTo(355, 5);
  });

  it('B3 (DSH): keeps prose that starts with a keyword and a colon clause', () => {
    const texts = [
      'For each batch: we compute the loss and update',
      'If the input is empty: we return zero',
      'While the model trains: the logs are written',
    ];
    for (const text of texts) {
      const item = region(text, quad(45, 100, 300, 20));
      const result = ocrResult([item], [readingLine('horizontal', [item])]);
      const layout = ocrResultToPageLayout(result, {
        pageIndex: 0,
        pageWidth: 595,
        pageHeight: 842,
      });
      expect(
        layout.blocks.map((block) => block.text),
        text,
      ).toEqual([text]);
      expect(layout.blocks[0]?.role, text).toBe('prose');
      expect(layout.skipped, text).toEqual([]);
    }
  });

  it('B3 (DSH): still skips a bare code statement with a trailing colon', () => {
    const items = [
      region('for block in page:', quad(45, 100, 160, 20)),
      region('if is_equation(block):', quad(45, 125, 190, 20)),
    ];
    const result = ocrResult(
      items,
      items.map((item) => readingLine('horizontal', [item])),
    );
    const layout = ocrResultToPageLayout(result, {
      pageIndex: 0,
      pageWidth: 595,
      pageHeight: 842,
    });
    expect(layout.skipped.map((block) => block.text)).toEqual([
      'for block in page:',
      'if is_equation(block):',
    ]);
  });
  describe('latest DSH report blockers', () => {
    it('B1: keeps a single-column word gap as one line and one paragraph', () => {
      const texts = ['This sentence has', 'a wide middle', 'gap in it.'];
      const items = [
        region(texts[0]!, quad(50, 100, 230, 20)),
        region(texts[1]!, quad(286, 100, 120, 20)),
        region(texts[2]!, quad(412, 100, 80, 20)),
      ];
      const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
      const result = ocrResult(items, [readingLine('horizontal', items)]);

      expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
        texts.join(' '),
      ]);
      const layout = ocrResultToPageLayout(result, options);
      expect(layout.blocks.map((block) => block.text)).toEqual([texts.join(' ')]);
      expect(layout.blocks.map((block) => block.role)).toEqual(['prose']);
    });

    it('B1: keeps a short centred title whole and ahead of both body columns', () => {
      const titleParts = [
        region('Short Paper', quad(100, 100, 180, 20)),
        region('Title Here', quad(290, 100, 180, 20)),
      ];
      const left1 = region(
        'Left column prose with enough words to translate',
        quad(45, 150, 240, 20),
      );
      const left2 = region('More left column prose with enough words', quad(45, 175, 240, 20));
      const right1 = region(
        'Right column prose with enough words to translate',
        quad(315, 150, 240, 20),
      );
      const right2 = region('Other right column prose with enough words', quad(315, 175, 240, 20));
      const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
      const result = ocrResult(
        [...titleParts, left1, left2, right1, right2],
        [
          readingLine('horizontal', titleParts),
          readingLine('horizontal', [left1]),
          readingLine('horizontal', [left2]),
          readingLine('horizontal', [right1]),
          readingLine('horizontal', [right2]),
        ],
      );

      expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
        'Short Paper Title Here',
        left1.text,
        left2.text,
        right1.text,
        right2.text,
      ]);
      const layout = ocrResultToPageLayout(result, options);
      expect(layout.blocks[0]?.text).toBe('Short Paper Title Here');
      expect(layout.blocks[0]?.column).toBe(-1);
      expect(layout.blocks.slice(1).map((block) => block.column)).toEqual([0, 1]);
    });

    it('B1: still splits dense scan gutters when other rows prove two columns', () => {
      const options = { pageIndex: 0, pageWidth: 595, pageHeight: 842 };
      const leftWide = region('left column body words for the scan', quad(45, 100, 240, 20));
      const rightWide = region('right column body words for the scan', quad(300, 100, 240, 20));
      const leftWide2 = region('more left column body words for the scan', quad(45, 125, 240, 20));
      const rightWide2 = region(
        'more right column body words for the scan',
        quad(300, 125, 240, 20),
      );
      const denseLeft = region('dense scan row left words here', quad(45, 150, 230, 20));
      const denseRight = region('dense scan row right words here.', quad(281, 150, 240, 20));
      const result = ocrResult(
        [leftWide, rightWide, leftWide2, rightWide2, denseLeft, denseRight],
        [
          readingLine('horizontal', [leftWide, rightWide]),
          readingLine('horizontal', [leftWide2, rightWide2]),
          readingLine('horizontal', [denseLeft, denseRight]),
        ],
      );
      expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
        leftWide.text,
        leftWide2.text,
        denseLeft.text,
        rightWide.text,
        rightWide2.text,
        denseRight.text,
      ]);
    });

    it('B1: two rows with a 6pt gutter corroborate two separate body columns', () => {
      // A dense scan maps a 12px gutter to ~6pt. Each row alone is only a narrow two-piece
      // row, but two rows sharing that gap prove the page has columns; the corroboration must
      // accept MIN_COLUMN_GUTTER, not only the 10pt WIDE_COLUMN_GUTTER.
      const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
      const left1 = region('left column prose words for the first row', quad(45, 100, 200, 20));
      const right1 = region('right column prose words on the first row', quad(251, 100, 200, 20));
      const left2 = region('more left column prose words in row two', quad(45, 130, 200, 20));
      const right2 = region('more right column prose words in row two', quad(251, 130, 200, 20));
      const result = ocrResult(
        [left1, right1, left2, right2],
        [readingLine('horizontal', [left1, right1]), readingLine('horizontal', [left2, right2])],
      );

      const lines = ocrResultToTextLines(result, options);
      expect(lines.map((line) => line.text)).toEqual([
        left1.text,
        left2.text,
        right1.text,
        right2.text,
      ]);
      expect(lines).toHaveLength(4);
      expect(lines.filter((line) => line.columnHint === 0)).toHaveLength(2);
      expect(lines.filter((line) => line.columnHint === 1)).toHaveLength(2);

      const layout = ocrResultToPageLayout(result, options);
      expect(layout.blocks.map((block) => block.column)).toEqual([0, 1]);
      // Each paragraph keeps only its column's measure instead of one full-width block.
      expect(layout.blocks.map((block) => block.box.width)).toEqual([200, 200]);
      expect(layout.blocks[0]!.box.x + layout.blocks[0]!.box.width).toBeLessThanOrEqual(
        layout.blocks[1]!.box.x,
      );
    });

    it('B1: two single-column rows with a 6pt centred word gap stay in source order', () => {
      // Two rows that merely leave one ordinary 6pt word space near the page midpoint must not
      // corroborate each other as body columns. The gap is no wider than their other word gaps.
      const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
      const row = (y: number, words: readonly string[]): readonly OcrRegion[] =>
        words.map((word, index) => region(word, quad(45 + index * 86, y, 80, 20)));
      const firstWords = ['Dense', 'scans', 'often', 'emit', 'word'];
      const secondWords = ['boxes', 'with', 'equal', 'six', 'gaps.'];
      const first = row(100, firstWords);
      const second = row(130, secondWords);
      const result = ocrResult(
        [...first, ...second],
        [readingLine('horizontal', first), readingLine('horizontal', second)],
      );

      const lines = ocrResultToTextLines(result, options);
      expect(lines.map((line) => line.text)).toEqual([firstWords.join(' '), secondWords.join(' ')]);
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => line.columnHint === undefined)).toBe(true);

      const layout = ocrResultToPageLayout(result, options);
      expect(layout.blocks.map((block) => block.text)).not.toContain('Dense scans often emit');
      expect(layout.blocks.map((block) => block.text)).not.toContain('boxes with equal six');
    });

    it('B1: a 6pt centred gutter with two regions per column still splits', () => {
      // The word-space guard must be geometry-aware: when each side of the centred 6pt gap is
      // a two-word column measure, the gap is a printed gutter even though the word spaces on
      // either side happen to be exactly as wide.
      const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
      const row = (y: number, left: readonly string[], right: readonly string[]) => [
        region(left[0]!, quad(45, y, 115, 20)),
        region(left[1]!, quad(166, y, 115, 20)),
        region(right[0]!, quad(287, y, 115, 20)),
        region(right[1]!, quad(408, y, 115, 20)),
      ];
      const first = row(100, ['density values', 'of the'], ['remain stable', 'across runs']);
      const second = row(
        130,
        ['optimal transport', 'converges'],
        ['converges fast', 'in practice'],
      );
      const result = ocrResult(
        [...first, ...second],
        [readingLine('horizontal', first), readingLine('horizontal', second)],
      );

      const lines = ocrResultToTextLines(result, options);
      expect(lines.map((line) => line.text)).toEqual([
        [first[0]!.text, first[1]!.text].join(' '),
        [second[0]!.text, second[1]!.text].join(' '),
        [first[2]!.text, first[3]!.text].join(' '),
        [second[2]!.text, second[3]!.text].join(' '),
      ]);
      expect(lines.filter((line) => line.columnHint === 0)).toHaveLength(2);
      expect(lines.filter((line) => line.columnHint === 1)).toHaveLength(2);

      const layout = ocrResultToPageLayout(result, options);
      expect(layout.blocks.map((block) => block.column)).toEqual([0, 1]);
    });

    it('B1: a preposition flowing into the right pair stays in source order', () => {
      // Identical 6pt gaps and aligned x positions, but each row is one sentence cut into
      // four phrase boxes: the right pair's "with" attaches to the left pair's "boxes".
      const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
      const row = (y: number, phrases: readonly string[]) => [
        region(phrases[0]!, quad(45, y, 115, 20)),
        region(phrases[1]!, quad(166, y, 115, 20)),
        region(phrases[2]!, quad(287, y, 115, 20)),
        region(phrases[3]!, quad(408, y, 115, 20)),
      ];
      const phrases = ['Dense scans often', 'emit word boxes', 'with equal six', 'gaps for every'];
      const first = row(100, phrases);
      const second = row(130, phrases);
      const result = ocrResult(
        [...first, ...second],
        [readingLine('horizontal', first), readingLine('horizontal', second)],
      );

      const lines = ocrResultToTextLines(result, options);
      expect(lines.map((line) => line.text)).toEqual([
        first.map((item) => item.text).join(' '),
        second.map((item) => item.text).join(' '),
      ]);
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => line.columnHint === undefined)).toBe(true);

      const layout = ocrResultToPageLayout(result, options);
      expect(layout.blocks.every((block) => block.column === 0)).toBe(true);
      expect(layout.blocks.map((block) => block.text).join(' ')).toBe(
        [...first, ...second].map((item) => item.text).join(' '),
      );
    });

    it('B1: identical 2+2 geometry with one sentence per row stays in source order', () => {
      // Exactly the positive case's x positions (45/166/287/408, 6pt gaps, aligned edges), but
      // each row is one sentence cut into four phrase boxes. The right pair completes the left
      // pair's clause, so those pairs are not independent column snippets.
      const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
      const row = (y: number, phrases: readonly string[]) => [
        region(phrases[0]!, quad(45, y, 115, 20)),
        region(phrases[1]!, quad(166, y, 115, 20)),
        region(phrases[2]!, quad(287, y, 115, 20)),
        region(phrases[3]!, quad(408, y, 115, 20)),
      ];
      const first = row(100, ['The measured', 'density values', 'remain stable', 'across runs.']);
      const second = row(130, ['Repeated scans', 'of the sample', 'yield similar', 'results.']);
      const result = ocrResult(
        [...first, ...second],
        [readingLine('horizontal', first), readingLine('horizontal', second)],
      );

      const lines = ocrResultToTextLines(result, options);
      expect(lines.map((line) => line.text)).toEqual([
        first.map((item) => item.text).join(' '),
        second.map((item) => item.text).join(' '),
      ]);
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => line.columnHint === undefined)).toBe(true);

      const layout = ocrResultToPageLayout(result, options);
      expect(layout.blocks.every((block) => block.column === 0)).toBe(true);
      expect(layout.blocks.map((block) => block.text).join(' ')).toBe(
        [...first, ...second].map((item) => item.text).join(' '),
      );
    });

    it('B1: equal 6pt phrase gaps with unaligned edges stay two single-column rows', () => {
      // Four phrase regions per row can look like two 2-word columns when every gap is 6pt. Without
      // column edges that line up across rows (or a central gap wider than the internal ones), the
      // 2+2 reading is ordinary dense-scan spacing: keep both rows whole, in source order.
      const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
      const first = [
        region('dense scans emit', quad(45, 100, 110, 20)),
        region('many word boxes', quad(161, 100, 110, 20)),
        region('with equal six', quad(277, 100, 110, 20)),
        region('point gaps here', quad(393, 100, 110, 20)),
      ];
      // Same 6pt spacing, but the four phrases sit 30pt further right: neither column edge lines
      // up with the row above, so the two rows cannot corroborate a shared page gutter.
      const second = [
        region('ordinary single column', quad(75, 130, 100, 20)),
        region('rows can look', quad(181, 130, 120, 20)),
        region('like two columns', quad(307, 130, 110, 20)),
        region('when gaps match', quad(423, 130, 100, 20)),
      ];
      const result = ocrResult(
        [...first, ...second],
        [readingLine('horizontal', first), readingLine('horizontal', second)],
      );

      const lines = ocrResultToTextLines(result, options);
      expect(lines.map((line) => line.text)).toEqual([
        first.map((item) => item.text).join(' '),
        second.map((item) => item.text).join(' '),
      ]);
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => line.columnHint === undefined)).toBe(true);

      const layout = ocrResultToPageLayout(result, options);
      expect(layout.blocks.map((block) => block.column)).toEqual([0]);
      expect(layout.blocks.map((block) => block.text).join(' ')).toBe(
        [...first, ...second].map((item) => item.text).join(' '),
      );
    });

    it('B2: splits a merged body row by geometry, not by capitalisation', () => {
      const options = { pageIndex: 0, pageWidth: 595, pageHeight: 800 };
      for (const words of [
        ['Left column words here', 'Right column words here'],
        ['left column words here', 'right column words here'],
      ]) {
        const items = [
          region(words[0]!, quad(45, 100, 240, 20)),
          region(words[1]!, quad(300, 100, 240, 20)),
        ];
        const result = ocrResult(items, [readingLine('horizontal', items)]);
        expect(
          ocrResultToTextLines(result, options).map((line) => line.text),
          words.join(' '),
        ).toEqual(words);
        const layout = ocrResultToPageLayout(result, options);
        expect(
          layout.blocks.map((block) => block.column),
          words.join(' '),
        ).toEqual([0, 1]);
        expect(
          layout.blocks.map((block) => block.text),
          words.join(' '),
        ).toEqual(words);
      }
    });

    it('B3: translates short Japanese section headings instead of skipping them', () => {
      const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
      for (const heading of ['概要', '参考文献', '1. はじめに']) {
        const title = region(heading, quad(45, 100, 120, 20));
        const body = region('本文の段落がここに続きます。', quad(45, 130, 400, 20));
        const result = ocrResult(
          [title, body],
          [readingLine('horizontal', [title]), readingLine('horizontal', [body])],
        );
        const layout = ocrResultToPageLayout(result, options);
        expect(
          layout.blocks.map((block) => block.text),
          heading,
        ).toEqual([heading, body.text]);
        expect(layout.blocks[0]?.role, heading).toBe('heading');
        expect(layout.skipped, heading).toEqual([]);
      }
    });
  });

  describe('latest DSH review report blockers', () => {
    it('B1: keeps wrapped technical prose containing a comparison operator together', () => {
      const items = [
        region('If the loss < 0.1 we stop training after', quad(45, 100, 400, 20)),
        region('the first epoch and report the result.', quad(45, 125, 400, 20)),
      ];
      const result = ocrResult(
        items,
        items.map((item, index) => readingLine('horizontal', [item], [index])),
      );
      const layout = ocrResultToPageLayout(result, {
        pageIndex: 0,
        pageWidth: 600,
        pageHeight: 800,
      });
      expect(layout.blocks.map((block) => block.text)).toEqual([
        'If the loss < 0.1 we stop training after the first epoch and report the result.',
      ]);
      expect(layout.blocks[0]?.role).toBe('prose');
      expect(layout.skipped).toEqual([]);
    });

    it('B3: selects the printed gutter beside a short heading, not a body word gap', () => {
      const words = [
        'in',
        'two',
        'places',
        'so',
        'that',
        'workers',
        'and',
        'the',
        'WebAssembly',
        'module',
      ];
      for (const charWidth of [4, 7]) {
        let x = 307;
        const right = words.map((text) => {
          const item = region(text, quad(x, 340, text.length * charWidth, 12));
          x += text.length * charWidth + 6;
          return item;
        });
        const items = [region('2. Methods and Results', quad(45, 340, 135, 12)), ...right];
        const result = ocrResult(items, [readingLine('horizontal', items)]);
        const layout = ocrResultToPageLayout(result, {
          pageIndex: 0,
          pageWidth: 600,
          pageHeight: 800,
        });
        expect(
          layout.blocks.map((block) => block.text),
          String(charWidth),
        ).toEqual(['2. Methods and Results', words.join(' ')]);
        expect(
          layout.blocks.map((block) => block.column),
          String(charWidth),
        ).toEqual([0, 1]);
        expect(
          layout.blocks.map((block) => block.role),
          String(charWidth),
        ).toEqual(['heading', 'prose']);
      }
    });

    it('B3: does not split a single-column line at a wide word gap', () => {
      const items = [
        region('A single column line', quad(100, 100, 200, 12)),
        region('with a wide middle', quad(310, 100, 120, 12)),
        region('gap in it.', quad(430, 100, 80, 12)),
      ];
      const result = ocrResult(items, [readingLine('horizontal', items)]);
      const layout = ocrResultToPageLayout(result, {
        pageIndex: 0,
        pageWidth: 600,
        pageHeight: 800,
      });
      expect(layout.blocks.map((block) => block.text)).toEqual([
        'A single column line with a wide middle gap in it.',
      ]);
      expect(layout.skipped).toEqual([]);
    });
  });

  it('B3: splits at the real off-centre gutter, not the page midpoint', () => {
    const leftText =
      'Left column words that end past the midpoint more left column words left tail word';
    const rightText = 'Right column body text starts after a real gutter';
    const items = [
      region('Left column words that end past the midpoint', quad(30, 100, 100, 20)),
      region('more left column words', quad(140, 100, 100, 20)),
      region('left tail word', quad(255, 100, 92, 20)),
      region(rightText, quad(355, 100, 215, 20)),
    ];
    const result = ocrResult([...items], [readingLine('horizontal', items)]);
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };

    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
      leftText,
      rightText,
    ]);
    expect(ocrResultToPageLayout(result, options).blocks.map((block) => block.column)).toEqual([
      0, 1,
    ]);
  });
});

describe('bracketed citations in OCR prose', () => {
  it('B2: keeps wrapped prose with a bracketed citation out of the skipped code list', () => {
    const texts = [
      'If the result [12] is positive we accept',
      'For each layer [see Figure 2] we compute the loss',
    ];
    for (const text of texts) {
      const item = region(text, quad(45, 100, 320, 20));
      const result = ocrResult([item], [readingLine('horizontal', [item])]);
      const layout = ocrResultToPageLayout(result, {
        pageIndex: 0,
        pageWidth: 600,
        pageHeight: 800,
      });
      expect(
        layout.blocks.map((block) => block.text),
        text,
      ).toEqual([text]);
      expect(layout.blocks[0]?.role, text).toBe('prose');
      expect(layout.skipped, text).toEqual([]);
    }
  });

  it('B2: still skips a listing whose brackets are an index or a block', () => {
    const texts = ['if (x) {', 'for row[i] in rows:', 'if values[0] > 1 then'];
    for (const text of texts) {
      const item = region(text, quad(45, 100, 220, 20));
      const result = ocrResult([item], [readingLine('horizontal', [item])]);
      const layout = ocrResultToPageLayout(result, {
        pageIndex: 0,
        pageWidth: 600,
        pageHeight: 800,
      });
      expect(
        [...layout.skipped.map((block) => block.text), ...layout.blocks.map((block) => block.text)],
        text,
      ).toContain(text);
      expect(
        layout.skipped.some((block) => block.role === 'code'),
        text,
      ).toBe(true);
    }
  });
});

describe('current DSH review blockers', () => {
  it('B1: keeps a single-column paragraph whose last line is short in one block', () => {
    const items = [
      region(
        'This is a full width line of ordinary prose on a single column page',
        quad(50, 100, 500, 20),
      ),
      region(
        'and another full width line of ordinary prose in the same paragraph',
        quad(50, 125, 500, 20),
      ),
      region('short last line of the paragraph.', quad(50, 150, 200, 20)),
    ];
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const result = ocrResult(
      items,
      items.map((item, index) => readingLine('horizontal', [item], [index])),
    );
    const lines = ocrResultToTextLines(result, options);
    expect(lines.map((line) => line.text)).toEqual(items.map((item) => item.text));
    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0]?.text).toBe(items.map((item) => item.text).join(' '));
    expect(layout.blocks[0]?.role).toBe('prose');
    expect(layout.blocks[0]?.column).toBe(0);
  });

  it('B2: a rotated margin stamp does not merge the horizontal body columns', () => {
    const left1 = region('Left column body line one with words', quad(45, 100, 240, 20));
    const right1 = region('Right column body line one with words', quad(315, 100, 240, 20));
    const left2 = region('Left column body line two with words', quad(45, 125, 240, 20));
    const right2 = region('Right column body line two with words', quad(315, 125, 240, 20));
    const stamp = region('縦書き', quad(580, 300, 15, 80), true);
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const result = ocrResult(
      [left1, right1, left2, right2, stamp],
      [
        readingLine('horizontal', [left1]),
        readingLine('horizontal', [right1]),
        readingLine('horizontal', [left2]),
        readingLine('horizontal', [right2]),
        readingLine('vertical', [stamp]),
      ],
    );
    const layout = ocrResultToPageLayout(result, options);
    const body = layout.blocks.filter((block) => block.role === 'prose' && block.lines.length > 1);
    expect(body.map((block) => block.text)).toEqual([
      [left1.text, left2.text].join(' '),
      [right1.text, right2.text].join(' '),
    ]);
    expect(body.map((block) => block.column)).toEqual([0, 1]);
  });

  it('B3: keeps a long full-width title with a colon and many words whole', () => {
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    for (const title of [
      'Attention Is All You Need But This Title Has More Than Twelve Words',
      'Attention: Is All You Need But This Title Has More Than Twelve Words',
    ]) {
      const words = title.split(' ');
      let x = 50;
      const pieces = words.map((text) => {
        const item = region(text, quad(x, 100, text.length * 7, 20));
        x += text.length * 7 + 10;
        return item;
      });
      expect(x - 10).toBeLessThanOrEqual(options.pageWidth);
      const result = ocrResult(pieces, [readingLine('horizontal', pieces)]);
      expect(
        ocrResultToTextLines(result, options).map((line) => line.text),
        title,
      ).toEqual([title]);
      const layout = ocrResultToPageLayout(result, options);
      expect(
        layout.blocks.map((block) => block.text),
        title,
      ).toEqual([title]);
    }
  });

  it('B3: keeps a single-column line with 20pt word gaps whole', () => {
    const texts = ['This sentence has', 'a wide middle', 'gap in it.'];
    const items = [
      region(texts[0]!, quad(100, 100, 180, 20)),
      region(texts[1]!, quad(310, 100, 120, 20)),
      region(texts[2]!, quad(450, 100, 80, 20)),
    ];
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };
    const result = ocrResult(items, [readingLine('horizontal', items)]);
    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
      texts.join(' '),
    ]);
    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.map((block) => block.text)).toEqual([texts.join(' ')]);
  });

  it('B1: keeps a full-width three-piece body line whole at a 10pt word gap', () => {
    const texts = ['This is a single column', 'full width printed', 'line of text.'];
    const items = [
      region(texts[0]!, quad(45, 100, 200, 20)),
      region(texts[1]!, quad(255, 100, 180, 20)),
      region(texts[2]!, quad(445, 100, 110, 20)),
    ];
    const result = ocrResult(items, [readingLine('horizontal', items)]);
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };

    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
      texts.join(' '),
    ]);
    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.map((block) => block.text)).toEqual([texts.join(' ')]);
    expect(layout.blocks.map((block) => block.column)).toEqual([0]);
  });

  it('B2: treats 1.5pt OCR jitter as one printed row, not two source rows', () => {
    const words = [
      'Translation',
      'attention',
      'mechanism',
      'described',
      'ordinary',
      'prose',
      'line',
      'continues.',
    ];
    const items = words.map((text, index) =>
      region(text, quad(35 + index * 63, index < 4 ? 100 : 101.5, 56, 12)),
    );
    const result = ocrResult(items, [readingLine('horizontal', items)]);
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };

    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
      words.join(' '),
    ]);
    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.map((block) => block.text)).toEqual([words.join(' ')]);
    expect(layout.blocks.map((block) => block.column)).toEqual([0]);
  });

  it('B3: two centred title rows do not make a body word gap a column gutter', () => {
    const title = [
      region('A Short', quad(200, 70, 90, 20)),
      region('Paper Title', quad(302, 70, 120, 20)),
    ];
    const subtitle = [
      region('For Every', quad(200, 100, 90, 20)),
      region('Reader Here', quad(302, 100, 120, 20)),
    ];
    const bodyTexts = ['This sentence has', 'three pieces', 'and a period.'];
    const body = [
      region(bodyTexts[0]!, quad(100, 160, 140, 20)),
      region(bodyTexts[1]!, quad(247, 160, 110, 20)),
      region(bodyTexts[2]!, quad(364, 160, 120, 20)),
    ];
    const result = ocrResult(
      [...title, ...subtitle, ...body],
      [
        readingLine('horizontal', title),
        readingLine('horizontal', subtitle),
        readingLine('horizontal', body),
      ],
    );
    const options = { pageIndex: 0, pageWidth: 600, pageHeight: 800 };

    expect(ocrResultToTextLines(result, options).map((line) => line.text)).toEqual([
      'A Short Paper Title',
      'For Every Reader Here',
      bodyTexts.join(' '),
    ]);
    const layout = ocrResultToPageLayout(result, options);
    expect(layout.blocks.at(-1)?.text).toBe(bodyTexts.join(' '));
    expect(layout.skipped).toEqual([]);
  });
});
