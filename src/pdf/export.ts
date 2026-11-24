import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, degrees, type PDFPage, type PDFFont, rgb } from 'pdf-lib';
import type { Box } from './geometry';
import type { BlockTraits } from './session';

/**
 * One translated block as it is painted by the reader.
 *
 * The export deliberately takes the reader's fitted lines and boxes rather than re-running the
 * layout: a translation that was accepted on screen must land in the same place in the file,
 * including the columns the page detector found on a scan.
 */
export interface ExportBlock {
  /** The source text region, in page points. */
  source: Box;
  /** The box the translation actually covers, in page points. */
  drawn: Box | null;
  translation: string;
  lines: readonly string[];
  fontSize: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  traits: BlockTraits;
  /** Writing mode of the source, in degrees; non-zero means vertical text. */
  writing: number;
}

export interface ExportPage {
  index: number;
  width: number;
  height: number;
  /** The original page, rasterized by pdf.js as a PNG. */
  image: Uint8Array;
  blocks: readonly ExportBlock[];
}

export interface TranslatedPdfOptions {
  pages: readonly ExportPage[];
  /** Bytes of the bundled Japanese-capable OTF font. */
  font: Uint8Array;
  targetLanguage: string;
  title?: string | undefined;
}

/**
 * Writes a real PDF with the original page appearance and translated text over it.
 *
 * Every resource comes from the caller: the page bitmaps were drawn by pdf.js from the open
 * document, and the font is a packaged file. Nothing here fetches a URL, so a document that is
 * already on the device stays on the device.
 */
export async function buildTranslatedPdf(options: TranslatedPdfOptions): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  if (options.title) document.setTitle(options.title);
  if (options.pages.length === 0) throw new Error('no pages to export');

  // The whole face is embedded, rather than a runtime subset: fontkit's subsetter silently
  // mis-maps some CJK glyphs in the faces that cover both kana and Latin, which is worse than
  // the 1.7 MB this compact font adds to the file. It stays entirely inside the extension.
  const font = await document.embedFont(options.font, { subset: false });

  for (const source of options.pages) {
    const page = document.addPage([source.width, source.height]);
    const image = await document.embedPng(source.image);
    page.drawImage(image, { x: 0, y: 0, width: source.width, height: source.height });

    for (const block of source.blocks) {
      if (block.lines.length === 0) continue;
      const cover = block.drawn ?? block.source;
      const size = Math.max(1, block.fontSize);
      const leading = Math.max(size, block.lineHeight);
      const height =
        block.drawn === null
          ? Math.min(source.height - cover.y, Math.max(cover.height, block.lines.length * leading))
          : cover.height;
      if (height <= 0) continue;

      // The translated cover is opaque on screen so the source glyphs underneath cannot show
      // through. The PDF does the same before it lays down its own text.
      page.drawRectangle({
        x: cover.x,
        y: source.height - cover.y - height,
        width: Math.max(1, cover.width),
        height,
        color: rgb(1, 1, 1),
      });

      if (block.writing === 90 || block.writing === 270) {
        drawVertical(page, source.height, block, font, size, leading);
        continue;
      }
      for (const [index, line] of block.lines.entries()) {
        if (line.length === 0) continue;
        const width = font.widthOfTextAtSize(line, size);
        let x = cover.x;
        if (block.align === 'center') x += Math.max(0, (cover.width - width) / 2);
        if (block.align === 'right') x += Math.max(0, cover.width - width);
        // CSS puts the first baseline inside its line box. The 0.82em ascent is a close
        // approximation for the bundled Gothic face, and avoids clipping the top of kanji.
        const baseline = cover.y + size * 0.82 + (leading - size) / 2 + index * leading;
        if (baseline > source.height) break;
        page.drawText(line, {
          x,
          y: source.height - baseline,
          size,
          font,
          color: rgb(0, 0, 0),
        });
      }
    }
  }
  return document.save();
}

/** Places a wrapped Japanese column back on the page when the source was set vertically. */
function drawVertical(
  page: PDFPage,
  pageHeight: number,
  block: ExportBlock,
  font: PDFFont,
  size: number,
  leading: number,
): void {
  const cover = block.drawn ?? block.source;
  const clockwise = block.writing === 90;
  for (const [index, line] of block.lines.entries()) {
    if (line.length === 0) continue;
    const width = font.widthOfTextAtSize(line, size);
    // A rotated run starts at its baseline; the offset keeps it inside the column it occupied.
    const x = clockwise
      ? cover.x + index * leading
      : cover.x + cover.width - size - index * leading;
    const y = clockwise
      ? pageHeight - cover.y - cover.height + Math.min(size, width)
      : pageHeight - cover.y - size;
    page.drawText(line, {
      x,
      y,
      size,
      font,
      color: rgb(0, 0, 0),
      rotate: degrees(clockwise ? -90 : 90),
    });
  }
}

/** Converts a canvas `toDataURL('image/png')` result into the bytes pdf-lib embeds. */
export function pngBytesFromDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error('page image is not a PNG data URL');
  }
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** `<basename>_<targetLanguage>.pdf`, without path parts or characters a filename cannot hold. */
export function translatedPdfName(fileName: string, targetLanguage: string): string {
  const base = [...fileName.replace(/\.pdf$/iu, '')]
    .map((character) =>
      /[\\/:*?"<>|]/u.test(character) || character.charCodeAt(0) < 32 ? '_' : character,
    )
    .join('')
    .trim();
  const language = targetLanguage.replace(/[^A-Za-z0-9_-]/gu, '');
  return `${base.length > 0 ? base : 'document'}_${language.length > 0 ? language : 'translated'}.pdf`;
}
