import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTranslatedPdf, translatedPdfName, type ExportPage } from '../src/pdf/export';
import { loadPdfjs, openPdfBytes } from './support/open-fixture-pdf';

const font = readFileSync(new URL('../vendor/fonts/MPLUS1p-Regular.ttf', import.meta.url));
// A one-pixel opaque PNG: the export only needs valid image bytes for the viewer raster.
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR8kAAAAASUVORK5CYII=',
    'base64',
  ),
);

function page(): ExportPage {
  return {
    index: 0,
    width: 420,
    height: 595,
    image: png,
    texts: ['翻訳後のPDFをダウンロード', '二列目の訳文'],
  };
}

describe('translated PDF export', () => {
  it('writes a real PDF with one page per captured page and searchable translations', async () => {
    const original = page();
    const bytes = await buildTranslatedPdf({
      pages: [original, { ...original, index: 1 }],
      font,
      targetLanguage: 'ja',
      title: 'paper.pdf',
    });

    expect(Buffer.from(bytes.subarray(0, 8)).toString('latin1')).toMatch(/^%PDF-\d/);
    const document = await openPdfBytes(bytes);
    try {
      expect(document.numPages).toBe(2);
      const first = (await document.getPage(1)) as {
        getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
      };
      const text = (await first.getTextContent()).items.map((item) => item.str ?? '').join('');
      expect(text).toContain('翻訳後のPDFをダウンロード');
      expect(text).toContain('二列目の訳文');
    } finally {
      await document.destroy();
    }
  });

  it('embeds one full-page raster instead of a second text layout', async () => {
    const body =
      'By using WebAssembly within the browser, models can be executed on the local device without sending the source text anywhere. The translation must stay inside its own column.';
    const bytes = await buildTranslatedPdf({
      pages: [
        {
          index: 0,
          width: 595,
          height: 842,
          image: png,
          texts: ['1. Introduction', body],
        },
      ],
      font,
      targetLanguage: 'en',
    });
    const document = await openPdfBytes(bytes);
    try {
      const pdfjs = await loadPdfjs();
      const first = (await document.getPage(1)) as {
        getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
        getOperatorList(): Promise<{ fnArray: number[] }>;
      };
      const operators = await first.getOperatorList();
      const images = operators.fnArray.filter((fn) => fn === pdfjs.OPS.paintImageXObject);
      expect(images).toHaveLength(1);
      const text = (await first.getTextContent()).items.map((item) => item.str ?? '').join('');
      expect(text).toContain('1. Introduction');
      expect(text).toContain(body);
    } finally {
      await document.destroy();
    }
  });

  it('refuses an empty snapshot rather than producing an empty file', async () => {
    await expect(buildTranslatedPdf({ pages: [], font, targetLanguage: 'ja' })).rejects.toThrow(
      /no pages/u,
    );
  });

  it('names the file after the source and the target language', () => {
    expect(translatedPdfName('paper.pdf', 'ja')).toBe('paper_ja.pdf');
    expect(translatedPdfName('reports/2026 notes.PDF', 'zh-Hans')).toBe(
      'reports_2026 notes_zh-Hans.pdf',
    );
    expect(translatedPdfName('.pdf', 'ja')).toBe('document_ja.pdf');
  });
});
