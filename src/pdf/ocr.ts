import { OCR_PAGE_TIMEOUT_MS } from '@/engine/offscreen/protocol';
import { groupReadingLines } from '@/engine/ocr/order';
import type { ImageDataLike, OcrQuad, OcrRegion, OcrResult, ReadingLine } from '@/engine/ocr/types';
import { isImageOnlyPage, normalizeGlyphRun, type ExtractedPage } from './extract';
import type { FigureAreas } from './figures';
import { median, type Box } from './geometry';
import {
  layoutPage,
  looksLikeCodeLine,
  type AnyBlockRole,
  type LayoutBlock,
  type PageLayout,
} from './layout';
import { bodyFontSize, lineFrom, type TextLine, type TextPiece } from './lines';
import { hasSourceProse } from './prose-detect';

/**
 * OCR is a fallback, not a replacement for a usable PDF text layer.
 *
 * Keep the image-only geometry/character rules in one place by delegating to the extractor.
 * A substantial raster can coexist with a native header or caption. Such pages need an OCR
 * pass too; native coverage is removed after recognition rather than guessed from page text.
 */
export function shouldRunPdfOcr(
  lines: readonly TextLine[],
  figures: FigureAreas,
  width: number,
  height: number,
): boolean {
  if (isImageOnlyPage(lines, figures, width, height)) return true;
  const pageArea = Math.max(1, width * height);
  // Tiled scans can cover most of a page without any single image reaching 35% of it.
  const rasterArea = figures.images.reduce((sum, image) => sum + image.width * image.height, 0);
  if (rasterArea < pageArea * 0.35) return false;
  // A page already covered by a usable native text layer is an ordinary text page with a
  // background image; OCR would be discarded by the deduplication below after a full model
  // download and render. Keep the scan pass for pages whose native text is only a header,
  // caption, or stamp.
  return nativeTextCoverage(lines, width, height) < 0.15;
}

function nativeTextCoverage(lines: readonly TextLine[], width: number, height: number): number {
  // Sum line areas rather than their bounding box: a header and a footer must not make the
  // empty middle of a mixed page look text-covered.
  const area = lines.reduce(
    (sum, line) => sum + Math.max(0, line.box.width) * Math.max(0, line.box.height),
    0,
  );
  return area / Math.max(1, width * height);
}

/** A text piece with deterministic identity and both image-space and page-space geometry. */
export interface OcrTextPiece extends TextPiece {
  /** Stable for the same page, OCR reading line, and detector region index. */
  readonly id: string;
  /** The detector quad mapped into top-left PDF page coordinates. */
  readonly quad: OcrQuad;
  /** The unchanged detector quad in rendered-image pixels. */
  readonly sourceQuad: OcrQuad;
}

export interface OcrTextLine extends TextLine {
  readonly id: string;
  pieces: OcrTextPiece[];
}

/** LayoutBlock is structurally extended so PdfSession can consume it without changes. */
export interface OcrLayoutBlock extends LayoutBlock {
  readonly id: string;
  lines: OcrTextLine[];
}

export interface OcrPageLayout extends PageLayout {
  blocks: OcrLayoutBlock[];
}

export interface OcrConversionOptions {
  /** Zero-based PDF page number, used in every generated ID. */
  readonly pageIndex: number;
  readonly pageWidth: number;
  readonly pageHeight: number;
  /** Rendered raster size. Defaults to the page size, i.e. a scale of one. */
  readonly imageWidth?: number | undefined;
  readonly imageHeight?: number | undefined;
}

interface ResolvedConversion {
  readonly pageIndex: number;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

function conversion(options: OcrConversionOptions): ResolvedConversion {
  if (!Number.isSafeInteger(options.pageIndex) || options.pageIndex < 0) {
    throw new RangeError('OCR pageIndex must be a non-negative integer');
  }
  for (const [name, value] of [
    ['pageWidth', options.pageWidth],
    ['pageHeight', options.pageHeight],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`OCR ${name} must be a positive finite number`);
    }
  }
  const imageWidth = options.imageWidth ?? options.pageWidth;
  const imageHeight = options.imageHeight ?? options.pageHeight;
  if (
    !Number.isFinite(imageWidth) ||
    imageWidth <= 0 ||
    !Number.isFinite(imageHeight) ||
    imageHeight <= 0
  ) {
    throw new RangeError('OCR image dimensions must be positive finite numbers');
  }
  return {
    pageIndex: options.pageIndex,
    pageWidth: options.pageWidth,
    pageHeight: options.pageHeight,
    scaleX: options.pageWidth / imageWidth,
    scaleY: options.pageHeight / imageHeight,
  };
}

function scaleQuad(quad: OcrQuad, scaleX: number, scaleY: number): OcrQuad {
  return quad.map((point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new RangeError('OCR quads must contain finite coordinates');
    }
    return { x: point.x * scaleX, y: point.y * scaleY };
  }) as unknown as OcrQuad;
}

function cloneQuad(quad: OcrQuad): OcrQuad {
  return quad.map((point) => ({ ...point })) as unknown as OcrQuad;
}

function quadBox(quad: OcrQuad): Box {
  const xs = quad.map((point) => point.x);
  const ys = quad.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    x: left,
    y: top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  };
}

function distance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

/** Em size is perpendicular to the writing advance, not the AABB's larger dimension. */
function ocrFontSize(quad: OcrQuad, vertical: boolean): number {
  const size = vertical
    ? (distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2
    : (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2;
  return Math.max(0.1, size);
}

function regionPiece(
  region: OcrRegion,
  vertical: boolean,
  id: string,
  scaleX: number,
  scaleY: number,
): OcrTextPiece {
  const sourceQuad = cloneQuad(region.quad);
  const quad = scaleQuad(region.quad, scaleX, scaleY);
  return {
    id,
    text: normalizeGlyphRun(region.text.trim()),
    box: quadBox(quad),
    // PDF extraction uses the advance origin: the bottom edge horizontally and the right
    // edge for text running down a vertical column.
    baseline: vertical ? (quad[1].x + quad[2].x) / 2 : (quad[2].y + quad[3].y) / 2,
    fontName: id,
    family: 'serif',
    bold: false,
    italic: false,
    // OCR carries no font evidence. In particular, guessing math from symbols would make
    // ordinary scanned prose eligible for the equation-skipping rules.
    math: false,
    orientation: vertical ? 90 : 0,
    size: ocrFontSize(quad, vertical),
    displayed: vertical ? 90 : 0,
    quad,
    sourceQuad,
  };
}

function readingLines(result: OcrResult): readonly ReadingLine<OcrRegion>[] {
  // OcrPipeline normally supplies lines. The fallback also makes the adapter useful with a
  // detector/recognizer caller that only retained regions, using the engine's canonical order.
  return result.lines.length > 0 ? result.lines : groupReadingLines(result.regions);
}

/** A short numbered/section-like heading can sit beside a full body line on the same baseline. */
function isShortHeadingPieces(pieces: readonly OcrTextPiece[]): boolean {
  if (pieces.length === 0) return false;
  const text = pieces
    .map((piece) => piece.text)
    .join(' ')
    .trim();
  return (
    text.length > 0 &&
    text.length <= 48 &&
    (SECTION_LINE.test(text) || (!/[.!?。]$/u.test(text) && text.split(/\s+/u).length <= 8))
  );
}

/** Same printed row: the two sides' baseline centres agree within a small fraction of a line. */
function sharesBaseline(left: readonly OcrTextPiece[], right: readonly OcrTextPiece[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const centre = (group: readonly OcrTextPiece[]): number =>
    group.reduce((sum, piece) => sum + piece.baseline, 0) / group.length;
  const height = median([...left, ...right].map((piece) => piece.box.height));
  return Math.abs(centre(left) - centre(right)) <= Math.max(2, height * 0.75);
}

/**
 * Splits a wide reading line that combined two body rows at slightly different baselines.
 *
 * The detector emits one quad per word, and a reading-line merger can join the left and right
 * column words of the same printed row. Their x gap is then only a word space, so a gutter
 * distance test alone misses them. The two source rows usually differ by a point or two in y;
 * when the pieces form two horizontally disjoint rows with a clear baseline step, they are
 * separate native lines and must not become one translated block.
 */
function splitMergedBodyLine(
  pieces: readonly OcrTextPiece[],
  pageWidth: number,
): readonly [OcrTextPiece[], OcrTextPiece[]] | null {
  if (pieces.length < 4) return null;
  const height = median(pieces.map((piece) => piece.box.height));
  const tops = pieces.map((piece) => piece.box.y).sort((left, right) => left - right);
  let step = 0;
  let boundary = -1;
  for (let index = 1; index < tops.length; index += 1) {
    const gap = (tops[index] ?? 0) - (tops[index - 1] ?? 0);
    if (gap > step) {
      step = gap;
      boundary = index;
    }
  }
  if (boundary < 0 || step <= Math.max(0.5, height * 0.08)) return null;
  const splitAt = ((tops[boundary - 1] ?? 0) + (tops[boundary] ?? 0)) / 2;
  const upper = pieces.filter((piece) => piece.box.y < splitAt);
  const lower = pieces.filter((piece) => piece.box.y >= splitAt);
  if (upper.length < 2 || lower.length < 2) return null;
  const span = (group: readonly OcrTextPiece[]): { left: number; right: number } => ({
    left: Math.min(...group.map((piece) => piece.box.x)),
    right: Math.max(...group.map((piece) => piece.box.x + piece.box.width)),
  });
  const first = span(upper);
  const second = span(lower);
  // Two column rows sit side by side; the words of one wavy full-width line would interleave
  // in x and give both clusters the same centre. Long lines may still overlap at the gutter,
  // so compare centres rather than requiring perfectly disjoint boxes.
  const firstCentre = (first.left + first.right) / 2;
  const secondCentre = (second.left + second.right) / 2;
  if (Math.abs(firstCentre - secondCentre) < pageWidth * 0.2) return null;
  if (
    first.right - first.left < pageWidth * 0.18 ||
    second.right - second.left < pageWidth * 0.18
  ) {
    return null;
  }
  return firstCentre <= secondCentre ? [upper, lower] : [lower, upper];
}

/**
 * Narrowest white gap that still separates two printed columns.
 *
 * A 15pt gutter is common in two-column papers. Requiring a page-width fraction here used
 * to leave those rows merged, so the translation cover painted across the gap.
 */
const MIN_COLUMN_GUTTER = 15;

/**
 * Converts OCR reading lines to the PDF reader's native line model.
 *
 * Reading-line and item order are authoritative; `result.regions` is not re-sorted when lines
 * are present. That is important for vertical Japanese, whose columns read right to left.
 */
export function ocrResultToTextLines(
  result: OcrResult,
  options: OcrConversionOptions,
): OcrTextLine[] {
  const resolved = conversion(options);
  const output: OcrTextLine[] = [];
  const lines = readingLines(result);
  for (const [lineIndex, readingLine] of lines.entries()) {
    const lineId = `ocr:p${String(resolved.pageIndex)}:l${String(lineIndex)}`;
    const pieces: OcrTextPiece[] = [];
    for (const [itemIndex, region] of readingLine.items.entries()) {
      if (region.text.trim().length === 0) continue;
      const detectorIndex = readingLine.indices[itemIndex];
      const regionIndex =
        detectorIndex !== undefined && Number.isSafeInteger(detectorIndex) && detectorIndex >= 0
          ? detectorIndex
          : itemIndex;
      const id = `${lineId}:r${String(regionIndex)}`;
      pieces.push(regionPiece(region, region.vertical, id, resolved.scaleX, resolved.scaleY));
    }
    if (pieces.length === 0) continue;
    const pieceVertical = pieces.every((piece) => piece.displayed === 90);
    const middle = resolved.pageWidth / 2;
    const lineWidth =
      Math.max(...pieces.map((piece) => piece.box.x + piece.box.width)) -
      Math.min(...pieces.map((piece) => piece.box.x));
    const leftPieces = pieces.filter((piece) => piece.box.x + piece.box.width / 2 < middle);
    const rightPieces = pieces.filter((piece) => piece.box.x + piece.box.width / 2 >= middle);
    const leftEnd =
      leftPieces.length > 0
        ? Math.max(...leftPieces.map((piece) => piece.box.x + piece.box.width))
        : Number.NEGATIVE_INFINITY;
    const rightStart =
      rightPieces.length > 0
        ? Math.min(...rightPieces.map((piece) => piece.box.x))
        : Number.POSITIVE_INFINITY;
    const leftText = leftPieces
      .map((piece) => piece.text)
      .join(' ')
      .trim();
    const rightText = rightPieces
      .map((piece) => piece.text)
      .join(' ')
      .trim();
    const leftWidth =
      rightPieces.length > 0 && leftPieces.length > 0
        ? Math.max(...leftPieces.map((piece) => piece.box.x + piece.box.width)) -
          Math.min(...leftPieces.map((piece) => piece.box.x))
        : 0;
    const rightWidth =
      rightPieces.length > 0 && leftPieces.length > 0
        ? Math.max(...rightPieces.map((piece) => piece.box.x + piece.box.width)) - rightStart
        : 0;
    const gutterGap = rightPieces.length > 0 && leftPieces.length > 0 ? rightStart - leftEnd : 0;
    // A reading line can combine the two body columns even when their pieces together span
    // nearly the whole page: the old `< 82% of page width` guard left those merged and painted
    // one cover across the gutter. Require a real white gap at the centre, with substantial text
    // on both sides, so a full-width title whose words merely straddle the middle stays whole.
    const wideTwoColumnLine =
      lineWidth >= resolved.pageWidth * 0.82 &&
      leftWidth > resolved.pageWidth * 0.18 &&
      rightWidth > resolved.pageWidth * 0.18 &&
      leftEnd <= middle + 4 &&
      rightStart >= middle - 4 &&
      gutterGap >= MIN_COLUMN_GUTTER;
    // A short left heading beside a normal body line is a two-column row too: the 18% width
    // floor for `wideTwoColumnLine` cannot see it, but the gutter and shared baseline can.
    const shortHeadingBesideBody =
      !pieceVertical &&
      leftEnd <= middle + 4 &&
      rightStart >= middle - 4 &&
      leftWidth >= 40 &&
      rightWidth > resolved.pageWidth * 0.18 &&
      isShortHeadingPieces(leftPieces) &&
      rightText.length >= Math.max(24, leftText.length * 2) &&
      sharesBaseline(leftPieces, rightPieces);
    const crossesGutter =
      resolved.pageWidth > 0 &&
      !pieceVertical &&
      gutterGap >= MIN_COLUMN_GUTTER &&
      (lineWidth < resolved.pageWidth * 0.82 || wideTwoColumnLine || shortHeadingBesideBody);
    const pushLine = (selected: OcrTextPiece[], id: string): void => {
      if (selected.length === 0) return;
      const line = lineFrom(selected);
      const text = selected.map((piece) => piece.text).join(pieceVertical ? '' : ' ');
      output.push({ ...line, text, id, pieces: selected });
    };
    if (resolved.pageWidth > 0 && !pieceVertical && lineWidth >= resolved.pageWidth * 0.82) {
      const rows = splitMergedBodyLine(pieces, resolved.pageWidth);
      if (rows) {
        pushLine(rows[0], lineId + ':left');
        pushLine(rows[1], lineId + ':right');
        continue;
      }
    }
    if (crossesGutter) {
      pushLine(leftPieces, lineId + ':left');
      pushLine(rightPieces, lineId + ':right');
      continue;
    }
    pushLine(pieces, lineId);
  }
  return twoColumnOrder(output, resolved.pageWidth);
}

interface OcrBlockGroup {
  lines: OcrTextLine[];
  role: AnyBlockRole;
  column: number;
}

function verticalLine(line: OcrTextLine): boolean {
  return line.pieces.length > 0 && line.pieces.every((piece) => piece.displayed === 90);
}

/** Column of a line that spans the page: a title, abstract or byline, not a body column. */
const SPANNING_COLUMN = -1;

/** Geometric column of a line. Full-width lines get a group of their own. */
function lineColumn(line: OcrTextLine, pageWidth: number): number {
  if (pageWidth <= 0) return 0;
  const mid = line.box.x + line.box.width / 2;
  if (line.box.width > pageWidth * 0.6) return SPANNING_COLUMN;
  return mid < pageWidth / 2 ? 0 : 1;
}

/**
 * Two-column reading order: finish one band's left column before starting its right column.
 *
 * Splitting a merged line only emits the pieces in place, so a later left-column line would
 * otherwise follow the right-column piece. Full-width lines delimit bands, keeping a heading
 * above the columns it introduces and a full-width footer below them. Vertical Japanese keeps
 * the engine's authoritative right-to-left order instead.
 */
function twoColumnOrder(lines: readonly OcrTextLine[], pageWidth: number): OcrTextLine[] {
  if (pageWidth <= 0 || lines.length < 2 || lines.some(verticalLine)) return [...lines];
  const ordered: OcrTextLine[] = [];
  let run: OcrTextLine[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    ordered.push(
      ...run
        .map((line, index) => ({ line, index, column: lineColumn(line, pageWidth) }))
        .sort((a, b) => a.column - b.column || a.line.box.y - b.line.box.y || a.index - b.index)
        .map((entry) => entry.line),
    );
    run = [];
  };
  for (const line of lines) {
    if (lineColumn(line, pageWidth) === SPANNING_COLUMN) {
      flush();
      ordered.push(line);
    } else {
      run.push(line);
    }
  }
  flush();
  return ordered;
}

const CAPTION_LINE = /^(?:Fig(?:ure)?|Tab(?:le)?|Alg(?:orithm)?)\.?\s*\d/iu;
const SECTION_LINE = /^\d+(?:\.\d+)*\.?\s+\p{Lu}/u;

/**
 * A listing line whose OCR lost its indentation but kept code punctuation.
 *
 * Treating leading `for`, `if`, `return`, ... as proof of code skips ordinary paper sentences
 * (`For each batch we compute the loss`), so the punctuation is required: colons, brackets,
 * semicolons and operators are what distinguish a bare statement from prose. Sentences that
 * end in a full stop are prose regardless of their first word.
 */
function looksLikeBareCodeLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length >= 140 || /[.!?。]$/u.test(trimmed)) return false;
  const statement = trimmed.replace(/^\d+\s+/u, '');
  if (!/^(?:for|foreach|if|while|emit|return|continue|def)\b/iu.test(statement)) return false;
  if (/^(?:for example|for instance|if so|if any)\b/iu.test(statement)) return false;
  return /[;{}\]()=+*\x2f%<>_:]/u.test(statement);
}

function groupText(lines: readonly OcrTextLine[]): string {
  const vertical = lines.length > 0 && lines.every(verticalLine);
  let output = '';
  for (const line of lines) {
    const value = line.text.trim();
    if (value.length === 0) continue;
    if (output.length === 0) {
      output = value;
      continue;
    }
    const hyphenated = /[-‐‑‒–]\p{L}?$/u.test(output) && /^[\p{Ll}]/u.test(value);
    output = hyphenated
      ? output.replace(/[-‐‑‒–]\p{L}?$/u, '') + value
      : output + (vertical ? '' : ' ') + value;
  }
  return output.replace(/\s+/gu, ' ').trim();
}

function groupRole(group: readonly OcrTextLine[], bodySize: number): AnyBlockRole {
  const text = groupText(group);
  if (CAPTION_LINE.test(text)) return 'caption';
  if (group.some((line) => looksLikeCodeLine(line.text) || looksLikeBareCodeLine(line.text))) {
    return 'code';
  }
  if (/^[^\p{L}]*\d+[^\p{L}]*$/u.test(text)) return 'label';
  const first = group[0];
  // A row of values or short numbers is table typesetting, not a sentence to translate.
  const tokens = text.split(/\s+/u).filter(Boolean);
  const numeric = tokens.filter((token) => /\d/u.test(token)).length;
  if (
    tokens.length >= 2 &&
    numeric * 2 >= tokens.length &&
    (bodySize <= 0 || (first?.height ?? 0) < bodySize * 0.95)
  ) {
    return 'label';
  }
  if (
    group.length === 1 &&
    text.length <= 80 &&
    (SECTION_LINE.test(text) || (bodySize > 0 && (first?.height ?? 0) >= bodySize * 1.15))
  ) {
    return 'heading';
  }
  return hasSourceProse(text) ? 'prose' : 'label';
}

function groupBlocks(
  lines: readonly OcrTextLine[],
  pageWidth: number,
  bodySize: number,
): OcrBlockGroup[] {
  const groups: OcrBlockGroup[] = [];
  for (const line of twoColumnOrder(lines, pageWidth)) {
    const last = groups.at(-1);
    const previous = last?.lines.at(-1);
    const vertical = verticalLine(line);
    const gap =
      previous && !vertical && !verticalLine(previous)
        ? line.box.y - (previous.box.y + previous.box.height)
        : Number.POSITIVE_INFINITY;
    const sizeStep =
      previous && Math.abs(line.height - previous.height) > Math.max(2, previous.height * 0.18);
    const startsNew =
      !last ||
      last.role === 'caption' ||
      last.role === 'heading' ||
      previous === undefined ||
      vertical !== verticalLine(previous) ||
      lineColumn(line, pageWidth) !== last.column ||
      sizeStep ||
      gap > Math.max(4, previous.height * 1.7) ||
      /[.!?。]$/u.test(previous.text.trimEnd()) ||
      CAPTION_LINE.test(line.text) ||
      SECTION_LINE.test(line.text) ||
      looksLikeCodeLine(line.text) ||
      looksLikeBareCodeLine(line.text) ||
      looksLikeCodeLine(previous.text) ||
      looksLikeBareCodeLine(previous.text);
    if (startsNew) {
      groups.push({
        lines: [line],
        role: groupRole([line], bodySize),
        column: lineColumn(line, pageWidth),
      });
      continue;
    }
    last.lines.push(line);
    last.role = groupRole(last.lines, bodySize);
  }
  return groups;
}

/** Blocks that share a horizontal band in short runs are table cells, not paragraphs. */
function detectTableRows(blocks: readonly OcrLayoutBlock[], bodySize: number): OcrLayoutBlock[] {
  const rows: OcrLayoutBlock[][] = [];
  for (const block of blocks) {
    const center = block.box.y + block.box.height / 2;
    const row = rows.find(
      (candidate) =>
        candidate[0]?.column === block.column &&
        Math.abs(candidate[0].box.y + candidate[0].box.height / 2 - center) < 8,
    );
    if (row) row.push(block);
    else rows.push([block]);
  }
  return rows
    .filter((row) => {
      if (row.length < 2) return false;
      if (row.some((block) => block.role === 'heading' || block.role === 'caption')) return false;
      return row.every(
        (block) =>
          block.text.length <= 32 &&
          (bodySize <= 0 || block.fontSize < bodySize * 1.05) &&
          !/[.!?]$/u.test(block.text),
      );
    })
    .flat();
}
/**
 * Groups OCR reading lines into paragraphs, in the order the detector already established.
 *
 * One block per line made every translation fight for a box one line tall: long Japanese text
 * shrank below legibility or opened a marker, and neighbouring covers collided. Grouping by
 * column, vertical gap and sentence boundary keeps a paragraph together and gives its cover a
 * whole paragraph of source area to paint over.
 */
export function ocrLinesToLayoutBlocks(
  lines: readonly OcrTextLine[],
  options: { pageWidth?: number; pageHeight?: number } = {},
): OcrLayoutBlock[] {
  const bodySize = bodyFontSize(lines);
  return groupBlocks(lines, options.pageWidth ?? 0, bodySize).map((group, index) => {
    const first = group.lines[0];
    if (!first) throw new Error('an OCR block has no lines');
    const vertical = group.lines.every(verticalLine);
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const line of group.lines) {
      left = Math.min(left, line.box.x);
      top = Math.min(top, line.box.y);
      right = Math.max(right, line.box.x + line.box.width);
      bottom = Math.max(bottom, line.box.y + line.box.height);
    }
    const box: Box = {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
    const baselines = group.lines.map((line) => line.baseline).sort((a, b) => a - b);
    const leading = baselines.length > 1 ? (baselines[1] ?? 0) - (baselines[0] ?? 0) : 0;
    const fontSize = median(group.lines.map((line) => line.height));
    return {
      id: first.id + ':block' + (index === 0 ? '' : '-' + String(index)),
      box,
      room: { ...box },
      lines: group.lines,
      text: groupText(group.lines),
      role: group.role,
      fontSize,
      lineHeight:
        leading > 0 ? Math.min(2.2, Math.max(1.05, leading / Math.max(1, fontSize))) : 1.35,
      align: 'left',
      bold: group.lines.every(
        (line) => line.pieces.length > 0 && line.pieces.every((piece) => piece.bold),
      ),
      italic: group.lines.every(
        (line) => line.pieces.length > 0 && line.pieces.every((piece) => piece.italic),
      ),
      // Keep -1 for spanning lines. Folding them into column 0 would let a full-width
      // title widen the left column's room across the gutter and clip its translation.
      column: group.column,
      advance: vertical ? box.height : box.width,
      writing: vertical ? 90 : 0,
    };
  });
}

export function ocrResultToLayoutBlocks(
  result: OcrResult,
  options: OcrConversionOptions,
): OcrLayoutBlock[] {
  return ocrLinesToLayoutBlocks(ocrResultToTextLines(result, options), options);
}

function layoutFromLines(
  lines: readonly OcrTextLine[],
  options: OcrConversionOptions,
): OcrPageLayout {
  const blocks = ocrLinesToLayoutBlocks(lines, options);
  const bodySize = bodyFontSize(lines);
  // Code, numeric labels and small text attached to a figure caption are not prose. Keeping
  // them in the skipped list leaves the scan's own drawing visible at those spots.
  const skipped = blocks.filter(
    (block) => block.role === 'code' || block.role === 'label' || block.role === 'furniture',
  );
  const tableCells = detectTableRows(
    blocks.filter((block) => !skipped.includes(block)),
    bodySize,
  );
  const captions = blocks.filter((block) => block.role === 'caption');
  const figureLabels = blocks.filter(
    (block) =>
      !skipped.includes(block) &&
      !tableCells.includes(block) &&
      // A caption OCRed in small type is still a caption, not a label inside its own figure.
      block.role !== 'caption' &&
      bodySize > 0 &&
      block.fontSize < bodySize * 0.75 &&
      captions.some(
        (caption) =>
          Math.abs(block.box.y - caption.box.y) < 160 &&
          block.box.x < caption.box.x + caption.box.width + 80 &&
          block.box.x + block.box.width > caption.box.x - 80,
      ),
  );
  const withheld = [...new Set([...skipped, ...tableCells, ...figureLabels])];
  const kept = blocks.filter((block) => !withheld.includes(block));
  // Spanning blocks are their own shape, not members of a body column: including a full-width
  // title in column 0 made every left paragraph's room reach across the gutter while the
  // painted cover was still capped there, so the translation was clipped without a marker.
  const body = kept.filter((block) => block.column >= 0);
  const columns = [...new Set(body.map((block) => block.column))].sort((a, b) => a - b);
  // A cover may wrap through its column's white space, but never across the gutter into the
  // neighbouring column. Native blocks get this from the XY-cut; OCR needs it explicitly.
  const ranges = new Map(
    columns.map((index) => {
      const members = body.filter((block) => block.column === index);
      return [
        index,
        {
          minX: Math.min(...members.map((block) => block.box.x)),
          maxX: Math.max(...members.map((block) => block.box.x + block.box.width)),
        },
      ];
    }),
  );
  if (options.pageWidth > 0) {
    for (const block of kept) {
      if (block.column < 0) {
        // A spanning block wraps to its own source measure, so fit and paint agree.
        block.room = { ...block.box };
        continue;
      }
      const range = ranges.get(block.column);
      const left = range?.minX ?? block.box.x;
      const right = range?.maxX ?? options.pageWidth;
      block.room = {
        x: left,
        y: block.box.y,
        width: Math.max(block.box.width, right - left - 4),
        height: block.box.height,
      };
    }
  }
  return {
    blocks: kept,
    bodySize,
    lineHeight: lines.length > 0 ? median(lines.map((line) => line.height)) : 0,
    skipped: withheld,
    pageHeight: options.pageHeight,
    pageWidth: options.pageWidth,
    pageIndex: options.pageIndex,
    // Caption-adjacent small type sits inside the figure; give it to the fitter as a wall so a
    // neighbouring paragraph cannot wrap across the drawing.
    obstacles: [...figureLabels, ...tableCells].map((block) => ({ ...block.box })),
  };
}

/** Ready for PdfSession.addPage; use the separately returned lines for the selectable layer. */
export function ocrResultToPageLayout(
  result: OcrResult,
  options: OcrConversionOptions,
): OcrPageLayout {
  return layoutFromLines(ocrResultToTextLines(result, options), options);
}

function intersectionArea(left: Box, right: Box): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  return width * height;
}

/**
 * Removes OCR duplicates of the native text layer while retaining scanned text elsewhere.
 * Coverage is geometric because the recognizer and PDF text extractor may segment or spell the
 * same line differently. Both ratios matter: a tiny native stamp inside a large scanned paragraph
 * must not suppress that paragraph.
 */
export function uncoveredPdfOcrResult(
  result: OcrResult,
  nativeLines: readonly TextLine[],
  options: OcrConversionOptions,
): OcrResult {
  const resolved = conversion(options);
  const nativeBoxes = nativeLines
    .filter((line) => line.text.trim().length > 0)
    .map((line) => line.box);
  const regions = result.regions.filter((region) => {
    if (region.text.trim().length === 0) return false;
    const box = quadBox(scaleQuad(region.quad, resolved.scaleX, resolved.scaleY));
    const area = Math.max(1, box.width * box.height);
    return !nativeBoxes.some((nativeBox) => {
      const nativeArea = Math.max(1, nativeBox.width * nativeBox.height);
      const overlap = intersectionArea(box, nativeBox);
      return overlap >= Math.min(area, nativeArea) * 0.5 && overlap >= area * 0.2;
    });
  });
  // Chrome serializes OcrResult as JSON across runtime messages, so lines[].items are not
  // the same object instances as regions[]. Match by value to keep reading lines after transport.
  const regionKey = (region: OcrRegion): string =>
    JSON.stringify([region.text, region.vertical, region.quad]);
  const retained = new Set(regions.map(regionKey));
  const lines = result.lines
    .map((line) => {
      const items: OcrRegion[] = [];
      const indices: number[] = [];
      line.items.forEach((region, index) => {
        if (!retained.has(regionKey(region))) return;
        items.push(region);
        const sourceIndex = line.indices[index];
        if (sourceIndex !== undefined) indices.push(sourceIndex);
      });
      return { ...line, items, indices };
    })
    .filter((line) => line.items.length > 0);
  return {
    regions,
    lines: result.lines.length > 0 ? lines : [],
    text:
      result.lines.length > 0
        ? lines
            .map((line) =>
              line.items
                .map((region) => region.text)
                .join(line.orientation === 'vertical' ? '' : ' '),
            )
            .join('\n')
        : regions.map((region) => region.text).join('\n'),
  };
}

/** Native layout plus only the OCR lines not already represented by native text. */
export function ocrResultToHybridPage(
  result: OcrResult,
  extracted: ExtractedPage,
  options: OcrConversionOptions,
): { lines: OcrTextLine[]; layout: PageLayout } {
  // A page-sized scan is the background, not a figure whose native header should be skipped.
  const native = layoutPage(
    extracted.lines,
    { images: [] },
    {
      width: extracted.width,
      height: extracted.height,
      index: options.pageIndex,
    },
  );
  const lines = ocrResultToTextLines(
    uncoveredPdfOcrResult(result, extracted.lines, options),
    options,
  );
  if (lines.length === 0) return { lines, layout: native };
  const scanned = layoutFromLines(lines, options);
  return {
    lines,
    layout: {
      ...native,
      blocks: [...native.blocks, ...scanned.blocks],
      bodySize: native.bodySize || scanned.bodySize,
      lineHeight: native.lineHeight || scanned.lineHeight,
      // A mixed page needs both sets: native geometry is not a substitute for scanned
      // code/figure areas, and dropping scanned.skipped undercounted them in the report.
      skipped: [...native.skipped, ...scanned.skipped],
      obstacles: [...native.obstacles, ...scanned.obstacles],
    },
  };
}

/** The minimal canvas surface needed by the adapter; HTMLCanvasElement also satisfies it. */
export interface PdfOcrCanvas {
  readonly width: number;
  readonly height: number;
  getContext(contextId: '2d'): {
    getImageData(x: number, y: number, width: number, height: number): ImageDataLike;
  } | null;
}

export type PdfOcrImage = ImageDataLike | PdfOcrCanvas;
export type PdfOcrRecognize = (image: ImageDataLike, signal: AbortSignal) => Promise<OcrResult>;

/** An OCR failure whose text is safe and useful to show on the scanned page. */
export class OcrUserMessageError extends Error {}

export interface PdfPageOcrOptions {
  readonly pageIndex: number;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly recognize: PdfOcrRecognize;
  /** Hard bound for one page; the default keeps a wedged engine from hanging the reader. */
  readonly timeoutMs?: number;
  readonly timeoutMessage?: string;
}

export interface PdfPageOcrResult {
  readonly ocr: OcrResult;
  readonly lines: OcrTextLine[];
  readonly layout: OcrPageLayout;
  readonly empty: boolean;
}

function abortError(): Error {
  const error = new Error('PDF OCR operation was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function imageDataOf(image: PdfOcrImage): ImageDataLike {
  if ('data' in image) return image;
  const context = image.getContext('2d');
  if (!context) throw new Error('PDF OCR canvas has no 2D context');
  return context.getImageData(0, 0, image.width, image.height);
}

/** Rejects on abort immediately, while consuming a late inference result or rejection. */
function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const succeed = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(succeed, fail);
    if (signal.aborted) onAbort();
  });
}

/**
 * Lazy, latest-single-run OCR owner for one PDF page.
 *
 * Construction does not read pixels or invoke recognition. `run` deduplicates concurrent calls
 * and caches success. `cancel` aborts active inference and clears it so a later run can retry;
 * cancelling an already successful or failed run is a no-op. Browser transport and ORT remain
 * entirely behind the injected recognize function.
 */
export class PdfPageOcr {
  private readonly options: PdfPageOcrOptions;
  private task: Promise<PdfPageOcrResult> | null = null;
  private controller: AbortController | null = null;

  constructor(options: PdfPageOcrOptions) {
    this.options = options;
  }

  run(image: PdfOcrImage): Promise<PdfPageOcrResult> {
    if (this.task) return this.task;
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs ?? OCR_PAGE_TIMEOUT_MS);
    const operation = Promise.resolve().then(async () => {
      try {
        throwIfAborted(controller.signal);
        const pixels = imageDataOf(image);
        throwIfAborted(controller.signal);
        const inference = Promise.resolve().then(() =>
          this.options.recognize(pixels, controller.signal),
        );
        const ocr = await abortable(inference, controller.signal);
        throwIfAborted(controller.signal);
        const conversionOptions: OcrConversionOptions = {
          pageIndex: this.options.pageIndex,
          pageWidth: this.options.pageWidth,
          pageHeight: this.options.pageHeight,
          imageWidth: pixels.width,
          imageHeight: pixels.height,
        };
        const lines = ocrResultToTextLines(ocr, conversionOptions);
        throwIfAborted(controller.signal);
        return {
          ocr,
          lines,
          layout: layoutFromLines(lines, conversionOptions),
          empty: lines.length === 0,
        };
      } catch (error) {
        if (timedOut) {
          throw new OcrUserMessageError(this.options.timeoutMessage ?? 'OCR timed out.');
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
    const tracked: Promise<PdfPageOcrResult> = operation.then(
      (value) => {
        if (this.task === tracked) this.controller = null;
        return value;
      },
      (error: unknown) => {
        if (this.task === tracked) {
          this.task = null;
          this.controller = null;
        }
        if (controller.signal.aborted && !timedOut) throw abortError();
        throw error;
      },
    );
    this.task = tracked;
    return tracked;
  }

  cancel(): void {
    const controller = this.controller;
    if (!controller) return;
    this.controller = null;
    this.task = null;
    controller.abort();
  }
}

export function createPdfPageOcr(options: PdfPageOcrOptions): PdfPageOcr {
  return new PdfPageOcr(options);
}
