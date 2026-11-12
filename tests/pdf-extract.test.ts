import { describe, expect, it } from 'vitest';
import { extractPage, placeTextItem, type PdfPage } from '@/pdf/extract';

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

describe('extractPage rotation', () => {
  it('keeps covers on a synthetic /Rotate 90 page', async () => {
    const viewport = {
      width: 200,
      height: 300,
      transform: [0, 1, -1, 0, 200, 0],
    };
    const page: PdfPage = {
      getViewport: () => viewport,
      getTextContent: async () => ({
        items: [item('Hello', 250, 40)],
        styles: {},
      }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: { get: () => null },
      render: () => ({ promise: Promise.resolve() }),
    };
    const extracted = await extractPage(page, 0, null);
    const line = extracted.lines[0];
    if (!line) throw new Error('expected a text line');
    expect(line.text).toBe('Hello');
    expect(line.box.x).toBeGreaterThanOrEqual(0);
    expect(line.box.x + line.box.width).toBeLessThanOrEqual(extracted.width + 1);
    expect(line.box.y).toBeGreaterThanOrEqual(0);
    expect(line.box.y + line.box.height).toBeLessThanOrEqual(extracted.height + 1);
  });
});
