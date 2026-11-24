import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildTranslatedPdf,
  exportIncludesAllTranslations,
  missingExportTranslations,
  type ExportPage,
} from '../src/pdf/export';
import { openPdfBytes } from './support/open-fixture-pdf';

const font = readFileSync(new URL('../vendor/fonts/MPLUS1p-Regular.ttf', import.meta.url));
// A one-pixel PNG stands in for the viewer's full-page raster; only the bytes matter here.
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR8kAAAAASUVORK5CYII=',
    'base64',
  ),
);

/** Translations as they appear on the two pages of the image-only paper bench fixture. */
const sessionBlocks = [
  { translation: '1. Introduction' },
  {
    translation:
      'By using WebAssembly within the browser, models can be executed locally without sending the source text anywhere.',
  },
  { translation: '2. Method' },
  { translation: 'Figure 1: Translation pipeline' },
  // A translation that did not fit still belongs in the file's search layer.
  { translation: 'A long paragraph that the reader shows behind an overflow marker' },
  { translation: '   ' },
];

function rasterPages(): ExportPage[] {
  return [
    {
      index: 0,
      width: 595,
      height: 842,
      image: png,
      texts: sessionBlocks
        .slice(0, 2)
        .map((block) => block.translation)
        .filter((text) => text.trim().length > 0),
    },
    {
      index: 1,
      width: 595,
      height: 842,
      image: png,
      texts: sessionBlocks
        .slice(2)
        .map((block) => block.translation)
        .filter((text) => text.trim().length > 0),
    },
  ];
}

describe('WYSIWYG translated PDF export', () => {
  it('keeps every translated heading in the search layer of the raster PDF', async () => {
    const pages = rasterPages();
    const bytes = await buildTranslatedPdf({
      pages,
      font,
      targetLanguage: 'en',
      title: 'image-only-paper_en.pdf',
    });
    const document = await openPdfBytes(bytes);
    try {
      expect(document.numPages).toBe(2);
      for (let number = 1; number <= document.numPages; number += 1) {
        const page = (await document.getPage(number)) as {
          getTextContent(): Promise<{ items: Array<{ str?: string; height?: number }> }>;
        };
        const content = await page.getTextContent();
        const text = content.items.map((item) => item.str ?? '').join('');
        for (const expected of pages[number - 1]?.texts ?? []) {
          expect(text).toContain(expected);
        }
        // The visible page is the raster: search glyphs are deliberately one point tall.
        const visible = content.items.filter((item) => (item.height ?? 0) > 1.5);
        expect(visible).toHaveLength(0);
      }
    } finally {
      await document.destroy();
    }
  });

  it('reports exactly which session translations an export missed', () => {
    const pages = rasterPages();
    expect(exportIncludesAllTranslations(pages, sessionBlocks)).toBe(true);
    expect(missingExportTranslations(pages, sessionBlocks)).toEqual([]);
    const withoutHeading = pages.map((page, index) =>
      index === 0 ? { ...page, texts: page.texts.slice(1) } : page,
    );
    expect(missingExportTranslations(withoutHeading, sessionBlocks)).toEqual(['1. Introduction']);
    expect(exportIncludesAllTranslations(withoutHeading, sessionBlocks)).toBe(false);
  });
});
