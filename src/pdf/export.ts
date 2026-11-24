import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';
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
  /** Full-page PNG of the translated stage: page bitmap plus the reader painted covers. */
  image: Uint8Array;
  /** Every non-empty session translation on the page, including overflowed blocks. */
  texts: readonly string[];
  /** Kept for cached bench layouts; the PDF writer no longer uses blocks to draw. */
  blocks?: readonly ExportBlock[] | undefined;
}

export interface TranslatedPdfOptions {
  pages: readonly ExportPage[];
  /** Bytes of the bundled Japanese-capable face, used only by the invisible search layer. */
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
 * Checks that every translated block in a session made it into the snapshot.
 *
 * Export pages carry all non-empty session translations, including blocks that only have a
 * marker because they did not fit. The PDF writer uses the same array for its search-only
 * text, so this also checks what a reader can find in the saved file.
 */
export interface SessionTextBlock {
  translation?: string | undefined;
}

export function missingExportTranslations(
  pages: readonly Pick<ExportPage, 'texts'>[],
  sessionBlocks: readonly SessionTextBlock[],
): string[] {
  const present = new Set<string>();
  for (const page of pages) {
    for (const text of page.texts) {
      const trimmed = text.trim();
      if (trimmed.length > 0) present.add(trimmed);
    }
  }
  return sessionBlocks
    .map((block) => (block.translation ?? '').trim())
    .filter((text) => text.length > 0 && !present.has(text));
}

export function exportIncludesAllTranslations(
  pages: readonly Pick<ExportPage, 'texts'>[],
  sessionBlocks: readonly SessionTextBlock[],
): boolean {
  return missingExportTranslations(pages, sessionBlocks).length === 0;
}

/**
 * Writes a real PDF whose visible page is the raster the reader painted.
 *
 * Every visible mark comes from the exported page image: pdf.js drew the original and the
 * reader composited its own translated covers onto it. The bundled face is embedded only
 * for an invisible text layer so a reader can still search and copy a translation. Nothing
 * here fetches a URL or re-lays text out, so a document already on the device stays there.
 */
export async function buildTranslatedPdf(options: TranslatedPdfOptions): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  if (options.title) document.setTitle(options.title);
  if (options.pages.length === 0) throw new Error('no pages to export');

  // The whole face is embedded, rather than a runtime subset: fontkit's subsetter silently
  // mis-maps some CJK glyphs in the faces that cover both kana and Latin. It is never used
  // to paint a visible glyph, only to make the search layer extractable.
  const font = await document.embedFont(options.font, { subset: false });

  for (const source of options.pages) {
    const page = document.addPage([source.width, source.height]);
    const image = await document.embedPng(source.image);
    page.drawImage(image, { x: 0, y: 0, width: source.width, height: source.height });

    // Search/copy support only. Opacity zero leaves the raster as the single visible source
    // of truth; the positions are approximate because the screenshot owns the layout.
    const texts: readonly string[] = source.texts ?? [];
    for (const [index, translation] of texts.entries()) {
      const text = translation.trim();
      if (text.length === 0) continue;
      try {
        page.drawText(text, {
          x: 1,
          y: Math.max(0.5, source.height - 1 - (index % 8)),
          size: 1,
          font,
          opacity: 0,
        });
      } catch {
        // A glyph outside the face cannot be encoded; the raster still shows it.
      }
    }
  }
  return document.save();
}

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
