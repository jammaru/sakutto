import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractPage, placeTextItem, type PdfPage } from '@/pdf/extract';
import { layoutPage } from '@/pdf/layout';
import { clippedPaintWidth, placePage } from '@/pdf/place';
import { stubExpand } from '@/pdf/stub';
import { measure } from './support/pdf-pieces';
import { openPdfBytes } from './support/open-fixture-pdf';
import { rotatedBodyPdf } from './support/rotated-body-pdf';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function item(
  str: string,
  e: number,
  f: number,
  width = 36,
  height = 12,
): {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
} {
  return {
    str,
    transform: [height, 0, 0, height, e, f],
    width,
    height,
    fontName: 'F1',
  };
}

describe('placeTextItem', () => {
  it('flips an unrotated page from PDF space into top-left space', () => {
    const placed = placeTextItem(item('Hello', 50, 100), {
      width: 200,
      height: 400,
    });
    expect(placed.box.x).toBeCloseTo(50);
    expect(placed.box.y).toBeCloseTo(400 - 100 - 12);
    expect(placed.box.width).toBeCloseTo(36);
    expect(placed.baseline).toBeCloseTo(300);
  });

  it('maps a /Rotate 90 glyph onto the viewport instead of off the page', () => {
    // MediaBox 300×200, rotated 90°: viewport is 200×300. A run at (250, 40) in PDF
    // space sits near the right of the unrotated page; without the viewport matrix
    // it would be painted at x=250 on a 200-wide canvas.
    const viewport = {
      width: 200,
      height: 300,
      transform: [0, 1, -1, 0, 200, 0],
    };
    const placed = placeTextItem(item('Hello', 250, 40), viewport);
    expect(placed.box.x).toBeGreaterThanOrEqual(0);
    expect(placed.box.y).toBeGreaterThanOrEqual(0);
    expect(placed.box.x + placed.box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(placed.box.y + placed.box.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(placed.box.x).toBeLessThan(viewport.width);

    const unfixed = placeTextItem(item('Hello', 250, 40), {
      width: viewport.width,
      height: viewport.height,
    });
    expect(unfixed.box.x).toBeGreaterThan(viewport.width);
  });
});

/**
 * pdf.js `PageViewport` transform for a MediaBox origin at (0, 0). Copied so the suite can
 * pin `/Rotate` grouping without booting the worker on every case.
 */
function pdfJsViewport(
  pageWidth: number,
  pageHeight: number,
  rotation: 0 | 90 | 180 | 270,
  scale = 1,
): { width: number; height: number; transform: number[] } {
  const centerX = pageWidth / 2;
  const centerY = pageHeight / 2;
  let rotateA: number;
  let rotateB: number;
  let rotateC: number;
  let rotateD: number;
  switch (rotation) {
    case 180:
      rotateA = -1;
      rotateB = 0;
      rotateC = 0;
      rotateD = 1;
      break;
    case 90:
      rotateA = 0;
      rotateB = 1;
      rotateC = 1;
      rotateD = 0;
      break;
    case 270:
      rotateA = 0;
      rotateB = -1;
      rotateC = -1;
      rotateD = 0;
      break;
    default:
      rotateA = 1;
      rotateB = 0;
      rotateC = 0;
      rotateD = -1;
      break;
  }
  let offsetCanvasX: number;
  let offsetCanvasY: number;
  let width: number;
  let height: number;
  if (rotateA === 0) {
    offsetCanvasX = Math.abs(centerY) * scale;
    offsetCanvasY = Math.abs(centerX) * scale;
    width = pageHeight * scale;
    height = pageWidth * scale;
  } else {
    offsetCanvasX = Math.abs(centerX) * scale;
    offsetCanvasY = Math.abs(centerY) * scale;
    width = pageWidth * scale;
    height = pageHeight * scale;
  }
  return {
    width,
    height,
    transform: [
      rotateA * scale,
      rotateB * scale,
      rotateC * scale,
      rotateD * scale,
      offsetCanvasX - rotateA * scale * centerX - rotateC * scale * centerY,
      offsetCanvasY - rotateB * scale * centerX - rotateD * scale * centerY,
    ],
  };
}

function fakePage(
  items: ReturnType<typeof item>[],
  viewport: { width: number; height: number; transform?: number[] },
): PdfPage {
  return {
    getViewport: () => viewport,
    getTextContent: async () => ({ items, styles: {} }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    commonObjs: { get: () => null },
    render: () => ({ promise: Promise.resolve() }),
  };
}

const BODY_LINES = Array.from({ length: 12 }, (_, index) => {
  const number = String(index + 1).padStart(2, '0');
  return `Line ${number} of the sample body.`;
});

function columnItems(): ReturnType<typeof item>[] {
  return BODY_LINES.map((text, index) => item(text, 50, 520 - index * 14, 180, 10));
}

describe('extractPage rotation', () => {
  it('keeps covers on a synthetic /Rotate 90 page', async () => {
    const viewport = pdfJsViewport(300, 200, 90);
    const extracted = await extractPage(fakePage([item('Hello', 250, 40)], viewport), 0, null);
    const line = extracted.lines[0];
    if (!line) throw new Error('expected a text line');
    expect(line.text).toBe('Hello');
    expect(line.box.x).toBeGreaterThanOrEqual(0);
    expect(line.box.x + line.box.width).toBeLessThanOrEqual(extracted.width + 1);
    expect(line.box.y).toBeGreaterThanOrEqual(0);
    expect(line.box.y + line.box.height).toBeLessThanOrEqual(extracted.height + 1);
  });

  it.each([90, 270] as const)(
    'keeps 12 body lines and a 10 pt body size on /Rotate %s',
    async (rotation) => {
      const viewport = pdfJsViewport(400, 600, rotation);
      const extracted = await extractPage(fakePage(columnItems(), viewport), 0, null);
      expect(extracted.lines).toHaveLength(12);
      expect(extracted.lines.map((line) => line.text).sort()).toEqual([...BODY_LINES].sort());
      const layout = layoutPage(extracted.lines, extracted.figures, {
        width: extracted.width,
        height: extracted.height,
        index: 0,
      });
      expect(layout.bodySize).toBe(10);
    },
  );

  it.each([0, 180] as const)('still groups 12 body lines on /Rotate %s', async (rotation) => {
    const viewport = pdfJsViewport(400, 600, rotation);
    const extracted = await extractPage(fakePage(columnItems(), viewport), 0, null);
    expect(extracted.lines).toHaveLength(12);
    const layout = layoutPage(extracted.lines, extracted.figures, {
      width: extracted.width,
      height: extracted.height,
      index: 0,
    });
    expect(layout.bodySize).toBe(10);
  });
});

describe('committed layout fixtures', () => {
  it('keeps paper.pdf page 1 at 85 lines and 21 blocks', async () => {
    const bytes = new Uint8Array(await readFile(resolve(root, 'bench/pdf/paper.pdf')));
    const document = await openPdfBytes(bytes);
    try {
      const page = (await document.getPage(1)) as PdfPage;
      const extracted = await extractPage(page, 0, null);
      expect(extracted.lines).toHaveLength(85);
      const layout = layoutPage(extracted.lines, extracted.figures, {
        width: extracted.width,
        height: extracted.height,
        index: 0,
      });
      expect(layout.blocks).toHaveLength(21);
    } finally {
      await document.destroy();
    }
  });

  it('extracts 12 lines at 10 pt from a /Rotate 90 and 270 fixture', async () => {
    const bytes = rotatedBodyPdf([90, 270]);
    const document = await openPdfBytes(bytes);
    try {
      expect(document.numPages).toBe(2);
      for (let number = 1; number <= 2; number += 1) {
        const page = (await document.getPage(number)) as PdfPage;
        const extracted = await extractPage(page, number - 1, null);
        expect(extracted.lines, `page ${String(number)}`).toHaveLength(12);
        const layout = layoutPage(extracted.lines, extracted.figures, {
          width: extracted.width,
          height: extracted.height,
          index: number - 1,
        });
        expect(layout.bodySize, `page ${String(number)}`).toBe(10);
        const placed = placePage({
          layout,
          translationOf: (block) => stubExpand(block.text),
          target: 'ja',
          measure: (_block, text, size) => measure(text, size),
          pageHeight: extracted.height,
          pageWidth: extracted.width,
        });
        expect(placed.length).toBeGreaterThan(0);
        for (const entry of placed) {
          expect(clippedPaintWidth(entry, measure)).toBeLessThanOrEqual(0.01);
          if (entry.translation.trim().length > 0) {
            expect(entry.paint || entry.overflow).toBe(true);
          }
        }
      }
    } finally {
      await document.destroy();
    }
  });
});
