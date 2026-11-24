// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_OCR_DIMENSION, MAX_OCR_PIXELS } from '@/engine/offscreen/protocol';
import { renderPage, type PdfPage } from '@/pdf/extract';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('renderPage OCR raster budget', () => {
  it('bounds an A4 scale-2 raster on a DPR-3 display before OCR encoding', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D,
    );
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page: PdfPage = {
      getViewport: ({ scale }) => ({ width: 595.28 * scale, height: 841.89 * scale }),
      getTextContent: async () => ({ items: [], styles: {} }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: { get: () => null },
      render,
    };
    const canvas = document.createElement('canvas');

    await renderPage(page, 2, canvas, {
      maxPixels: MAX_OCR_PIXELS,
      maxDimension: MAX_OCR_DIMENSION,
    }).promise;

    // The uncapped request would be 3571×5051 = 18,037,121 pixels.
    expect(595.28 * 2 * 3).toBeGreaterThan(3500);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(MAX_OCR_PIXELS);
    expect(canvas.width).toBeLessThanOrEqual(MAX_OCR_DIMENSION);
    expect(canvas.height).toBeLessThanOrEqual(MAX_OCR_DIMENSION);
    expect(render).toHaveBeenCalledOnce();
  });
});
