import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, degrees, type PDFPage, type PDFFont, rgb } from 'pdf-lib';
import type { Box } from './geometry';
import {
  BODY_MIN_FONT_SIZE,
  BODY_MIN_SCALE,
  MIN_FONT_SIZE,
  MIN_SCALE,
  applyKinsoku,
  hasKinsokuHeadViolation,
  wrapBudget,
  wrapText,
} from './fit';
import type { AnyBlockRole } from './layout';
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
  /** Role of the source block, which decides how far export type may shrink. */
  role?: AnyBlockRole | undefined;
  /** A label inside a figure is one line, shrunk rather than wrapped into the artwork. */
  singleLine?: boolean | undefined;
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

/** Measures one line at a given point size with the face the PDF will actually embed. */
export type ExportMeasurer = (text: string, fontSize: number) => number;

export interface ExportTextRequest {
  /** Full translation, re-wrapped when the embedded face disagrees with the viewer's font. */
  translation: string;
  /** Lines the reader fitted, kept verbatim when they already fit the exported face. */
  lines: readonly string[];
  /** Font size the reader fitted, in points. */
  fontSize: number;
  /** Baseline distance the reader fitted, in points. */
  lineHeight: number;
  /** Space available along the writing direction, in points. */
  width: number;
  /** Space available across it, in points. */
  height: number;
  targetLanguage: string;
  role?: AnyBlockRole | undefined;
  singleLine?: boolean | undefined;
  measure: ExportMeasurer;
}

export interface ExportTextLayout {
  /** Wrapped lines, all measured to fit width. */
  lines: string[];
  fontSize: number;
  lineHeight: number;
  height: number;
  /** True when lines were dropped because even the smallest size could not fit height. */
  clipped: boolean;
}

const EPSILON = 0.001;
/** Same tolerance as fitText: a fit may miss the ceiling by a fraction of a point. */
const HEIGHT_SLACK = 1;

/** Script used for the line-break rules, matching the reader's measurer. */
function exportScript(target: string): 'ja' | 'en' | 'other' {
  if (target === 'ja') return 'ja';
  if (target === 'en') return 'en';
  return 'other';
}

/** Smallest useful size for this block, mirroring fit.ts's role-aware floor. */
function preferredMinimum(size: number, role: AnyBlockRole | undefined): number {
  const body = role === 'prose' && size >= 9 - 1e-9;
  const floor = body ? BODY_MIN_FONT_SIZE : MIN_FONT_SIZE;
  const scale = body ? BODY_MIN_SCALE : MIN_SCALE;
  return Math.min(size, Math.max(size * scale, Math.min(size, floor)));
}

/**
 * Wraps one exported block to the room its source/drawn box actually provides.
 *
 * The viewer measures with the browser's font stack; the file is drawn with the bundled M PLUS
 * face, whose Latin glyphs are wider. Lines that were fine on screen can therefore run into the
 * next column once written to PDF. This re-measures with the embedded font and keeps the reader's
 * line breaks only when they still fit; otherwise it re-wraps and, if needed, shrinks the type.
 * Anchor, size and leading still come from the reader's fit, so the block lands in the same place.
 */
export function layoutExportText(request: ExportTextRequest): ExportTextLayout {
  const width = wrapBudget(Math.max(1, request.width));
  const ceiling = Math.max(1, request.height);
  const sourceSize = Math.max(1, request.fontSize);
  const ratio = Math.max(1, request.lineHeight / sourceSize);
  const leadingAt = (size: number) => Math.max(size, size * ratio);
  const script = exportScript(request.targetLanguage);
  const kinsoku = script === 'ja';
  const measure = request.measure;
  const text = (request.translation || request.lines.join(' ')).trim();

  const wrapAt = (size: number): string[] => {
    if (request.singleLine === true) {
      const one = text.replace(/\s+/gu, ' ').trim();
      return one.length > 0 ? [one] : [];
    }
    const measureAt = (value: string) => measure(value, size);
    const lines = wrapText(text, width, measureAt, kinsoku);
    return kinsoku ? applyKinsoku(lines, width, measureAt) : lines;
  };
  const stackHeight = (lines: readonly string[], size: number): number =>
    lines.length <= 1 ? size : lines.length * leadingAt(size);
  const fits = (lines: readonly string[], size: number): boolean =>
    lines.length > 0 &&
    lines.every((line) => measure(line, size) <= width + EPSILON) &&
    (!kinsoku || !hasKinsokuHeadViolation(lines)) &&
    stackHeight(lines, size) <= ceiling + HEIGHT_SLACK;

  // Exact viewer fidelity first: its line breaks are the ones the user approved on screen.
  if (request.lines.length > 0 && fits(request.lines, sourceSize)) {
    return {
      lines: [...request.lines],
      fontSize: sourceSize,
      lineHeight: leadingAt(sourceSize),
      height: stackHeight(request.lines, sourceSize),
      clipped: false,
    };
  }

  // Walk down from the reader's size. A size below the usual readability floor is still better
  // than a glyph painted over the neighbouring column: the box always wins.
  let floor = Math.max(1, preferredMinimum(sourceSize, request.role) * 0.7);
  // A figure label cannot wrap, so it needs a floor derived from the width of the whole line:
  // otherwise the shrink search stops while the glyphs still spill over the figure's artwork.
  if (request.singleLine === true && text.length > 0) {
    const unit = measure(text.replace(/\s+/gu, ' ').trim(), 1);
    if (unit > 0) floor = Math.max(1, Math.min(floor, (width * 0.98) / unit));
  }
  for (let step = 0; step <= 8; step += 1) {
    const size = sourceSize - ((sourceSize - floor) * step) / 8;
    const lines = wrapAt(size);
    if (!fits(lines, size)) continue;
    return {
      lines,
      fontSize: size,
      lineHeight: leadingAt(size),
      height: stackHeight(lines, size),
      clipped: false,
    };
  }

  // Last resort: the smallest size and as many lines as the box can hold. Never emit a glyph
  // that the embedded face would paint outside the box.
  const size = floor;
  const leading = leadingAt(size);
  const count = Math.max(1, Math.floor((ceiling + HEIGHT_SLACK) / leading));
  const lines = wrapAt(size)
    .filter((line) => measure(line, size) <= width + EPSILON)
    .slice(0, count);
  return {
    lines,
    fontSize: size,
    lineHeight: leading,
    height: stackHeight(lines, size),
    clipped: true,
  };
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
      const vertical = block.writing === 90 || block.writing === 270;
      const grow =
        block.drawn === null
          ? Math.min(
              source.height - cover.y,
              Math.max(cover.height, block.lines.length * Math.max(1, block.lineHeight)),
            )
          : cover.height;
      // Both the cover and the glyphs are clipped to the page as well as to the source box.
      const x = Math.max(0, cover.x);
      const y = Math.max(0, cover.y);
      const box: Box = {
        x,
        y,
        width: Math.max(1, Math.min(source.width, cover.x + cover.width) - x),
        height: Math.max(1, Math.min(source.height, cover.y + grow) - y),
      };
      if (box.width <= 1 || box.height <= 1) continue;

      const layout = layoutExportText({
        translation: block.translation,
        lines: block.lines,
        fontSize: block.fontSize,
        lineHeight: block.lineHeight,
        width: vertical ? box.height : box.width,
        height: vertical ? box.width : box.height,
        targetLanguage: options.targetLanguage,
        role: block.role,
        singleLine: block.singleLine,
        measure: (text, fontSize) => font.widthOfTextAtSize(text, fontSize),
      });
      if (layout.lines.length === 0) continue;

      // The translated cover is opaque on screen so the source glyphs underneath cannot show
      // through. The PDF does the same before it lays down its own text.
      page.drawRectangle({
        x: box.x,
        y: source.height - box.y - box.height,
        width: box.width,
        height: box.height,
        color: rgb(1, 1, 1),
      });

      if (vertical) {
        drawVertical(page, source.height, block, box, font, layout);
        continue;
      }
      for (const [index, line] of layout.lines.entries()) {
        if (line.length === 0) continue;
        const width = font.widthOfTextAtSize(line, layout.fontSize);
        if (width > box.width) continue;
        let textX = box.x;
        if (block.align === 'center') textX += (box.width - width) / 2;
        if (block.align === 'right') textX += box.width - width;
        textX = Math.max(box.x, Math.min(textX, box.x + box.width - width));
        // CSS puts the first baseline inside its line box. The 0.82em ascent is a close
        // approximation for the bundled Gothic face, and avoids clipping the top of kanji.
        const baseline =
          box.y +
          layout.fontSize * 0.82 +
          (layout.lineHeight - layout.fontSize) / 2 +
          index * layout.lineHeight;
        // Only the descender sits below the baseline; a full em would reject a one-line label
        // whose box is exactly one em tall.
        if (baseline + layout.fontSize * 0.25 > box.y + box.height + EPSILON) break;
        page.drawText(line, {
          x: textX,
          y: source.height - baseline,
          size: layout.fontSize,
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
  box: Box,
  font: PDFFont,
  layout: ExportTextLayout,
): void {
  const clockwise = block.writing === 90;
  const size = layout.fontSize;
  const leading = layout.lineHeight;
  for (const [index, line] of layout.lines.entries()) {
    if (line.length === 0) continue;
    const width = font.widthOfTextAtSize(line, size);
    if (width > box.height + EPSILON) continue;
    // A rotated run starts at its baseline; the offset keeps it inside the column it occupied.
    const x = clockwise ? box.x + index * leading : box.x + box.width - size - index * leading;
    if (x < box.x - EPSILON || x + size > box.x + box.width + EPSILON) break;
    const y = clockwise
      ? pageHeight - box.y - box.height + Math.min(size, width)
      : pageHeight - box.y - size;
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
