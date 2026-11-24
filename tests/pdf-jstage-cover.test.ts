import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PdfPage } from '@/pdf/extract';
import { extractPage } from '@/pdf/extract';
import { rasterCoverage } from '@/pdf/figures';
import { layoutPage } from '@/pdf/layout';
import { shouldRunPdfOcr } from '@/pdf/ocr';
import { loadPdfjs, openPdfBytes } from './support/open-fixture-pdf';

const root = resolve(import.meta.dirname, '..');
const cMaps = resolve(root, 'public/vendor/pdfjs/cmaps') + '/';

describe('J-STAGE advance-publication cover', () => {
  it('has a native text layer and never gates translation on OCR', async () => {
    const bytes = new Uint8Array(await readFile(resolve(root, 'bench/pdf/jstage-cover.pdf')));
    const { OPS } = await loadPdfjs();
    const document = await openPdfBytes(bytes, cMaps);
    try {
      expect(document.numPages).toBe(6);
      const page = (await document.getPage(1)) as PdfPage;
      const extracted = await extractPage(page, 0, OPS);

      // Two large decorative grayscale rasters frame roughly 150 characters of real text.
      expect(extracted.lines.length).toBeGreaterThanOrEqual(3);
      expect(extracted.lines.map((line) => line.text).join(' ')).toContain(
        'This article has been accepted and published on J-STAGE',
      );
      expect(extracted.empty).toBe(false);
      expect(extracted.figures.images.length).toBeGreaterThanOrEqual(2);
      expect(rasterCoverage(extracted.figures, extracted.width, extracted.height)).toBeGreaterThan(
        0.35,
      );

      const layout = layoutPage(extracted.lines, extracted.figures, {
        width: extracted.width,
        height: extracted.height,
        index: 0,
      });
      expect(layout.blocks.length).toBeGreaterThan(0);
      expect(
        shouldRunPdfOcr(extracted.lines, extracted.figures, extracted.width, extracted.height),
      ).toBe(false);
    } finally {
      await document.destroy();
    }
  });
});
