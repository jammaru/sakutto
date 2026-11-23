import { ocrPageTimeoutMs } from '@/engine/offscreen/protocol';
import type { OcrTier } from '@/engine/ocr/catalog';
import { groupReadingLines } from '@/engine/ocr/order';
import type { ImageDataLike, OcrQuad, OcrRegion, OcrResult, ReadingLine } from '@/engine/ocr/types';
import { isImageOnlyPage, normalizeGlyphRun, type ExtractedPage } from './extract';
import { CJK_MAJORITY, cjkRatio } from './fonts';
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
  /** Column of a line emitted by a gutter split; geometry decides when it is absent. */
  readonly columnHint?: number | undefined;
  /** True when the row was kept whole as one spanning title, not split into body columns. */
  readonly titleRow?: boolean | undefined;
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

/** White gap that separates two printed columns. Dense scans map a 12px gutter to ~6pt. */
const MIN_COLUMN_GUTTER = 6;
/** A same-baseline row split by this much white is two body columns, not one wide line. */
const WIDE_COLUMN_GUTTER = 10;

/**
 * A two-column page need not be centred on the page midpoint: a left measure can end past it.
 * Compare the gutter's own centre with the midpoint, allowing a 10% layout asymmetry, instead
 * of requiring each fragment to straddle the exact midpoint.
 */
function gutterCentred(leftEnd: number, rightStart: number, pageWidth: number): boolean {
  if (!Number.isFinite(leftEnd) || !Number.isFinite(rightStart) || pageWidth <= 0) return false;
  return Math.abs((leftEnd + rightStart) / 2 - pageWidth / 2) <= pageWidth * 0.1;
}

interface PieceSplit {
  readonly left: OcrTextPiece[];
  readonly right: OcrTextPiece[];
  readonly leftEnd: number;
  readonly rightStart: number;
}

/**
 * Whether a candidate gutter is just one of several equal word spaces on a single row.
 *
 * A word-level detector emits a quad per word, so an ordinary one-column line can have several
 * 6-12pt gaps near the page midpoint. If the chosen gap is no wider than the other gaps on the
 * row, it is ordinary justification/OCR spacing, not a printed gutter. A real gutter stands out
 * from the word spaces (or is the row's only gap, in which case there is nothing to compare).
 */
function wordSpaceGutter(pieces: readonly OcrTextPiece[], gutterGap: number): boolean {
  if (pieces.length < 3) return false;
  const byX = [...pieces].sort((a, b) => a.box.x - b.box.x);
  const gaps: number[] = [];
  for (let index = 1; index < byX.length; index += 1) {
    const previous = byX[index - 1]!;
    const current = byX[index]!;
    gaps.push(current.box.x - (previous.box.x + previous.box.width));
  }
  if (gaps.length < 2 || gaps.some((gap) => gap < 0 || gap > WIDE_COLUMN_GUTTER + 2)) {
    return false;
  }
  const chosen = gaps.findIndex((gap) => Math.abs(gap - gutterGap) < 0.01);
  if (chosen < 0) return false;
  const others = gaps.filter((_, index) => index !== chosen);
  return gutterGap <= Math.max(...others) + 2;
}

/**
 * A long title emitted as two line-region boxes is still one printed row. The short centred
 * heading guard below cannot see it: the title is wider than 0.6 x page width and has more
 * than twelve words. Its middle whitespace is ordinary spacing, not a printed gutter, so it
 * must not become page-wide evidence for two body columns either.
 */
function rowHasInteriorSentenceBreak(text: string): boolean {
  const prose = text.replace(/\d\.\d/gu, '').replace(/\b(?:Dr|Mr|Ms|Prof|e\.g|i\.e)\./gu, '');
  const withoutDottedTokens = prose.replace(/\b(?:\w\.)+\w*\.?/gu, (token) =>
    token.replace(/\./g, ''),
  );
  return (
    /[.!?。！？]\s+(?:\p{Lu}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/u.test(
      withoutDottedTokens,
    ) || (withoutDottedTokens.match(/[.!?。！？]/gu) ?? []).length > 1
  );
}

/**
 * Sentence-case verbs after a scientific prefix belong to a body sentence, not a title:
 * "mRNA vaccines reduce", "CRISPR editing enables". Deliberately excludes copulas so a
 * genuine sentence-case title such as "mRNA vaccines are effective" still merges.
 */
const SCIENTIFIC_BODY_VERB =
  /\b(?:reduc(?:e|es|ed|ing)|enabl(?:e|es|ed|ing)|edit(?:s|ed|ing)?|induc(?:e|es|ed|ing)|inhibit(?:s|ed|ing)?|increas(?:e|es|ed|ing)|affect(?:s|ed|ing)?|improv(?:e|es|ed|ing)|regulat(?:e|es|ed|ing)|mediat(?:e|es|ed|ing)|promot(?:e|es|ed|ing)|target(?:s|ed|ing)?|encod(?:e|es|ed|ing)|express(?:es|ed|ing)?|detect(?:s|ed|ing)?|measur(?:e|es|ed|ing)|observ(?:e|es|ed|ing)|suggest(?:s|ed|ing)?|demonstrat(?:e|es|ed|ing)|confirm(?:s|ed|ing)?|analyz(?:e|es|ed|ing)|evaluat(?:e|es|ed|ing)|determin(?:e|es|ed|ing)|identif(?:y|ies|ied|ying)|generat(?:e|es|ed|ing)|bind(?:s|ing)?|bound|provid(?:e|es|ed|ing)|show(?:s|ed|ing)?|reveal(?:s|ed|ing)?)\b/u;
const TITLE_TAIL_FUNCTION_WORD =
  /^(?:in|of|for|to|and|the|a|an|on|with|from|by|at|as|via|or|but|into|using|without|during|between|among|across|after|before|over|under|near|beyond|within|throughout|despite|versus|vs|per|about|above|below|around|against|since|until|than|toward|towards|except|including|given)$/u;

/**
 * A short title-case fragment such as "In Older Adults without Vaccination". Lowercase
 * prepositions are ordinary in title case, so they are allowed; a lowercase content word means
 * this is the sentence continuing after the prefix, not the tail of a title.
 */
function titleCaseTail(words: readonly string[]): boolean {
  if (words.length === 0 || words.length > 4) return false;
  if (!/^\p{Lu}/u.test(words[0] ?? '')) return false;
  return !words
    .slice(1)
    .some(
      (word) => /^[a-z]{3,}$/u.test(word) && !TITLE_TAIL_FUNCTION_WORD.test(word.toLowerCase()),
    );
}

/** OCR titles that start with a short scientific token (mRNA, eDNA, …), not body prose. */
const SCIENTIFIC_TITLE_PREFIX = /^(?:mRNA|iOS|eBay|DNA|RNA|eDNA|CRISPR|Node\.js|U\.S\.)\b/iu;

function scientificShortTitleFirstPiece(
  first: string,
  second: string,
  relaxedWordCaps = false,
  pageTitleEvidence = false,
): boolean {
  if (!SCIENTIFIC_TITLE_PREFIX.test(first)) {
    return false;
  }
  // The page proves the row sits above every two-column body row, so its halves are title text
  // even when they contain body-like words or verbs. No text-only guard may overrule that.
  if (pageTitleEvidence) return true;
  if (/:/u.test(first)) return false;
  const tail = second.split(/\s+/u).filter(Boolean);
  const firstWords = first.split(/\s+/u).filter(Boolean).length;
  // A scientific prefix plus a copula can run past four words in a real title. Allow that only
  // when the other half looks like a title fragment rather than lowercase body prose. Once the
  // page proves the row sits above every two-column body row, the halves are a title regardless
  // of these conservative word caps: a 9-word first half or a 7-word tail is still one title.
  if (!relaxedWordCaps && (firstWords > 8 || (firstWords > 4 && !titleCaseTail(tail)))) {
    return false;
  }
  if (/\b(?:expression|levels|samples|sequencing|reveal|collected)\b/iu.test(first)) {
    return false;
  }
  if (/^The\s+(?:model|results|extension|paper)\b/iu.test(second)) return false;
  const afterPrefix = first.replace(
    /^(?:mRNA|iOS|eBay|DNA|RNA|eDNA|CRISPR|Node\.js|U\.S\.)\s+/iu,
    '',
  );
  if (!/\b[a-z]{2,}/u.test(afterPrefix)) return true;
  if (SCIENTIFIC_BODY_VERB.test(afterPrefix)) return false;
  if (tail.length === 0 || (!relaxedWordCaps && tail.length > 6)) return false;
  // A short second fragment alone is not a title: "Severe disease in older adults" is the
  // sentence continuing after the prefix, while "In Older Adults" is a real title tail.
  return !tail
    .slice(1)
    .some(
      (word) => /^[a-z]{3,}$/u.test(word) && !TITLE_TAIL_FUNCTION_WORD.test(word.toLowerCase()),
    );
}

/** Colon rows that are inline notation (\": x\") belong in body columns, not merged titles. */
function colonNotationBodyRow(wholeText: string, firstPiece: string): boolean {
  if (/\bnotation\s*:/iu.test(wholeText)) return true;
  if (/:\s*[a-z]\b/u.test(wholeText) || /:\s*\d/u.test(wholeText)) return true;
  return /:\s*[A-Z]\s*$/u.test(firstPiece.trim());
}

function onePrintedTitleRow(
  pieces: readonly OcrTextPiece[],
  pageWidth: number,
  relaxedTitleCaps = false,
  pageTitleEvidence = false,
  cjkTwoColumnBody = false,
): boolean {
  if (pieces.length !== 2 || !pieces.some((piece) => piece.box.width >= pageWidth * 0.12)) {
    return false;
  }
  // Japanese/CJK body lines have no casing or word spaces to separate them from a title. When
  // the page's other rows establish two columns and this row shares their gutter, geometry —
  // not the text shape — decides that it is body text.
  if (cjkTwoColumnBody) return false;
  if (pageTitleEvidence) {
    // Page evidence overrules the body-word and body-verb guards: a scientific title such as
    // "mRNA expression levels in older adults" is still a title. The lowercase right half is
    // kept as the one shape that distinguishes a fused body row from a title's second fragment.
    const ordered = [...pieces].sort((a, b) => a.box.x - b.box.x);
    const first = ordered[0]?.text.trim() ?? '';
    const second = ordered[1]?.text.trim() ?? '';
    const secondWords = second.split(/\s+/u).filter(Boolean);
    const tail = secondWords[0] ?? '';
    if (
      !/^(\p{Lu}|\d|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/u.test(tail) ||
      secondWords
        .slice(1)
        .some(
          (word) => /^[a-z]{3,}$/u.test(word) && !TITLE_TAIL_FUNCTION_WORD.test(word.toLowerCase()),
        )
    ) {
      return false;
    }
    return (
      /^(\p{Lu}|\d|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/u.test(first) ||
      SCIENTIFIC_TITLE_PREFIX.test(first)
    );
  }
  const text = pieces
    .map((piece) => piece.text)
    .join(' ')
    .trim();
  const words = text.split(/\s+/u).filter(Boolean);
  const cjk = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
  if (!cjk && words.length < 3) return false;
  if (cjk && text.length < 8) return false;
  if (rowHasInteriorSentenceBreak(text)) return false;
  const ordered = [...pieces].sort((a, b) => a.box.x - b.box.x);
  const first = ordered[0]?.text.trim() ?? '';
  const second = ordered[1]?.text.trim() ?? '';
  const startsTitle =
    /^(\p{Lu}|\d|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/u.test(text) ||
    scientificShortTitleFirstPiece(first, second, relaxedTitleCaps);
  if (!startsTitle) return false;
  // Body columns often start the right piece with a lowercase word; titles rarely do.
  if (second.length > 0 && /^[a-z]/.test(second)) return false;
  return true;
}

/** CJK prose has no casing: a two-piece body row starts with the same glyphs as a title. */
function cjkTextRow(pieces: readonly OcrTextPiece[]): boolean {
  const text = pieces
    .map((piece) => piece.text)
    .join('')
    .trim();
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

/**
 * A CJK row is body text when the page's other rows establish two columns and its own gutter
 * and measures match them. Without the page evidence a single CJK row stays a title: its text
 * shape alone cannot say either way.
 */
function cjkTwoColumnBodyRow(
  pieces: readonly OcrTextPiece[],
  resolved: ResolvedConversion,
  pageTwoColumn: boolean,
): boolean {
  if (!pageTwoColumn || !cjkTextRow(pieces)) return false;
  const { left, right, leftEnd, rightStart } = splitAtGutter(pieces, resolved.pageWidth);
  if (left.length === 0 || right.length === 0 || rightStart - leftEnd < MIN_COLUMN_GUTTER) {
    return false;
  }
  const measure = (group: readonly OcrTextPiece[]): number =>
    Math.max(...group.map((piece) => piece.box.x + piece.box.width)) -
    Math.min(...group.map((piece) => piece.box.x));
  return (
    measure(left) >= resolved.pageWidth * 0.15 &&
    measure(right) >= resolved.pageWidth * 0.15 &&
    gutterCentred(leftEnd, rightStart, resolved.pageWidth)
  );
}

/** A row whose two line-region pieces are one sentence split at an ordinary word space. */
function singleSentenceRow(pieces: readonly OcrTextPiece[], pageWidth: number): boolean {
  if (pieces.length !== 2 || !pieces.some((piece) => piece.box.width >= pageWidth * 0.12)) {
    return false;
  }
  const text = pieces
    .map((piece) => piece.text)
    .join(' ')
    .trim();
  if (text.split(/\s+/u).filter(Boolean).length < 5) return false;
  // Decimal points and abbreviations are not sentence boundaries.
  const prose = text.replace(/\d\.\d/gu, '').replace(/\b(?:Dr|Mr|Ms|Prof|e\.g|i\.e)\./gu, '');
  const stops = prose.match(/[.!?。]/gu);
  return stops?.length === 1 && /[.!?。]$/u.test(prose);
}

/** A two-piece line region with a colon is usually a title even when OCR casing is wrong. */
function twoPieceColonTitle(
  pieces: readonly OcrTextPiece[],
  pageWidth: number,
  wholeText: string,
): boolean {
  if (pieces.length !== 2 || !pieces.some((piece) => piece.box.width >= pageWidth * 0.12)) {
    return false;
  }
  if (!/:/u.test(wholeText)) return false;
  if (singleSentenceRow(pieces, pageWidth)) return false;
  return !rowHasInteriorSentenceBreak(wholeText);
}

/** A row whose own span has roughly equal page margins is genuinely centred. */
function rowCentredOnPage(pieces: readonly OcrTextPiece[], pageWidth: number): boolean {
  if (pageWidth <= 0 || pieces.length === 0) return false;
  const left = Math.min(...pieces.map((piece) => piece.box.x));
  const right = Math.max(...pieces.map((piece) => piece.box.x + piece.box.width));
  const leftMargin = left;
  const rightMargin = pageWidth - right;
  if (leftMargin < 0 || rightMargin < 0) return false;
  // A span's midpoint alone is not centring: a left-aligned fused body row ending in a short
  // right fragment can have its midpoint near the page midpoint while its own margins differ
  // wildly (72pt versus 182pt on US Letter). Compare the margins the row actually leaves.
  // 10% asymmetry allowance: real layouts are not perfectly centred.
  return Math.abs(leftMargin - rightMargin) <= pageWidth * 0.1;
}

/**
 * A short row centred on the page is a title, byline or subtitle, not two body columns.
 * Body columns fill most of the measure even on a partially filled row; counting a centred
 * heading as gutter evidence makes later single-column lines split at ordinary word spaces.
 *
 * Width alone is not centring. A left-aligned fused two-column row ending in a short right
 * fragment is also narrower than 60% of the page; treating it as a heading swallows the
 * fragment into the left column and paints a cover across the gutter. Require balanced page
 * margins before a short capitalised body row can count as title evidence.
 *
 * `onePrintedTitleRow` must not bypass that requirement: capitalisation, a short fragment and a
 * missing terminal period are all normal at a two-column line break. Only a row above every body
 * row has page-level title evidence; its whitespace is title whitespace even when it is not
 * centred. Callers that need that exception pass `pageTitleEvidence`.
 */
function isCentredHeadingRow(
  pieces: readonly OcrTextPiece[],
  pageWidth: number,
  pageTitleEvidence = false,
): boolean {
  if (pageTitleEvidence && onePrintedTitleRow(pieces, pageWidth, true, true)) return true;
  const text = pieces
    .map((piece) => piece.text)
    .join(' ')
    .trim();
  if (text.length === 0 || text.length > 100 || /[.!?。]$/u.test(text)) return false;
  const words = text.split(/\s+/u).filter(Boolean);
  if (words.length === 0 || words.length > 12) return false;
  const left = Math.min(...pieces.map((piece) => piece.box.x));
  const right = Math.max(...pieces.map((piece) => piece.box.x + piece.box.width));
  return right - left < pageWidth * 0.6 && rowCentredOnPage(pieces, pageWidth);
}

/**
 * Partition a merged line at the widest white gap in the gutter band, not at the page midpoint.
 *
 * A two-column page can be asymmetric: the left measure may end past the midpoint, so a
 * word-level piece on the left can have its centre past it too. Splitting by piece centre then
 * moves that tail into the right block. Looking at the actual gaps between neighbouring boxes
 * finds the printed gutter. Several gaps can pass the loose centred-band test (a word space in
 * either column qualifies as well), so score each gap by the two column measures it produces:
 * the printed gutter leaves a usable measure on both sides, while a word gap merely trims one
 * column and grows the other. Gap width breaks ties, then centre distance. Otherwise a word
 * space nearer the page midpoint can steal a right-column word into the left translation.
 */
function splitAtGutter(pieces: readonly OcrTextPiece[], pageWidth: number): PieceSplit {
  const middle = pageWidth / 2;
  const byX = [...pieces].sort((a, b) => a.box.x - b.box.x);
  const candidates: {
    index: number;
    leftEnd: number;
    rightStart: number;
    width: number;
    measure: number;
    score: number;
  }[] = [];
  for (let index = 1; index < byX.length; index += 1) {
    const leftEnd = Math.max(...byX.slice(0, index).map((piece) => piece.box.x + piece.box.width));
    const rightStart = Math.min(...byX.slice(index).map((piece) => piece.box.x));
    const width = rightStart - leftEnd;
    if (width < MIN_COLUMN_GUTTER) continue;
    if (!gutterCentred(leftEnd, rightStart, pageWidth)) continue;
    // Normally the printed gutter leaves a usable measure on both sides, while a word gap
    // merely trims one column and grows the other. A gap that is dramatically wider than
    // every other candidate is the physical gutter, though: a short heading beside a
    // word-level body can make the measure heuristic prefer a 6pt space inside that body.
    const leftMeasure = leftEnd - Math.min(...byX.slice(0, index).map((piece) => piece.box.x));
    const rightMeasure =
      Math.max(...byX.slice(index).map((piece) => piece.box.x + piece.box.width)) - rightStart;
    candidates.push({
      index,
      leftEnd,
      rightStart,
      width,
      measure: Math.min(leftMeasure, rightMeasure),
      score: Math.abs((leftEnd + rightStart) / 2 - middle),
    });
  }
  const widths = candidates.map((candidate) => candidate.width).sort((a, b) => b - a);
  const dominantGap =
    widths[0] !== undefined &&
    widths[0] >= Math.max(20, WIDE_COLUMN_GUTTER * 2) &&
    (widths[1] === undefined || widths[0] >= widths[1] * 2);
  const best = candidates.sort((a, b) =>
    dominantGap
      ? b.width - a.width || a.score - b.score
      : b.measure - a.measure || b.width - a.width || a.score - b.score,
  )[0];
  if (!best) {
    const left = pieces.filter((piece) => piece.box.x + piece.box.width / 2 < middle);
    const right = pieces.filter((piece) => piece.box.x + piece.box.width / 2 >= middle);
    return {
      left,
      right,
      leftEnd:
        left.length > 0
          ? Math.max(...left.map((piece) => piece.box.x + piece.box.width))
          : -Infinity,
      rightStart: right.length > 0 ? Math.min(...right.map((piece) => piece.box.x)) : Infinity,
    };
  }
  const left = pieces.filter((piece) => piece.box.x + piece.box.width <= best.leftEnd + 0.001);
  const right = pieces.filter((piece) => piece.box.x + piece.box.width > best.leftEnd + 0.001);
  return { left, right, leftEnd: best.leftEnd, rightStart: best.rightStart };
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
  // Two source rows must actually be separate: overlapping boxes differing by ~1.5pt in y
  // are one wavy printed row, even when a word-level detector reports a gutter-sized x gap.
  const upperBottom = Math.max(...upper.map((piece) => piece.box.y + piece.box.height));
  const lowerTop = Math.min(...lower.map((piece) => piece.box.y));
  if (upperBottom - lowerTop > height * 0.25) return null;
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
  // A 2pt top-edge step on one wavy full-width line is OCR noise, not evidence of two rows.
  // Two column rows must also be separated by a real white gutter and sit on opposite sides
  // of the page midpoint. Without the gutter test, adjacent word boxes on a sloped line
  // looked like a left and a right column and got split into two translation blocks.
  const gutter = Math.max(first.left, second.left) - Math.min(first.right, second.right);
  if (gutter < MIN_COLUMN_GUTTER || wordSpaceGutter(pieces, gutter)) return null;
  const middle = pageWidth / 2;
  const straddlesMiddle = first.right <= middle + 4 && second.left >= middle - 4;
  if (
    !straddlesMiddle &&
    !gutterCentred(
      Math.min(first.right, second.right),
      Math.max(first.left, second.left),
      pageWidth,
    )
  ) {
    return null;
  }
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
  // A dense scan can put a real column gutter only 6pt from a word space. Decide from the rest
  // of the page whether two body columns exist before judging a single row's centre gap.
  const twoColumnRows = twoColumnBodyRows(lines, resolved);
  const pageTwoColumn = twoColumnRows.length >= 2;
  const twoColumnTops = twoColumnRows.map((index) =>
    Math.min(
      ...(lines[index]?.items ?? [])
        .filter((item) => item.text.trim().length > 0)
        .map(
          (item) => regionPiece(item, item.vertical, '', resolved.scaleX, resolved.scaleY).box.y,
        ),
    ),
  );
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
    const {
      left: leftPieces,
      right: rightPieces,
      leftEnd,
      rightStart,
    } = splitAtGutter(pieces, resolved.pageWidth);
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
    const wholeText = pieces
      .map((piece) => piece.text)
      .join(' ')
      .trim();
    const headingWholeLine = wholeText.length <= 120 && !/[.!?。]$/u.test(wholeText);
    // A two-piece title printed above every corroborated two-column body row keeps its middle
    // whitespace: the page's gutter evidence belongs to the body below it, not to the title.
    const rowTop = Math.min(...pieces.map((piece) => piece.box.y));
    const rowsBelow = twoColumnTops.filter((top) => top > rowTop);
    const rowsAbove = twoColumnTops.filter((top) => top < rowTop);
    // A CJK row sharing the page's corroborated gutter is body text, not a spanning title: its
    // glyphs cannot carry the casing evidence an English title check relies on.
    const cjkBodyGeometry = cjkTwoColumnBodyRow(pieces, resolved, pageTwoColumn);
    // A real section heading can be printed between two-column body rows instead of above all
    // of them. Balanced page margins, a moderate (title-sized) span and a title-shaped tail
    // distinguish it from a near-full-measure colon body row, which has body text above and
    // below too, but must be split at the gutter. The width ceiling is deliberately well below
    // the 75-90% measure of ordinary two-column body rows.
    const centredHeadingBetweenBody =
      !cjkBodyGeometry &&
      rowsAbove.length >= 2 &&
      rowsBelow.length >= 2 &&
      lineWidth >= resolved.pageWidth * 0.6 &&
      lineWidth < resolved.pageWidth * 0.72 &&
      rowCentredOnPage(pieces, resolved.pageWidth) &&
      onePrintedTitleRow(pieces, resolved.pageWidth, true, true);
    // A title whose words trip a body-word guard can be counted as two-column evidence itself,
    // so it never appears to sit above the body. When this row is the topmost such row and at
    // least two corroborated rows sit below it, the page still proves it is a title: the only
    // shape that survives the relaxed check is a title, not a lowercase right-column fragment.
    // A CJK body row also sits above its peers sometimes; its shared gutter rules that out.
    const titleAboveBody =
      !cjkBodyGeometry &&
      (centredHeadingBetweenBody ||
        (twoColumnTops.length > 0 &&
          (twoColumnTops.every((top) => top > rowTop) ||
            (rowsBelow.length >= 2 &&
              rowsBelow.length === twoColumnTops.length - 1 &&
              onePrintedTitleRow(pieces, resolved.pageWidth, true, true)))));
    const orderedPieces = [...pieces].sort((a, b) => a.box.x - b.box.x);
    const firstPieceText = orderedPieces[0]?.text.trim() ?? '';
    // Every title-merge path needs the same page-level or centre/margin evidence as
    // `centredTitleRow`. On a two-column page a capitalised right fragment beside a column
    // gutter is body text, whether its row carries a colon or a scientific prefix or not.
    // Balanced page margins alone are not enough: an ordinary 75-90%-wide two-column body row
    // leaves nearly equal margins and would otherwise become a page-spanning colon title.
    // Genuinely centred headings wider than 60% are covered by `centredHeadingBetweenBody`.
    const titleCentreEvidence =
      !pageTwoColumn ||
      titleAboveBody ||
      (rowCentredOnPage(pieces, resolved.pageWidth) && lineWidth < resolved.pageWidth * 0.6);
    const scientificTitleRow =
      titleCentreEvidence &&
      scientificShortTitleFirstPiece(
        firstPieceText,
        orderedPieces[1]?.text.trim() ?? '',
        titleAboveBody,
        titleAboveBody,
      );
    // A scientific prefix that fails the title check is body prose even when OCR capitalised the
    // row; the generic full-width-title heuristic must not rescue it. A row above every body
    // column is different: its gap is title whitespace, so titleAboveBody/wideGapTitleRow stay
    // available even when the text heuristic was too conservative.
    const scientificBodyRow =
      SCIENTIFIC_TITLE_PREFIX.test(firstPieceText) && !scientificTitleRow && !titleAboveBody;
    // A full-width title starts with a capital and has no sentence-ending punctuation. Its
    // word gap at the gutter is ordinary spacing, not two columns, even when it is wide.
    const titleWholeLine =
      headingWholeLine &&
      wholeText.length <= 100 &&
      wholeText.split(/\s+/u).length <= 12 &&
      !/[.,;:!?。]/u.test(wholeText) &&
      /^\p{Lu}/u.test(wholeText) &&
      !scientificBodyRow;
    // A long title or a wrapped body line can fail every title heuristic (a colon, more than
    // twelve words) yet still be one printed line. Word-sized boxes separated only by ordinary
    // word spaces are not two columns: a real gutter is wider than a word space, belongs to
    // line-region-scale text, or is corroborated by other rows on the page.
    const wordGaps: number[] = [];
    for (let index = 1; index < orderedPieces.length; index += 1) {
      const previous = orderedPieces[index - 1]!;
      const current = orderedPieces[index]!;
      wordGaps.push(current.box.x - (previous.box.x + previous.box.width));
    }
    const wordSpacedLine =
      orderedPieces.length >= 4 &&
      orderedPieces.every((piece) => piece.box.width <= resolved.pageWidth * 0.15) &&
      wordGaps.every((gap) => gap >= 0 && gap <= WIDE_COLUMN_GUTTER + 2);
    const wideGaps = wordGaps.filter((gap) => gap >= WIDE_COLUMN_GUTTER).sort((a, b) => b - a);
    const dominantLineGap =
      wideGaps[0] !== undefined && (wideGaps[1] === undefined || wideGaps[0] >= wideGaps[1] * 2);
    const gutterNearMiddle = gutterCentred(leftEnd, rightStart, resolved.pageWidth);
    const straddlesMiddle = leftEnd <= middle + 4 && rightStart >= middle - 4;
    const gutterEvidence = gutterNearMiddle || straddlesMiddle;
    // A title's central whitespace is an ordinary word gap; a two-column gutter is wider.
    // Capitalisation alone cannot tell them apart: a merged body row routinely starts with a
    // proper noun and has no terminal punctuation at a line break. Only a word-gap-sized
    // centre gap suppresses the split, not the title-like casing of the whole row.
    // A detector that emits one quad per printed line can reduce a full-width sentence or a
    // long title to just two pieces; the word-level guards above cannot see those, so their
    // own text structure decides. Page-wide column evidence still wins over that text guess.
    const printedTitleRow = onePrintedTitleRow(
      pieces,
      resolved.pageWidth,
      titleAboveBody,
      titleAboveBody,
      cjkBodyGeometry,
    );
    const colonTitleRow =
      titleCentreEvidence && twoPieceColonTitle(pieces, resolved.pageWidth, wholeText);
    const titleLikeRow = printedTitleRow && headingWholeLine && !scientificBodyRow;
    // A short centred title can have a word gap far wider than a normal word space. A long
    // full-width title is only distinguishable from two body columns when the page's gutter
    // evidence sits below it; neither case covers a wide-gap two-column body row. On a
    // two-column page a narrow row needs page evidence or a genuinely centred span: a short
    // capitalised body row at a line break is not a title just because it fits in 60% of the page.
    const wideGapTitleRow =
      titleLikeRow &&
      (lineWidth < resolved.pageWidth * 0.6 || titleAboveBody) &&
      (!pageTwoColumn || titleAboveBody || rowCentredOnPage(pieces, resolved.pageWidth));
    const twoPieceTitleMerge =
      !cjkBodyGeometry &&
      ((printedTitleRow && !pageTwoColumn && !scientificBodyRow) ||
        wideGapTitleRow ||
        (printedTitleRow && scientificTitleRow) ||
        (colonTitleRow &&
          (!pageTwoColumn ||
            (!colonNotationBodyRow(wholeText, orderedPieces[0]?.text ?? '') &&
              wholeText.split(/\s+/u).length <= 14))));
    const singleRowWordGap =
      twoPieceTitleMerge || (!pageTwoColumn && singleSentenceRow(pieces, resolved.pageWidth));
    // A narrow centred row, a row above every body row, or a printed title row is genuine title
    // evidence. Capitalisation plus a short word-sized gap is not: a short two-column body row
    // at a line break looks exactly like that, and must not suppress the gutter split.
    const centredTitleRow =
      isCentredHeadingRow(pieces, resolved.pageWidth, titleAboveBody) &&
      lineWidth < resolved.pageWidth * 0.6;
    const positiveTitleEvidence = titleAboveBody || twoPieceTitleMerge || centredTitleRow;
    const wordGapTitleGuess =
      titleWholeLine || wordSpacedLine || wordSpaceGutter(pieces, gutterGap) || singleRowWordGap;
    const titleWordGap =
      wordGapTitleGuess &&
      (gutterGap <= WIDE_COLUMN_GUTTER + 2 || wideGapTitleRow) &&
      (!pageTwoColumn || positiveTitleEvidence);
    const wideTwoColumnLine =
      lineWidth >= resolved.pageWidth * 0.82 &&
      leftWidth > resolved.pageWidth * 0.18 &&
      rightWidth > resolved.pageWidth * 0.18 &&
      gutterEvidence &&
      gutterGap >= WIDE_COLUMN_GUTTER &&
      !titleWordGap;
    // A narrow row normally needs page-wide corroboration. Without it, two similarly wide
    // word spaces on one printed line are not a gutter; only a gap far wider than every other
    // gap on the row (a short left column beside a right body) can stand on its own.
    const narrowTwoColumnLine =
      lineWidth < resolved.pageWidth * 0.82 &&
      !titleWordGap &&
      ((pageTwoColumn && gutterGap >= MIN_COLUMN_GUTTER) ||
        (gutterGap >= WIDE_COLUMN_GUTTER * 2 && dominantLineGap));
    // A short left heading beside a normal body line is a two-column row too: the 18% width
    // floor for `wideTwoColumnLine` cannot see it, but the gutter and shared baseline can.
    const shortHeadingBesideBody =
      !pieceVertical &&
      gutterEvidence &&
      leftWidth >= 40 &&
      rightWidth > resolved.pageWidth * 0.18 &&
      isShortHeadingPieces(leftPieces) &&
      hasHeadingEvidence(leftText, median(leftPieces.map((piece) => piece.box.height)), 0) &&
      rightText.length >= Math.max(24, leftText.length * 2) &&
      sharesBaseline(leftPieces, rightPieces);
    // This detector emits one quad per printed line, so a merged two-column row often has
    // just two wide pieces, one of them a short fragment that fails the 18% width floor.
    // A line-region wide enough to be a column measure on either side is still firm evidence
    // of two columns; word-level boxes on a wavy single line are far narrower than this.
    // A single printed line region wide enough to be a column measure is strong evidence only
    // when the merged row really spans the page; on a narrow single-column line a wide phrase
    // quad beside an ordinary 6pt word gap is not a gutter.
    const wideLineRegionMerge =
      lineWidth >= resolved.pageWidth * 0.6 &&
      (pageTwoColumn || lineWidth >= resolved.pageWidth * 0.82) &&
      pieces.some((piece) => piece.box.width >= resolved.pageWidth * 0.3) &&
      !titleWordGap;
    const crossesGutter =
      resolved.pageWidth > 0 &&
      !pieceVertical &&
      gutterGap >= MIN_COLUMN_GUTTER &&
      gutterEvidence &&
      (narrowTwoColumnLine || wideTwoColumnLine || shortHeadingBesideBody || wideLineRegionMerge);
    const pushLine = (
      selected: OcrTextPiece[],
      id: string,
      columnHint?: number,
      titleRow = false,
    ): void => {
      if (selected.length === 0) return;
      const line = lineFrom(selected);
      const text = selected.map((piece) => piece.text).join(pieceVertical ? '' : ' ');
      output.push({
        ...line,
        text,
        id,
        pieces: selected,
        columnHint,
        titleRow: titleRow || undefined,
      });
    };
    if (resolved.pageWidth > 0 && !pieceVertical && lineWidth >= resolved.pageWidth * 0.82) {
      const rows = splitMergedBodyLine(pieces, resolved.pageWidth);
      if (rows) {
        pushLine(rows[0], lineId + ':left', 0);
        pushLine(rows[1], lineId + ':right', 1);
        continue;
      }
    }
    if (crossesGutter) {
      pushLine(leftPieces, lineId + ':left', 0);
      pushLine(rightPieces, lineId + ':right', 1);
      continue;
    }
    // Only mark rows with real title evidence. A capitalised body row kept whole by the word-gap
    // heuristic on a two-column page is a fused row, and the metric must still see its cover.
    pushLine(
      pieces,
      lineId,
      undefined,
      positiveTitleEvidence || (!pageTwoColumn && wordGapTitleGuess),
    );
  }
  return twoColumnOrder(output, resolved.pageWidth, columnContext(output, resolved.pageWidth));
}

/**
 * Page-wide column evidence from the raw reading lines. A dense scan can place a real gutter only
 * 6pt from an ordinary word space, so the width of one gap is not enough on its own: two or more
 * rows with comparable measures on both sides of a centred gap prove the page has body columns.
 * A lone single-column row (including a centred title or a merged two-column row) has no such
 * corroboration and keeps its ordinary word gaps. The row indices let a title above the body keep
 * its own whitespace even when the page as a whole is two-column.
 */
function twoColumnBodyRows(
  lines: readonly ReadingLine<OcrRegion>[],
  resolved: ResolvedConversion,
): readonly number[] {
  const rows: number[] = [];
  for (const [lineIndex, readingLine] of lines.entries()) {
    const pieces: OcrTextPiece[] = [];
    for (const [itemIndex, region] of readingLine.items.entries()) {
      if (region.text.trim().length === 0) continue;
      const detectorIndex = readingLine.indices[itemIndex];
      const regionIndex =
        detectorIndex !== undefined && Number.isSafeInteger(detectorIndex) && detectorIndex >= 0
          ? detectorIndex
          : itemIndex;
      const id =
        'ocr:p' +
        String(resolved.pageIndex) +
        ':l' +
        String(lineIndex) +
        ':r' +
        String(regionIndex);
      pieces.push(regionPiece(region, region.vertical, id, resolved.scaleX, resolved.scaleY));
    }
    if (pieces.length < 2 || pieces.some((piece) => piece.displayed === 90)) continue;
    if (isCentredHeadingRow(pieces, resolved.pageWidth)) continue;
    // A CJK two-piece row cannot be discarded as a title on text shape alone: Japanese body
    // lines have the same glyph shape. Geometry below decides whether the page has columns,
    // and a lone CJK row still keeps its title treatment in the main conversion pass.
    if (!cjkTextRow(pieces) && onePrintedTitleRow(pieces, resolved.pageWidth, true)) continue;
    if (singleSentenceRow(pieces, resolved.pageWidth)) continue;
    const { left, right, leftEnd, rightStart } = splitAtGutter(pieces, resolved.pageWidth);
    if (left.length === 0 || right.length === 0) continue;
    const measure = (group: readonly OcrTextPiece[]): number =>
      Math.max(...group.map((piece) => piece.box.x + piece.box.width)) -
      Math.min(...group.map((piece) => piece.box.x));
    if (
      rightStart - leftEnd >= WIDE_COLUMN_GUTTER &&
      measure(left) >= resolved.pageWidth * 0.15 &&
      measure(right) >= resolved.pageWidth * 0.15 &&
      gutterCentred(leftEnd, rightStart, resolved.pageWidth)
    ) {
      rows.push(lineIndex);
    }
  }
  return rows;
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

interface ColumnRange {
  readonly left: number;
  readonly right: number;
}

interface ColumnContext {
  /** The page has body lines in both columns on at least one shared horizontal band. */
  readonly twoColumn: boolean;
  /** Lines printed in the opposite column on the same baseline band. */
  readonly oppositeBand: ReadonlySet<OcrTextLine>;
  /** Median body line height, used to tell an oversized heading from body prose. */
  readonly bodySize: number;
  /** X spans of the confident body columns, used to place lines whose midpoint is ambiguous. */
  readonly ranges: readonly ColumnRange[];
}

/**
 * Page-wide evidence for column assignment. A single centred column has no opposite column,
 * so its lines must keep visual order even when some midpoints fall just below mid-page.
 * A short heading with no opposite-column partner on its own baseline is a section heading
 * spanning the layout (e.g. a left-aligned "References"), not a left-column paragraph.
 */
function columnContext(lines: readonly OcrTextLine[], pageWidth: number): ColumnContext {
  const bodySize = bodyFontSize(lines);
  const single = {
    twoColumn: false,
    oppositeBand: new Set<OcrTextLine>(),
    bodySize,
    ranges: [] as readonly ColumnRange[],
  };
  if (pageWidth <= 0 || lines.length < 2) return single;
  const centre = (line: OcrTextLine): number => line.box.x + line.box.width / 2;
  // A rotated margin stamp is not a body line: exclude it from inference instead of letting one
  // vertical region disqualify the whole page and merge the horizontal columns.
  const bodies = lines.filter((line) => !verticalLine(line) && line.box.width <= pageWidth * 0.6);
  const left = bodies.filter((line) => centre(line) < pageWidth * 0.45);
  const right = bodies.filter((line) => centre(line) > pageWidth * 0.55);
  const twoColumn = left.some((a) =>
    right.some((b) => {
      const overlap =
        Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y);
      return overlap > Math.min(a.box.height, b.box.height) * 0.5;
    }),
  );
  if (!twoColumn) return single;
  const span = (group: readonly OcrTextLine[]): ColumnRange | null =>
    group.length === 0
      ? null
      : {
          left: Math.min(...group.map((line) => line.box.x)),
          right: Math.max(...group.map((line) => line.box.x + line.box.width)),
        };
  const ranges = [span(left), span(right)].filter((range): range is ColumnRange => range !== null);
  // Use the same column evidence as lineColumn when deciding which lines sit opposite each
  // other. A short left-column tail whose midpoint passes the page midpoint is still left of a
  // right-column line on the same baseline.
  const sideOf = (line: OcrTextLine): number => {
    const mid = centre(line);
    if (mid >= pageWidth * 0.4 && mid <= pageWidth * 0.6) {
      const geometric = columnFromRanges(line, ranges);
      if (geometric !== null) return geometric;
    }
    return mid < pageWidth / 2 ? 0 : 1;
  };
  const oppositeBand = new Set<OcrTextLine>();
  for (const line of lines) {
    if (verticalLine(line)) continue;
    const side = sideOf(line);
    if (
      lines.some(
        (other) =>
          other !== line &&
          !verticalLine(other) &&
          sideOf(other) !== side &&
          Math.abs(other.box.y - line.box.y) <= Math.max(1, line.box.height * 0.3),
      )
    ) {
      oppositeBand.add(line);
    }
  }
  return { twoColumn: true, oppositeBand, bodySize, ranges };
}

/**
 * Assign a line using the measured body-column spans instead of the page midpoint.
 *
 * A short line printed at the right edge of the left column can have its midpoint past the page
 * midpoint. A midpoint split moves it into the right block, whose room then expands to that
 * line's minX and paints a cover over the left column. The nearest column span is stronger
 * evidence: choose the span with the smaller horizontal gap to the line, breaking ties by the
 * amount of overlap.
 */
function columnFromRanges(line: OcrTextLine, ranges: readonly ColumnRange[]): number | null {
  if (ranges.length < 2) return null;
  const lineLeft = line.box.x;
  const lineRight = line.box.x + line.box.width;
  const gaps = ranges.map((range) => Math.max(range.left - lineRight, lineLeft - range.right, 0));
  const smallest = Math.min(...gaps);
  const tied = ranges
    .map((range, index) => ({ range, index }))
    .filter(({ index }) => gaps[index] === smallest);
  if (tied.length === 1) return tied[0]!.index;
  const overlap = (range: ColumnRange): number =>
    Math.max(0, Math.min(lineRight, range.right) - Math.max(lineLeft, range.left));
  let bestIndex: number | null = null;
  let bestOverlap = -1;
  for (const { range, index } of tied) {
    const value = overlap(range);
    if (value > bestOverlap) {
      bestOverlap = value;
      bestIndex = index;
    }
  }
  return bestOverlap > 0 ? bestIndex : null;
}

/** Geometric column of a line. Full-width lines get a group of their own. */
function lineColumn(
  line: OcrTextLine,
  pageWidth: number,
  context: ColumnContext = columnContext([line], pageWidth),
): number {
  if (pageWidth <= 0) return 0;
  // A line emitted by a gutter split already knows which side of the printed column it came
  // from. Recomputing from its own box would misclassify an overflowing right-column row.
  if (line.columnHint !== undefined && !verticalLine(line)) return line.columnHint;
  // Without two body columns there is nothing to interleave: a single-column scan keeps its
  // top-to-bottom source order and one paragraph group. The width test must not run first:
  // a full-width first line would become spanning while its short last line becomes column 0,
  // splitting one paragraph. Only a line physically wider than the page is still spanning.
  if (!context.twoColumn) return line.box.width > pageWidth ? SPANNING_COLUMN : 0;
  const mid = line.box.x + line.box.width / 2;
  if (line.box.width > pageWidth * 0.6) return SPANNING_COLUMN;
  const headingText = line.text.trim();
  const heading =
    !verticalLine(line) &&
    !CAPTION_LINE.test(headingText) &&
    isShortHeadingPieces(line.pieces) &&
    hasHeadingEvidence(headingText, line.height, context.bodySize);
  if (heading) {
    const nearCentre = Math.abs(mid - pageWidth / 2) <= pageWidth * 0.06;
    // A left-aligned `column-span: all` heading (e.g. "References") has no partner on its own
    // baseline. A numbered section heading such as "2.1 Runtime" is part of its column even
    // when the neighbouring column's row starts lower down.
    const leftAlignedSpanning =
      line.box.x <= pageWidth * 0.15 &&
      !context.oppositeBand.has(line) &&
      !SECTION_LINE.test(headingText) &&
      !/[\d]/u.test(headingText) &&
      headingText.split(/\s+/u).filter(Boolean).length <= 4;
    if (nearCentre || leftAlignedSpanning) return SPANNING_COLUMN;
  }
  // A centred title or byline can be just under the full-width threshold while its word boxes
  // cover the page gutter. Without this, it is assigned to a body column and its cover is
  // wrongly reported as crossing into the neighbouring column. A short body line that happens
  // to straddle the gutter has a partner in the opposite column on the same band, so it stays
  // with its own column.
  const gutter = pageWidth * 0.49;
  if (
    line.box.x + 4 < gutter &&
    line.box.x + line.box.width > gutter + 4 &&
    !context.oppositeBand.has(line) &&
    (Math.abs(mid - pageWidth / 2) <= pageWidth * 0.06 ||
      (/:/u.test(headingText) && line.box.x <= pageWidth * 0.12))
  ) {
    return SPANNING_COLUMN;
  }
  // Only lines in the ambiguous middle band need page-wide evidence. Well-separated body lines
  // keep the midpoint rule, which also covers the single-column case and vertical writing.
  if (mid >= pageWidth * 0.4 && mid <= pageWidth * 0.6) {
    const geometric = columnFromRanges(line, context.ranges);
    if (geometric !== null) return geometric;
  }
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
function twoColumnOrder(
  lines: readonly OcrTextLine[],
  pageWidth: number,
  context: ColumnContext = columnContext(lines, pageWidth),
): OcrTextLine[] {
  if (pageWidth <= 0 || lines.length < 2 || !context.twoColumn) return [...lines];
  // Vertical Japanese columns carry an authoritative right-to-left order. A page made only of
  // vertical lines keeps it; on a mostly horizontal page a rotated stamp is held at its source
  // position as a run separator, so it cannot suppress the ordering of the body columns.
  if (lines.every(verticalLine)) return [...lines];
  const ordered: OcrTextLine[] = [];
  let run: OcrTextLine[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    ordered.push(
      ...run
        .map((line, index) => ({ line, index, column: lineColumn(line, pageWidth, context) }))
        .sort((a, b) => a.column - b.column || a.line.box.y - b.line.box.y || a.index - b.index)
        .map((entry) => entry.line),
    );
    run = [];
  };
  for (const line of lines) {
    if (verticalLine(line) || lineColumn(line, pageWidth, context) === SPANNING_COLUMN) {
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
// Japanese numbered headings use a CJK letter after the number, not a Latin capital.
const SECTION_LINE =
  /^\d+(?:\.\d+)*\.?\s+(?:\p{Lu}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana})/u;
/** Unambiguous section labels, sized like body text when OCR sees them on their own. */
const HEADING_LABEL =
  /^(?:abstract|references?|introduction|conclusions?|acknowledge?ments?|bibliography|appendi(?:x|ces)|summary|overview|related work|background|methods?|results?|discussion|概要|要旨|抄録|参考文献|はじめに|序論|結論|まとめ|謝辞|付録|目次|関連研究)[.:：]?$/iu;

/**
 * A short line is a heading only with independent evidence: a section number, a known section
 * label, or type visibly larger than the page's body. Prose of four English words or one
 * Japanese line has none of these and must stay in its paragraph.
 */
function hasHeadingEvidence(text: string, height: number, bodySize: number): boolean {
  const trimmed = text.trim();
  return (
    SECTION_LINE.test(trimmed) ||
    HEADING_LABEL.test(trimmed) ||
    (bodySize > 0 && height >= bodySize * 1.15)
  );
}

/**
 * A listing line whose OCR lost its indentation but kept code punctuation.
 *
 * Treating leading `for`, `if`, `return`, ... as proof of code skips ordinary paper sentences
 * (`For each batch we compute the loss`), so statement structure is required: block braces,
 * an array index, or a terminating `;` / `:` distinguish a listing from prose. A bracketed
 * citation (`the result [12] is positive`) is not an index. A bare operator, an assignment
 * sign, or a mid-sentence semicolon is not enough: `If the loss < 0.1 we stop training after`
 * is a wrapped sentence. A colon followed by a prose clause ("For each batch: we compute the
 * loss") is ordinary prose unless it ends the line. Sentences that end in a full stop are prose
 * regardless of their first word.
 */
function looksLikeBareCodeLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length >= 140 || /[.!?。]$/u.test(trimmed)) return false;
  const statement = trimmed.replace(/^\d+\s+/u, '');
  if (!/^(?:for|foreach|if|while|emit|return|continue|def)\b/iu.test(statement)) return false;
  if (/^(?:for example|for instance|if so|if any)\b/iu.test(statement)) return false;
  // Parentheses on their own are ordinary prose ("For each layer (see Figure 2), we ...").
  // Statements keep their assignment, block, continuation and operator punctuation; a bare
  // function call is code only when nothing follows its closing parenthesis.
  // A bare operator is not code evidence: technical prose compares values too
  // ("If the loss < 0.1 we stop training after") and identifiers may contain an
  // underscore or a URL. Only statement structure distinguishes a listing line:
  // a terminating `;` / `:`, block delimiters, or a complete call/loop header.
  if (/[;:]\s*$/u.test(statement)) return true;
  // Curly braces are listing blocks. Square brackets are code only as an index attached to
  // an identifier (`row[i]`, `values[0]`): a spaced bracket is a citation or a parenthetical
  // inside a wrapped sentence (`If the result [12] is positive we accept`, `For each layer
  // [see Figure 2] we compute the loss`), which must stay prose and be translated.
  if (/[{}]/u.test(statement)) return true;
  if (/[\p{L}\p{N}_)\]]\[[^\]]*\]/u.test(statement)) return true;
  return /^(?:for|foreach|if|while|emit|return|continue|def)\s+[\p{L}_][\p{L}\p{N}_]*\([^()]*\)\s*;?$/iu.test(
    statement,
  );
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
    // A line-broken word continues even when the remainder starts with a capital
    // ("Web-" / "Assembly" is one proper noun, not two translation units).
    const hyphenated = /[-‐‑‒–]\p{L}?$/u.test(output) && /^\p{L}/u.test(value);
    output = hyphenated
      ? output.replace(/[-‐‑‒–]\p{L}?$/u, '') + value
      : output + (vertical ? '' : ' ') + value;
  }
  return output.replace(/\s+/gu, ' ').trim();
}

/**
 * Japanese OCR lines are one continuous letter run, so the Latin word counter in
 * `hasSourceProse` undercounts them. A long CJK-majority line is body text and must reach the
 * engine instead of being skipped as a label.
 */
function hasCjkProse(text: string): boolean {
  const compact = text.replace(/\s+/gu, '');
  // A two-character CJK section label such as "概要" is a translatable heading, not furniture.
  // Numeric-only labels are rejected separately by groupRole before this point.
  return cjkRatio(text) >= CJK_MAJORITY && compact.length >= 2 && /\p{L}/u.test(compact);
}
function groupRole(group: readonly OcrTextLine[], bodySize: number): AnyBlockRole {
  const text = groupText(group);
  if (CAPTION_LINE.test(text)) return 'caption';
  if (group.some((line) => looksLikeCodeLine(line.text) || looksLikeBareCodeLine(line.text))) {
    return 'code';
  }
  if (/^[^\p{L}]*\d+[^\p{L}]*$/u.test(text)) return 'label';
  // A one-word heading such as "References" or "Abstract" is body prose, not a furniture
  // label. It must reach the engine and be counted in the prose denominator; a numeric or
  // punctuation-heavy label stays skipped.
  const first = group[0];
  if (
    /^[\p{L}][\p{L}\s'’&.,:-]*$/u.test(text) &&
    !/[\d]/u.test(text) &&
    ((text.match(/\p{L}{3,}/gu)?.length ?? 0) >= 1 ||
      (cjkRatio(text) >= CJK_MAJORITY && text.replace(/\s+/gu, '').length >= 2)) &&
    text.split(/\s+/u).filter(Boolean).length <= 4 &&
    text.length <= 40 &&
    !/[.!?]$/u.test(text) &&
    hasHeadingEvidence(text, first?.height ?? 0, bodySize)
  ) {
    return 'heading';
  }
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
  return hasSourceProse(text) || hasCjkProse(text) ? 'prose' : 'label';
}

function groupBlocks(
  lines: readonly OcrTextLine[],
  pageWidth: number,
  bodySize: number,
): OcrBlockGroup[] {
  const groups: OcrBlockGroup[] = [];
  const context = columnContext(lines, pageWidth);
  for (const line of twoColumnOrder(lines, pageWidth, context)) {
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
      lineColumn(line, pageWidth, context) !== last.column ||
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
        column: lineColumn(line, pageWidth, context),
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
      titleRow: group.lines.every((line) => line.titleRow === true) || undefined,
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
  /** Tier the host was asked to run; selects the matching local safety net. */
  readonly tier?: OcrTier;
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
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      this.options.timeoutMs ?? ocrPageTimeoutMs(this.options.tier ?? 'standard'),
    );
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
