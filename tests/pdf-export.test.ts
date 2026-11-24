import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTranslatedPdf, translatedPdfName, type ExportPage } from '../src/pdf/export';
import { openPdfBytes } from './support/open-fixture-pdf';

const font = readFileSync(new URL('../vendor/fonts/MPLUS1p-Regular.ttf', import.meta.url));
// A one-pixel opaque PNG: the export only needs valid image bytes to embed the original page.
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
    blocks: [
      {
        source: { x: 40, y: 60, width: 340, height: 40 },
        drawn: { x: 40, y: 60, width: 340, height: 42 },
        translation: '翻訳後のPDFをダウンロード',
        lines: ['翻訳後のPDFをダウンロード'],
        fontSize: 11,
        lineHeight: 14,
        align: 'left',
        traits: { family: 'sans-serif', bold: false, italic: false },
        writing: 0,
      },
      {
        source: { x: 40, y: 120, width: 340, height: 30 },
        drawn: { x: 40, y: 120, width: 340, height: 32 },
        translation: '二列目の訳文',
        lines: ['二列目の訳文'],
        fontSize: 10,
        lineHeight: 13,
        align: 'center',
        traits: { family: 'serif', bold: true, italic: false },
        writing: 0,
      },
    ],
  };
}

describe('translated PDF export', () => {
  it('writes a real PDF with one page per captured page and selectable Japanese text', async () => {
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

  it('keeps translated glyphs inside narrow two-column boxes', async () => {
    const translation =
      'By using WebAssembly within the browser, models can be executed on the local device. GPU acceleration varies with the endpoint and the amount of memory available, so the same paper reads differently on two machines. The translation must stay inside its own column.';
    const columns = [
      { x: 60, width: 220 },
      { x: 320, width: 210 },
    ] as const;
    const blocks = columns.map((column) => ({
      source: { x: column.x, y: 100, width: column.width, height: 72 },
      drawn: { x: column.x, y: 100, width: column.width, height: 72 },
      // Viewer lines were wrapped with a narrower browser font; the embedded face is wider.
      lines: [translation],
      translation,
      fontSize: 10,
      lineHeight: 13,
      align: 'left' as const,
      traits: { family: 'sans-serif' as const, bold: false, italic: false },
      writing: 0,
      role: 'prose' as const,
    }));
    const bytes = await buildTranslatedPdf({
      pages: [{ index: 0, width: 595, height: 842, image: png, blocks }],
      font,
      targetLanguage: 'en',
    });
    const document = await openPdfBytes(bytes);
    try {
      const first = (await document.getPage(1)) as {
        getTextContent(): Promise<{
          items: Array<{ str?: string; transform: number[]; width: number }>;
        }>;
      };
      const items = (await first.getTextContent()).items.filter(
        (item) => (item.str ?? '').trim().length > 0,
      );
      expect(items.length).toBeGreaterThan(2);
      for (const item of items) {
        const left = item.transform[4] ?? 0;
        const right = left + (item.width ?? 0);
        const column = left < 300 ? columns[0] : columns[1];
        expect(left).toBeGreaterThanOrEqual(column.x - 1);
        expect(right).toBeLessThanOrEqual(column.x + column.width + 1);
      }
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
