import { describe, expect, it, vi } from 'vitest';
import type { ImageDataLike, OcrQuad, OcrRegion, OcrResult, ReadingLine } from '@/engine/ocr/types';
import type { FigureAreas } from '@/pdf/figures';
import { lineFrom, type TextLine, type TextPiece } from '@/pdf/lines';
import {
  createPdfPageOcr,
  ocrResultToLayoutBlocks,
  ocrResultToPageLayout,
  ocrResultToTextLines,
  shouldRunPdfOcr,
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

  it('never requests OCR for mixed image and prose pages, even below the character cutoff', () => {
    expect(
      shouldRunPdfOcr([nativeLine('One two three')], FULL_PAGE_IMAGE, PAGE.width, PAGE.height),
    ).toBe(false);
    expect(
      shouldRunPdfOcr(
        [nativeLine('A caption explains the scan clearly.')],
        FULL_PAGE_IMAGE,
        PAGE.width,
        PAGE.height,
      ),
    ).toBe(false);
  });

  it('recognizes prose split across several short native lines on a mixed page', () => {
    const lines = [
      nativeLine('Useful native'),
      nativeLine('text remains'),
      nativeLine('readable here'),
    ];
    expect(shouldRunPdfOcr(lines, FULL_PAGE_IMAGE, PAGE.width, PAGE.height)).toBe(false);
  });

  it('does not OCR a non-image page merely because its native runs are labels', () => {
    expect(
      shouldRunPdfOcr([nativeLine('12345 67890 12345')], NO_IMAGES, PAGE.width, PAGE.height),
    ).toBe(false);
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
});
