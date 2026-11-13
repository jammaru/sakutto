import { boxBottom, boxRight, median, unionBox, type Box } from './geometry';
import { insideFigure, type FigureAreas } from './figures';
import { gutterCandidates, horizontalGaps, groupByBaseline } from './gaps';
import {
  isBylineLabel,
  isFirstPageIdentity,
  isMarkedAuthorLine,
  isSectionHeading,
} from './identity';
import { CJK_MAJORITY, cjkRatio } from './fonts';
import { hasSourceProse } from './prose-detect';
import { SEGMENT_GAP, isRotated, lineFrom, type TextLine, type TextPiece } from './lines';

/** What kind of thing a block is, which decides its priority and how tightly it is fitted. */
export type BlockRole = 'heading' | 'prose' | 'cell' | 'caption' | 'label';

/**
 * Roles the reader never translates, kept in the block's own role field.
 *
 * `equation` is a display formula, which is set in the paper's own math fonts and already
 * typeset correctly: replacing it with translated text puts prose where the mathematics was.
 * `figure-label` is text inside a drawing — an axis tick, a legend key, a box in a diagram —
 * which belongs to the artwork rather than to the prose around it.
 * `identity` is a first-page byline: a person name, an affiliation, or an email. Translating
 * those transliterates a name, which is worse than leaving the original spelling.
 */
export type UntranslatedRole = 'equation' | 'figure-label' | 'code' | 'furniture' | 'identity';

/** Every role a block can have, translated or not. */
export type AnyBlockRole = BlockRole | UntranslatedRole;

export type BlockAlign = 'left' | 'center' | 'right';

/**
 * One unit of translation and of layout: a paragraph, a heading, a table cell, a caption.
 *
 * The block carries the box the source text occupied, which is the box the translation is
 * laid out in. That is what keeps the page readable: a translated paragraph is set inside the
 * area its source filled, on the same column and under the same heading, instead of being
 * appended to a text flow that has forgotten where anything was.
 */
export interface LayoutBlock {
  box: Box;
  /**
   * The extent the block may grow into: its column, or the white space beside its table cell.
   * A short last line makes `box` narrower than the paragraph really was, and a translation
   * fitted to only `box` would wrap much sooner than the source did.
   */
  room: Box;
  lines: TextLine[];
  /** Source text, with hyphenation resolved and the lines joined. */
  text: string;
  role: AnyBlockRole;
  /** Font size the source set the block in, in points. */
  fontSize: number;
  /** Baseline-to-baseline distance divided by the font size. */
  lineHeight: number;
  align: BlockAlign;
  bold: boolean;
  italic: boolean;
  /** Reading column this block belongs to, counted from the left of its region. */
  column: number;
  /**
   * Length of the source along its writing direction, in points.
   *
   * After `/Rotate 90` or `/Rotate 270` the axis-aligned box has `width` equal to the em and
   * `height` equal to the advance. Wrapping to `box.width` would set one character per line.
   */
  advance: number;
  /** Writing direction after the viewport transform: 90 and 270 run down or up the page. */
  writing: 0 | 90 | 180 | 270;
}

export function verticalWriting(block: Pick<LayoutBlock, 'writing'>): boolean {
  return block.writing === 90 || block.writing === 270;
}

export interface PageLayout {
  blocks: LayoutBlock[];
  /** Most common font size on the page, which decides what counts as a heading. */
  bodySize: number;
  /** Median font size of the page, in points. Used for the cut thresholds. */
  lineHeight: number;
  /**
   * Blocks the reader leaves alone: display equations, axis ticks, code, running headers.
   *
   * They are not translated and no box is painted over them. The reader keeps the list so it
   * can report how much of a page it left in the source's own typesetting, which is the
   * number that says whether a paper's formulas survived.
   */
  skipped: LayoutBlock[];
  /** Page height in points when the caller knew it, else 0. */
  pageHeight: number;
  /** Page width in points when the caller knew it, else 0. */
  pageWidth: number;
  /** Zero-based page number, used to leave first-page bylines untranslated. */
  pageIndex: number;
  /**
   * Drawn areas that occupy space even when they hold no text: figure images, and anything
   * else the extractor reported. Growth and wrapping treat them as walls.
   */
  obstacles: Box[];
}

/** A horizontal cut needs this much clear space to be a paragraph or row gap. */
const MIN_ROW_GAP = 0.7;
/** A gutter needs this wide a band at its narrowest, in font sizes. */
const MIN_GUTTER_WIDTH = 0.55;
/**
 * A gutter has to be supported by this share of the page's rows. A title spans both columns,
 * so a real gutter is never supported by every row; a figure's label grid is supported by few.
 */
const MIN_GUTTER_SUPPORT = 0.34;
/**
 * A paragraph break is this much wider than the block's own leading. Justified text sits at
 * exactly one leading between lines of a paragraph, and the space between two paragraphs is
 * a little more, so the threshold has to be relative to the leading the source used.
 */
const PARAGRAPH_RATIO = 1.18;
/**
 * A first line indented by this much from its column starts a paragraph when the line above
 * finished a sentence. Below the minimum it is a normal word space; at the maximum it is a
 * display formula, which the equation rule handles.
 */
const PARAGRAPH_INDENT_MIN_EM = 0.8;
const PARAGRAPH_INDENT_MAX_EM = 3;
/**
 * A prose block longer than this is split at a sentence boundary. One failed translation then
 * costs one paragraph instead of taking a whole page's fused column with it. The limit is half
 * the PDF session's prompt cap: inline formulas expand into placeholders after layout, so a
 * block at this length still travels as one prompt.
 */
const MAX_PROSE_BLOCK_CHARS = 600;
/** A type size change of this fraction is a different kind of thing. */
const SIZE_CHANGE = 0.12;
/** Two cells belong to the same column when this much of the narrower one is shared. */
const MIN_COLUMN_OVERLAP = 0.5;
/** A run of rows is a table when this fraction of them hold two or more cells. */
const TABLE_ROW_SHARE = 0.5;
/** The widest text a table cell may hold, in characters. */
const CELL_MAX_CHARS = 44;
/**
 * Cell padding inside a table, in ems. Narrower than a justified word space (~0.62em), so
 * it must only be used after the region is already a table. Applying it to prose splits a
 * paragraph word by word.
 */
const CELL_SPLIT_GAP = 0.42;
/** A table has this many columns at most; more short runs on a row are words, not cells. */
const MAX_TABLE_CELLS = 8;
/**
 * Text this much smaller than the body belongs to a figure, not to the page's prose.
 *
 * A paper's body is 9–10pt, a footnote 7.5–8pt and a reference list 8pt; a diagram's labels are
 * 3–5pt, and an axis tick can be 2pt. The gap is wide enough that a threshold at 60% keeps
 * footnotes and references while dropping the inside of every figure.
 */
const FIGURE_LABEL_RATIO = 0.62;
/** Type below this, in points, cannot carry a translation a reader can use. */
const MIN_TRANSLATE_PT = 5.5;
/** A running header or page number sits this close to the top or foot of the page. */
const FURNITURE_MARGIN = 40;
/**
 * How much wider than its own text a block may wrap.
 *
 * The column is the outside limit, but a footnote set in a narrow measure, a caption beside a
 * figure and a centred byline all occupy less than the full column. Letting them wrap to the
 * column's width turned a three-line footnote into a block as wide as the page, which then ran
 * into the column beside it. A little over the source measure is enough to absorb a longer
 * translation without changing the shape of the page.
 */
const ROOM_GROWTH = 1.12;
/** White space kept at a box's right edge, in points, so two columns never touch. */
const GUTTER_CLEARANCE = 4;
/**
 * A line of a contents list: dot leaders.
 *
 * `A.1  Scaling laws . . . . . 42` is typesetting, not prose. The leaders are glyph runs of
 * their own, so the row splits into a number, a title, a run of dots and a page number; the
 * layout then treated each of those as a cell and the numbers were translated as sentences.
 * Replacing one of them painted translated text over the others, which is what made a contents
 * page a mess of overlapping boxes.
 */
const DOT_LEADERS = /(?:\.\s*){4,}/u;

/**
 * Splits the lines of one page into blocks, in reading order.
 *
 * The page is cut recursively: vertically at a gutter when most of its rows are split there,
 * horizontally where a band of rows is clear. Nothing in that rule knows about columns,
 * headings or captions, which is the point — a two-column paper, a full-width abstract above
 * both columns, a figure with its caption all fall out of the same rule.
 *
 * A table is the one shape the cut cannot express, so a region that reads as a table is
 * recognised before it is cut and laid out cell by cell instead.
 */
export function layoutPage(
  lines: readonly TextLine[],
  figures: FigureAreas = { images: [] },
  page: { width?: number; height?: number; index?: number } = {},
): PageLayout {
  // Rotated text is never translated. In a paper it is a stamp — a repository identifier
  // written up the left margin — or a figure's axis label, and both are strings that must
  // stay exactly as they are. Its box also spans the column it sits beside, so leaving it in
  // the page is what used to merge a stamp into the paragraph next to it.
  const pageHeight = page.height ?? 0;
  const pageWidth = page.width ?? 0;
  const pageIndex = page.index ?? -1;
  const obstacles = [...(figures.images ?? [])];
  const empty = (): PageLayout => ({
    blocks: [],
    bodySize: 0,
    lineHeight: 0,
    skipped: [],
    pageHeight,
    pageWidth,
    pageIndex,
    obstacles,
  });
  const clean = lines.filter((line) => line.text.trim().length > 0 && !isRotated(line));
  const unit = clean.length > 0 ? Math.max(1, median(clean.map((line) => line.height))) : 10;
  const bodySize = clean.length > 0 ? bodySizeOf(clean) : 0;
  const blocks: LayoutBlock[] = [];

  if (clean.length > 0) {
    for (const region of cutRegions(clean, unit)) {
      appendRegionBlocks(region, bodySize, blocks, figures, pageHeight, pageIndex);
    }
  }
  assignLeftoverLines(
    lines,
    blocks,
    figures,
    bodySize > 0 ? bodySize : unit,
    pageHeight,
    pageIndex,
  );
  if (blocks.length === 0) {
    return empty();
  }

  // A figure's labels — axis ticks, a legend, the words inside a diagram — are set much smaller
  // than the body. They are not prose and they must not be replaced: a translated label sits on
  // top of the drawing it names, and it is what makes a translated figure unreadable. A footnote
  // and a reference list are smaller than the body too, but not this much smaller, so the
  // threshold is well below them.
  //
  // A contents list is left alone for the same reason: its dot leaders are not words, and
  // replacing a line of them painted translated text over the numbers beside them. Only the
  // leaders identify a contents line; a number at the end of a row is how a table sets a
  // value, so a rule that also matched that would drop a table's numbers.
  const contentsRows = new Set<number>();
  for (const row of groupByBaseline(clean)) {
    if (!row.some((line) => DOT_LEADERS.test(line.text))) continue;
    for (const line of row) contentsRows.add(line.baseline);
  }

  // A run of notation is not prose either. `p_η  p_θ` beside a diagram's labels came back as
  // transliterated nonsense painted onto the drawing, and the row of it was what put a second
  // box on top of the first. A table cell like `48` is a value that must stay as drawn:
  // translating it glues the number onto the neighbour's words. Notation has no word at all
  // and is set smaller than the body.
  const isProse = (block: LayoutBlock): boolean => {
    if (isNumericRow(block.text)) return false;
    if (block.role === 'caption' || block.role === 'heading' || block.role === 'prose') {
      return true;
    }
    if (isNumericCell(block.text)) return false;
    if (isCodeToken(block.text)) return false;
    if (isTick(block.text) && block.role !== 'cell' && block.role !== 'label') return false;
    if (block.role === 'label') {
      if (hasWord(block.text)) return true;
      return bodySize <= 0 || block.fontSize >= bodySize * 0.9;
    }
    return hasWords(block.text) || block.fontSize >= bodySize * 0.9;
  };

  // A block is translated only when it is prose. Everything else — an equation, an axis tick,
  // a code listing, a running header — is left exactly as the page drew it, and is reported
  // separately so the reader can say how much of a page it kept in its own setting.
  const translatable = (block: LayoutBlock): boolean => {
    if (SKIP_ROLES.has(block.role)) return false;
    if (block.fontSize < MIN_TRANSLATE_PT) return false;
    if (
      bodySize > 0 &&
      block.fontSize < bodySize * FIGURE_LABEL_RATIO &&
      block.role !== 'label' &&
      block.role !== 'caption' &&
      block.role !== 'heading' &&
      block.role !== 'prose'
    ) {
      return false;
    }
    if (block.lines.some((line) => contentsRows.has(line.baseline))) return false;
    if (isNumericCell(block.text) || isCodeToken(block.text)) return false;
    // A one-line formula set as a label (`St = (I − βt) St−1`) is not a heading: translating
    // it garbles the symbols. Leave the page's own typesetting.
    if (block.role === 'label' && /[=∈≈]/.test(block.text) && !hasWords(block.text)) return false;
    return isProse(block);
  };

  const kept = splitMergedOverlongProse(
    splitProseAcrossObstacles(
      mergeAdjacentProseBlocks(
        blocks.filter(translatable),
        bodySize,
        figures,
        pageHeight,
        pageIndex,
        clean,
      ),
      clean,
      bodySize,
      figures,
      pageHeight,
      pageIndex,
    ),
    bodySize,
    figures,
    pageHeight,
    pageIndex,
  );
  const gutterMid = pageWidth > 0 ? pageWidth * 0.49 : 0;
  const pageSpansGutter =
    gutterMid > 0 &&
    clean.some((line) => line.box.x < gutterMid - 2) &&
    clean.some((line) => line.box.x >= gutterMid - 2);
  let output = mergeLabelFragments(kept, bodySize, figures, pageHeight, pageIndex);
  if (pageWidth > 0 && pageSpansGutter) {
    output = splitNumberedListProse(output, bodySize, figures, pageHeight, pageIndex, pageWidth);
    output = splitProseAtGutter(output, pageWidth, bodySize, figures, pageHeight, pageIndex);
    refineProseBoxes(output, pageWidth, { tightenOnly: true });
  }
  const skippedFinal = blocks.filter((block) => !translatable(block));
  const orphanProbe: PageLayout = {
    blocks: output,
    bodySize,
    lineHeight: unit,
    skipped: skippedFinal,
    pageHeight,
    pageWidth,
    pageIndex,
    obstacles,
  };
  const orphanCount = orphanLineCount(clean, orphanProbe);
  if (pageWidth > 0 && pageSpansGutter && pageIndex > 0 && orphanCount > 0) {
    for (let pass = 0; pass < 4; pass += 1) {
      attachOrphanLinePieces(
        output,
        clean,
        pageWidth,
        bodySize > 0 ? bodySize : unit,
        figures,
        pageHeight,
        pageIndex,
      );
      if (orphanLineCount(clean, { ...orphanProbe, blocks: output }) === 0) break;
    }
    output = splitProseAtGutter(output, pageWidth, bodySize, figures, pageHeight, pageIndex);
    refineProseBoxes(output, pageWidth, { tightenOnly: true });
  }
  return {
    blocks: output,
    bodySize,
    lineHeight: unit,
    skipped: skippedFinal,
    pageHeight,
    pageWidth,
    pageIndex,
    obstacles,
  };
}

/**
 * Lines the cut dropped: rotated stamps, and any run whose pieces never joined a block.
 * They are appended so every extracted line belongs to `blocks` or `skipped`.
 */
function assignLeftoverLines(
  extracted: readonly TextLine[],
  blocks: LayoutBlock[],
  figures: FigureAreas,
  bodySize: number,
  pageHeight: number,
  pageIndex: number,
): void {
  const assigned = assignedPieces(blocks);
  for (const line of extracted) {
    if (line.text.trim().length === 0) continue;
    const missing = line.pieces.filter((piece) => !assigned.has(piece));
    if (missing.length === 0) continue;
    const leftover = missing.length === line.pieces.length ? line : lineFrom(missing);
    const block = buildBlock(
      [leftover],
      leftover.box,
      0,
      bodySize,
      figures,
      leftover.box.x,
      pageHeight,
      pageIndex,
    );
    if (!block) continue;
    blocks.push(isRotated(line) ? { ...block, role: 'furniture' } : block);
    for (const piece of leftover.pieces) assigned.add(piece);
  }
}

function assignedPieces(blocks: readonly LayoutBlock[]): Set<TextPiece> {
  const assigned = new Set<TextPiece>();
  for (const block of blocks) {
    for (const line of block.lines) {
      for (const piece of line.pieces) assigned.add(piece);
    }
  }
  return assigned;
}

function attachOrphanLinePieces(
  blocks: LayoutBlock[],
  extracted: readonly TextLine[],
  pageWidth: number,
  bodySize: number,
  figures: FigureAreas,
  pageHeight: number,
  pageIndex: number,
): void {
  const assigned = assignedPieces(blocks);
  const gutter = pageWidth > 0 ? pageWidth * 0.49 : Infinity;
  for (const line of extracted) {
    if (line.text.trim().length === 0) continue;
    const missing = line.pieces.filter((piece) => !assigned.has(piece));
    if (missing.length === 0) continue;
    const column = line.box.x >= gutter - 2 ? 1 : 0;
    let host: LayoutBlock | undefined;
    let bestGap = Infinity;
    const proximity = Math.max(line.height, bodySize) * (line.text.trim().length < 16 ? 2.2 : 0.55);
    for (const block of blocks) {
      if (block.role !== 'prose' && block.role !== 'heading') continue;
      if (block.column !== column) continue;
      for (const candidate of block.lines) {
        const gap = Math.abs(candidate.baseline - line.baseline);
        if (gap > proximity) continue;
        if (gap < bestGap) {
          bestGap = gap;
          host = block;
        }
      }
    }
    const carry = missing.length === line.pieces.length ? line : lineFrom(missing);
    if (
      isBylineLabel(carry.text) ||
      isAffiliationLine(carry.text) ||
      isTableHeaderLine(carry.text)
    ) {
      continue;
    }
    if (!host) {
      if (carry.text.trim().length < 16) continue;
      const built = buildBlock(
        [carry],
        carry.box,
        column,
        bodySize,
        figures,
        carry.box.x,
        pageHeight,
        pageIndex,
      );
      if (!built || (built.role !== 'prose' && built.role !== 'heading')) continue;
      blocks.push(built);
      for (const piece of carry.pieces) assigned.add(piece);
      continue;
    }
    const hostIndex = blocks.indexOf(host);
    if (hostIndex < 0) continue;
    const mergedLines = [...host.lines, carry];
    const rebuilt = buildBlock(
      mergedLines,
      host.room,
      host.column,
      bodySize,
      figures,
      host.box.x,
      pageHeight,
      pageIndex,
    );
    if (!rebuilt) continue;
    blocks[hostIndex] = { ...rebuilt, role: host.role };
    for (const piece of carry.pieces) assigned.add(piece);
  }
}

/** Extracted lines whose pieces never landed in a translatable or skipped block. */
export function orphanLineCount(extracted: readonly TextLine[], layout: PageLayout): number {
  const assigned = assignedPieces([...layout.blocks, ...layout.skipped]);
  let orphans = 0;
  for (const line of extracted) {
    if (line.text.trim().length === 0 || line.pieces.length === 0) continue;
    if (line.pieces.some((piece) => !assigned.has(piece))) orphans += 1;
  }
  return orphans;
}

/** Roles the reader never translates; the page's own typesetting is the rendering. */
const SKIP_ROLES: ReadonlySet<AnyBlockRole> = new Set<AnyBlockRole>([
  'equation',
  'figure-label',
  'code',
  'furniture',
  'identity',
]);

/** A caption opens with a figure, table, or algorithm number. */
const CAPTION_START = /^(?:Fig(?:ure)?|Tab(?:le)?|Alg(?:orithm)?)\.?\s*\d/iu;

/** True when a line is a numbered caption rather than a table header or a paragraph. */
export function isCaptionLine(text: string): boolean {
  return CAPTION_START.test(text.trim());
}

/**
 * True when a short title-case run reads as a table header, not as caption text.
 *
 * `Backend` sitting under `Figure 1: Comparison of backends` was joined into the caption
 * because the leading between them looked like a wrapped line. The header is short, has no
 * sentence punctuation, and starts with a capital — which a wrapped caption line does not.
 */
export function isTableHeaderLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return false;
  if (/^\d+\.\s/u.test(trimmed)) return false;
  if (isCaptionLine(trimmed)) return false;
  if (/[.!?]$/u.test(trimmed)) return false;
  const words = trimmed.split(/\s+/u);
  if (words.length === 0 || words.length > 4) return false;
  return words.every((word) => /^[\p{Lu}\d]/u.test(word) || /^(?:and|of|the|vs\.?)$/iu.test(word));
}

/**
 * True when a run of text holds at least two words of three or more letters.
 *
 * That is the cheapest test that separates a sentence from a formula, a legend key or an axis
 * tick. A single word is not enough for body text: `Retrieval` on a diagram's box is a label,
 * and it is handled as a label rather than as a paragraph.
 */
function hasWords(text: string): boolean {
  return (text.match(/\p{L}{3,}/gu) ?? []).length >= 2;
}

/** True when a run holds at least one real word, which is enough for a figure's box label. */
function hasWord(text: string): boolean {
  return (text.match(/\p{L}{3,}/gu) ?? []).length >= 1;
}

/**
 * True when a string is an axis tick, a unit, or a bare number — not a word a reader would
 * want translated. `0.5`, `10^2`, `kHz`, and a single letter stay on the drawing.
 */
export function isTick(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (/^\p{L}$/u.test(trimmed)) return true;
  if (/^[0-9eE.+,\-−–—×x^_()[\]%:\s/]+$/u.test(trimmed)) return true;
  const words = trimmed.match(/\p{L}{3,}/gu) ?? [];
  if (words.length === 0 && /^[\d\p{P}\p{S}\p{Zs}]+$/u.test(trimmed)) return true;
  return false;
}

/** A short unit written with a slash, e.g. `tok/s`, which is notation rather than a title. */
function isUnitLabel(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 12 || /\s/u.test(trimmed)) return false;
  return /^\p{L}+(?:\/\p{L}+)+$/u.test(trimmed);
}

/** The size most of the page's characters are set in, which is the body size. */
function bodySizeOf(lines: readonly TextLine[]): number {
  const weights = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.height * 2) / 2;
    weights.set(key, (weights.get(key) ?? 0) + line.text.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

export interface Region {
  lines: TextLine[];
  /** Horizontal extent this region's blocks may use. */
  room: Box;
  /** Reading column this region sits in, counted from the left of its parent region. */
  column: number;
  /** The gutter this region was cut at, when it came from a column split. */
  gutter?: number | undefined;
}

/** Recursive XY-cut, emitting regions in reading order. */
export function cutRegions(lines: readonly TextLine[], unit = 0): Region[] {
  if (lines.length === 0) return [];
  const size = unit > 0 ? unit : Math.max(1, median(lines.map((line) => line.height)));
  return cut(lines, size, { x: 0, y: 0, width: 0, height: 0 }, 0);
}

function cut(lines: readonly TextLine[], unit: number, room: Box, column: number): Region[] {
  if (lines.length <= 2) return [{ lines: [...lines], room: roomOf(lines, room), column }];
  // A table is not cut. Its widest empty band is the space between two of its columns, and
  // cutting there would read each of them as an independent column of half-cells.
  if (looksLikeTable(lines)) return [{ lines: [...lines], room: roomOf(lines, room), column }];

  const gutter = chooseGutter(lines, unit);
  if (gutter !== null) {
    const left = lines.filter((line) => boxRight(line.box) <= gutter.at + 0.5);
    const right = lines.filter((line) => line.box.x >= gutter.at - 0.5);
    const crossing = lines.filter((line) => !left.includes(line) && !right.includes(line));
    if (left.length > 0 && right.length > 0) {
      const leftRoom = boxTo(room, gutter.at, lines);
      const rightRoom = boxFrom(room, gutter.at, lines);
      // A line that crosses the gutter is a full-width title, caption or formula. It is cut
      // as its own region and read between the two columns at the height it occupies.
      return orderRegions(
        [
          ...cut(left, unit, leftRoom, column),
          ...cut(right, unit, rightRoom, column + 1),
          ...(crossing.length > 0 ? cut(crossing, unit, room, column) : []),
        ],
        gutter.at,
      );
    }
  }

  const rowGap = horizontalGaps(lines)[0];
  if (rowGap && rowGap.gap / unit >= MIN_ROW_GAP) {
    const above = lines.filter((line) => boxBottom(line.box) <= rowGap.at + 0.5);
    const below = lines.filter((line) => line.box.y >= rowGap.at - 0.5);
    const crossing = lines.filter((line) => !above.includes(line) && !below.includes(line));
    if (above.length > 0 && below.length > 0) {
      return orderRegions([
        ...cut(above, unit, room, column),
        ...cut(below, unit, room, column),
        ...(crossing.length > 0 ? cut(crossing, unit, room, column) : []),
      ]);
    }
  }

  return [{ lines: [...lines], room: roomOf(lines, room), column }];
}

/**
 * Picks the gutter to cut at, or null when the page is not divided into columns.
 *
 * A position supported by most rows wins. The support requirement is what separates a gutter
 * from the white space between a figure's labels: a real gutter holds for most of the page's
 * depth, while a label grid is a few rows of a page that is otherwise single-column.
 */
function chooseGutter(lines: readonly TextLine[], unit: number): { at: number } | null {
  const rows = groupByBaseline(lines).length;
  const candidates = gutterCandidates(lines, unit).filter(
    (candidate) =>
      candidate.width >= unit * MIN_GUTTER_WIDTH &&
      candidate.rows >= Math.max(2, rows * MIN_GUTTER_SUPPORT),
  );
  const best = candidates[0];
  if (!best) return null;
  return { at: best.at };
}

function boxTo(room: Box, at: number, lines: readonly TextLine[]): Box {
  const edge = room.width > 0 ? room.x : minLeft(lines);
  return { x: edge, y: room.y, width: Math.max(0, at - edge), height: room.height };
}

function boxFrom(room: Box, at: number, lines: readonly TextLine[]): Box {
  const edge = room.width > 0 ? room.x + room.width : maxRight(lines);
  return { x: at, y: room.y, width: Math.max(0, edge - at), height: room.height };
}

function minLeft(lines: readonly TextLine[]): number {
  let left = Infinity;
  for (const line of lines) left = Math.min(left, line.box.x);
  return Number.isFinite(left) ? left : 0;
}

function maxRight(lines: readonly TextLine[]): number {
  let right = 0;
  for (const line of lines) right = Math.max(right, boxRight(line.box));
  return right;
}

function roomOf(lines: readonly TextLine[], fallback: Box): Box {
  const box = unionBox(lines.map((line) => line.box));
  if (!box) return fallback;
  const left = fallback.width > 0 ? Math.min(fallback.x, box.x) : box.x;
  const right = fallback.width > 0 ? Math.max(boxRight(fallback), boxRight(box)) : boxRight(box);
  return { x: left, y: box.y, width: right - left, height: box.height };
}

/**
 * A region reads as a table when most of its rows hold two or more short cells, and those
 * cells repeat their horizontal extents from row to row.
 *
 * Two columns of prose fail the first test on length: a line of body text is a sentence, not
 * a value. A figure's axis labels fail the second: they are short, but each sits at its own
 * position and no row repeats the previous row's columns, because there is only one row.
 */
function looksLikeTable(lines: readonly TextLine[]): boolean {
  const rows = groupByBaseline(lines);
  if (rows.length < 2) return false;

  let wide = 0;
  const cellCounts: number[] = [];
  const secondXs: number[] = [];
  for (const row of rows) {
    // A justified body line is one TextLine whose word gaps can split it into many short
    // cells. A table row starts as several TextLines, one per cell. Counting the melted
    // line as table rows made every paragraph line its own painted block.
    if (row.length === 1 && cellText(row).length > CELL_MAX_CHARS) {
      cellCounts.push(1);
      continue;
    }
    const cells = splitRowCells(row, true, true);
    cellCounts.push(cells.length);
    if (cells.length < 2) continue;
    if (!cells.every((cell) => cellText(cell).length <= CELL_MAX_CHARS)) return false;
    const second = cells[1]?.[0];
    if (second) secondXs.push(second.box.x);
    wide += 1;
  }
  if (wide < Math.max(2, rows.length * TABLE_ROW_SHARE)) return false;
  if (median(cellCounts) > MAX_TABLE_CELLS) return false;
  // Justified words do not share a second-column x; a table's values do. One wrapped or
  // hyphenated row may sit off the grid without making the region stop being a table.
  if (secondXs.length >= 2) {
    const scale = Math.max(1, rows[0]?.[0]?.height ?? 10);
    const centre = median(secondXs);
    const aligned = secondXs.filter((x) => Math.abs(x - centre) <= scale * 3).length;
    if (aligned < Math.max(2, secondXs.length * TABLE_ROW_SHARE)) return false;
  }
  return true;
}

/** True when a split cell reads as a diagram label, not a sentence. */
function isDiagramLabelCell(cell: readonly TextLine[]): boolean {
  const text = cellText(cell).trim();
  if (text.length === 0) return true;
  if (text.length > 26) return false;
  if (/^Related\s+[Ww]ork\s*:/u.test(text)) return false;
  if (/[.!?]["'”’»)\]]*$/u.test(text) && hasWords(text)) return false;
  if (/^\p{Ll}{5,}$/u.test(text)) return false;
  if (/^\p{Lu}/u.test(text) && text.length > 4) return false;
  const words = text.match(/\p{L}{3,}/gu)?.length ?? 0;
  if (words >= 3) return false;
  return words <= 2;
}

/**
 * Joins the cells of one row that are really one run of text.
 *
 * A justified line can have word gaps wider than the cell threshold, and a bibliography row
 * can split into a label, authors and a quoted title. Treating each run as its own column
 * turned those words into separate blocks that could not fit their own translation. A
 * reference row is one entry, and a non-reference row whose next run starts lower-case or
 * with a value is a continuation of the sentence before it.
 */
function mergeRowCells(
  row: readonly TextLine[],
  cells: readonly TextLine[][],
  isTable: boolean,
  bodySize: number,
): TextLine[][] {
  if (isTable || cells.length <= 1) return cells.map((cell) => [...cell]);
  // A listing's line number and code run are already handled by the cell splitter; merging
  // them back into a sentence would fuse the listing with prose on the same baseline.
  if (hasListingLine(row)) return cells.map((cell) => [...cell]);
  const diagramRow =
    cells.length >= 4 &&
    cells.filter((cell) => isDiagramLabelCell(cell)).length >= Math.ceil(cells.length * 0.6);
  if (diagramRow) return cells.map((cell) => [...cell]);
  const bodyRow = isBodyFontRow(row, bodySize);
  const heights = row.map((line) => line.height);
  const uniformRow =
    heights.length > 0 &&
    Math.max(...heights) - Math.min(...heights) <= Math.max(...heights) * SIZE_CHANGE;
  // A row of short runs is a table header or a citation title. Its cells can be a column
  // apart and still be one line of the page, so a wide gap must not leave them as separate
  // blocks that then paint over each other.
  const shortRow = uniformRow && cells.every((cell) => cellText(cell).length <= CELL_MAX_CHARS);
  const cellBox = (cell: readonly TextLine[]) => unionBox(cell.map((line) => line.box));
  const merged: TextLine[][] = [];
  let reference = false;
  for (const cell of cells) {
    const previous = merged[merged.length - 1];
    const before = previous?.at(-1);
    const next = cell[0];
    if (next && isReferenceLine(next.text)) {
      // `[8]` at the end of a body line is an inline citation, not a bibliography entry.
      // A real entry in the next column starts after the gutter, so a small gap means the
      // marker belongs to the run before it.
      const scale = Math.max(before?.height ?? next.height, next.height, 1);
      const previousBox = previous ? cellBox(previous) : null;
      const nextBox = cellBox(cell);
      const gap =
        previousBox && nextBox ? nextBox.x - boxRight(previousBox) : Number.POSITIVE_INFINITY;
      if (previous && reference === false && gap <= scale * 2.5) {
        previous.push(...cell);
      } else {
        merged.push([...cell]);
        reference = true;
      }
      continue;
    }
    if (previous && before && next) {
      // Everything after a reference marker on this row belongs to that entry.
      if (reference) {
        previous.push(...cell);
        continue;
      }
      // A footnote or affiliation marker starts a new small block. Its wrapped tail is
      // lower case and merges normally, but the next dagger is a different affiliation.
      if (startsAffiliationEntry(before.text, next.text)) {
        merged.push([...cell]);
        continue;
      }
      const previousBox = previous ? cellBox(previous) : null;
      const nextBox = cellBox(cell);
      const gap =
        previousBox && nextBox ? nextBox.x - boxRight(previousBox) : Number.POSITIVE_INFINITY;
      const scale = Math.max(before.height, next.height, 1);
      const sentenceContinues = continuesProseText(before.text, next.text) && gap <= scale * 1.5;
      // A justified body line can lose every word boundary to the extractor. At body size
      // the runs are words of one line even when the next word is capitalised (`BANC's`).
      // A justified line and a citation title can lose their word gaps. A run on the same
      // baseline and at the same size, close enough to be a word space, is one line.
      // Two full lines on one baseline are usually two columns, even when the gutter is
      // narrow. A fragment is short; a column line is not.
      const shortSide =
        cellText(previous).length <= CELL_MAX_CHARS || cellText(cell).length <= CELL_MAX_CHARS;
      // A superscript or an inline formula directly abuts the prose around it. Its type is
      // smaller, so the size tests above miss it even though it is the same source line.
      const inline = shortSide && gap <= scale * 0.5;
      const wordFragments =
        (bodyRow && shortSide && gap <= scale * 1.5) ||
        (uniformRow && gap <= scale * 1.15) ||
        (shortRow && gap <= scale * 3);
      if (sentenceContinues || inline || wordFragments) {
        previous.push(...cell);
        continue;
      }
    }
    merged.push([...cell]);
  }
  return merged;
}

/** True when every run on a row is set at the page's body size. */
function isBodyFontRow(lines: readonly TextLine[], bodySize: number): boolean {
  if (bodySize <= 0 || lines.length === 0) return false;
  return lines.every((line) => Math.abs(line.height - bodySize) <= bodySize * SIZE_CHANGE);
}

/** True when the next run starts a clause of the same sentence rather than a new one. */
function continuesProseText(previous: string, next: string): boolean {
  if (endsSentence(previous)) return false;
  const trimmed = next.trimStart();
  if (trimmed.length === 0) return false;
  if (isNumericCell(trimmed) || isNumericCell(previous.trim())) return false;
  if (isBylineLabel(trimmed) || isBylineLabel(previous.trim())) return false;
  if (trimmed.length < 8 && previous.trim().length < 50) return false;
  // A lower-case word, a number or leading punctuation continues the previous run. An
  // upper-case word may be a proper noun inside the sentence, but it is also how a new
  // column or a table header starts, so it is left as a boundary.
  return /^[\p{Ll}\d,;:.…)\]}]/u.test(trimmed);
}

/** True when any line is a program listing rather than prose. */
function hasListingLine(lines: readonly TextLine[]): boolean {
  return lines.some(
    (line) =>
      isMostlyMono(line) || looksLikeCodeLine(line.text) || looksLikeCodeContinuation(line.text),
  );
}

function cellText(cell: readonly TextLine[]): string {
  return cell
    .map((line) => line.text)
    .join(' ')
    .trim();
}

/** Splits one row where a gap is wider than a word space. */
function splitRowCells(row: readonly TextLine[], tight = false, probe = false): TextLine[][] {
  const cells: TextLine[][] = [];
  let current: TextLine[] = [];

  for (const line of splitLinesOnCellGaps(row, tight, probe)) {
    const previous = current[current.length - 1];
    if (previous) {
      const gap = line.box.x - boxRight(previous.box);
      // A wider gap splits the row, but only when the run that would be cut away is a
      // substantial piece of text. A section heading is set with its number apart from its
      // title — `I.` then `INTRODUCTION` — and cutting there leaves the number as a block of
      // its own, translated as a bare numeral.
      //
      // The cut is also refused when the two runs read as one sentence: a run-in heading is
      // set a full em from the text it introduces — `Attention variants` then `The rest of
      // this section …` — and that gap is wide enough to look like a column boundary. Cutting
      // there produced two blocks starting at the same y, each claiming the column's measure,
      // which reads as two sentences printed over each other. A real boundary leaves a whole
      // word on each side and the right-hand run starts a sentence or a value rather than
      // continuing a clause.
      const scale = Math.max(previous.height, line.height);
      const bothShort =
        previous.text.trim().length <= CELL_MAX_CHARS && line.text.trim().length <= CELL_MAX_CHARS;
      const minGap = cellMinGap(scale, tight, bothShort);
      const glueShort = !probe && previous.text.trim().length <= 3 && gap <= scale * 1.5;
      const splits = gap > minGap && !startsRunIn(line) && !glueShort;
      if (splits) {
        cells.push(current);
        current = [line];
        continue;
      }
    }
    current.push(line);
  }
  if (current.length > 0) cells.push(current);
  return cells;
}

function cellMinGap(scale: number, tight: boolean, bothShort: boolean): number {
  return tight && bothShort ? CELL_SPLIT_GAP * scale : SEGMENT_GAP * scale;
}

/**
 * A table's cell padding is often narrower than a word-space, so two short runs on one
 * baseline can still be one `TextLine`. Split those runs into their own lines so a number
 * does not glue onto the identifier beside it. Only a table uses the narrow gap: justified
 * body text sits around 0.62em and must stay one line.
 */
function splitLinesOnCellGaps(row: readonly TextLine[], tight: boolean, probe = false): TextLine[] {
  if (!tight) return [...row];
  const out: TextLine[] = [];
  for (const line of row) {
    if (line.pieces.length <= 1) {
      out.push(line);
      continue;
    }
    const groups: (typeof line.pieces)[] = [];
    let current: typeof line.pieces = [];
    for (const piece of line.pieces) {
      const previous = current[current.length - 1];
      if (previous) {
        const gap = piece.box.x - boxRight(previous.box);
        const scale = Math.max(
          previous.size || previous.box.height,
          piece.size || piece.box.height,
          1,
        );
        const bothShort =
          previous.text.trim().length <= CELL_MAX_CHARS &&
          piece.text.trim().length <= CELL_MAX_CHARS;
        const minGap = cellMinGap(scale, true, bothShort);
        const glueShort = !probe && previous.text.trim().length <= 3 && gap <= scale * 1.5;
        if (gap > minGap && !glueShort) {
          groups.push(current);
          current = [piece];
          continue;
        }
      }
      current.push(piece);
    }
    if (current.length > 0) groups.push(current);
    if (groups.length <= 1) {
      out.push(line);
      continue;
    }
    for (const group of groups) {
      if (group.length > 0) out.push(lineFrom(group));
    }
  }
  return out;
}

/**
 * True when a run that begins a new cell reads as the continuation of the line it follows.
 *
 * A run-in heading is followed by prose that starts in lower case, or with punctuation that
 * opens a clause: `Attention variants` then `The rest of this section …` is one sentence with
 * a bold opening. A table's next column starts with a value or a capital, and a two-column
 * layout's right-hand column starts a fresh sentence. The distinction is deliberately narrow:
 * it only prevents a cut, never forces one.
 */
function startsRunIn(line: TextLine): boolean {
  const text = line.text.trimStart();
  if (text.length === 0) return false;
  // A clause that opens with punctuation cannot start a column or a cell of its own:
  // `, value vector v …`, `) ,`, `(αt )`.
  if (/^[,;:.…)\]}]/u.test(text)) return true;
  return false;
}

/**
 * Regions in reading order.
 *
 * The column number decides first, because a two-column page is read down the left column and
 * then down the right one — not by whichever line happens to sit higher. A line that crosses
 * the gutter keeps its parent's column number, so it lands in the left run at the height
 * where it actually sits, which is where a full-width caption belongs. Within one column the
 * order is the page's: top to bottom.
 */
function orderRegions(regions: Region[], gutter?: number): Region[] {
  const marked = gutter === undefined ? regions : regions.map((region) => ({ ...region, gutter }));
  return [...marked].sort((left, right) => {
    if (left.column !== right.column) return left.column - right.column;
    return topOf(left.lines) - topOf(right.lines);
  });
}

function topOf(lines: readonly TextLine[]): number {
  let top = Infinity;
  for (const line of lines) top = Math.min(top, line.box.y);
  return Number.isFinite(top) ? top : 0;
}

/** One cell of one row, with whether its row held more than one of them. */
interface RegionCell {
  lines: TextLine[];
  row: number;
  /** The row held more than one cell, so this is a table cell rather than a line of prose. */
  shared: boolean;
  /** A body-size row whose word fragments were joined; the resulting line is prose. */
  fragments?: boolean | undefined;
}

function appendRegionBlocks(
  region: Region,
  bodySize: number,
  out: LayoutBlock[],
  figures: FigureAreas,
  pageHeight = 0,
  pageIndex = 0,
): void {
  const rows = groupBaselineRows(region.lines);
  if (rows.length === 0) return;

  const emit = (
    lines: readonly TextLine[],
    room: Box,
    column: number,
    columnLeft: number,
    fragments = false,
  ) => {
    for (const run of splitAtFigures(lines, figures)) {
      const block = buildBlock(
        run,
        room,
        column,
        bodySize,
        figures,
        columnLeft,
        pageHeight,
        pageIndex,
      );
      if (!block) continue;
      out.push(fragments && block.role === 'label' ? { ...block, role: 'prose' } : block);
    }
  };

  // A caption sitting on top of a table is not a cell of that table. Peel it off before
  // the region is read as rows of values, otherwise `Figure 1: …` joins the first header.
  const { captions, rest } = peelLeadingCaptions(rows);
  for (const caption of captions) {
    emit(caption, region.room, region.column, minLeft(caption));
  }

  // A region the cut recognised as a table keeps every cell apart; a region of prose only
  // re-splits rows so that two things side by side do not get read as one line.
  const isTable = looksLikeTable(rest.flat());
  const cells: RegionCell[] = [];
  let reference: RegionCell | null = null;
  for (const [index, row] of rest.entries()) {
    // A bibliography's wrapped lines are one entry, not one row each. Join them before the
    // cells are clustered into columns: a short `[1]` line may not overlap its own hanging
    // indent enough to be recognised as the same column afterwards.
    const first = row[0];
    if (!isTable && reference && first && continuesReferenceEntry(reference.lines, first)) {
      reference.lines.push(...row);
      continue;
    }
    const splitCells = splitRowCells(row, isTable);
    const rowCells = mergeRowCells(row, splitCells, isTable, bodySize);
    const fragments =
      !isTable && rowCells.length < splitCells.length && isBodyFontRow(row, bodySize);
    for (const cell of rowCells) {
      const entry: RegionCell = {
        lines: cell,
        row: index,
        shared: isTable && rowCells.length > 1,
        ...(fragments ? { fragments: true } : {}),
      };
      cells.push(entry);
      if (!isTable && cell[0] && isReferenceLine(cell[0].text)) reference = entry;
      else if (!isTable) reference = null;
    }
  }

  for (const column of clusterColumns(cells)) {
    const leading = columnLeading(column.cells);
    const room = clipToColumn(column.room, region.gutter ?? null);
    // The column's own left edge, which is what an indented line is measured from. It has to
    // be the edge most of the column's lines start at, not the block's own left: a block that
    // is nothing but a centred formula starts at its own left by definition.
    const columnLeft = columnLeftEdge(column.cells);
    let current: TextLine[] = [];
    let currentFragments = false;
    // Backstop for a column whose paragraph gaps were missed: measure the cumulative prose
    // up to the last completed sentence, not just whether the previous line happened to end
    // one. Split at that sentence boundary so the remainder can still become its own block.
    const splitLongProse = () => {
      if (isTable || current.length === 0 || isReferenceEntry(current) || hasListingLine(current)) {
        return;
      }
      for (;;) {
        const split = overlongProseSplit(current);
        if (!split) return;
        emit(split.head, room, region.column, columnLeft, currentFragments);
        current = split.tail;
      }
    };

    for (const cell of column.cells) {
      const next = cell.lines[0];
      const previous = current[current.length - 1];
      // A superscript can be the last fragment on a row. Measure the gap from the line that
      // carries the row's text, not from a two-character marker above the baseline.
      const gapPrevious = dominantLastLine(current) ?? previous;
      // A table cell always starts a block: its row ends there, so the next row's value in the
      // same column is a different thing however evenly the rows are pitched. A hyphenated
      // wrap (`maxSegmentTo-` then `kens`) is the one continuation that must stay in the cell.
      const hyphenWrap =
        previous !== undefined && next !== undefined && isHyphenWrap(previous, next);
      const nextStartsReference = !isTable && next !== undefined && isReferenceLine(next.text);
      const referenceContinues =
        !isTable &&
        next !== undefined &&
        current.length > 0 &&
        continuesReferenceEntry(current, next);
      const starts = isTable
        ? previous !== undefined && !hyphenWrap
        : Boolean(
            previous &&
            next &&
            (nextStartsReference ||
              (!referenceContinues &&
                (gapStartsBlock(gapPrevious ?? previous, next, leading, columnLeft) ||
                  isListBoundary(gapPrevious ?? previous, next)))),
          );
      if (previous && next && starts) {
        splitLongProse();
        emit(current, room, region.column, columnLeft, currentFragments);
        current = [];
        currentFragments = false;
      }
      if (cell.fragments === true) currentFragments = true;
      current.push(...cell.lines);
    }

    splitLongProse();
    emit(current, room, region.column, columnLeft, currentFragments);
  }
}

/**
 * True when `row` is a wrapped caption line, not a table row sitting below the caption.
 */
function continuesCaptionWrap(caption: readonly TextLine[], row: readonly TextLine[]): boolean {
  if (caption.length === 0 || row.length === 0) return false;
  const last = caption.reduce((left, right) => (right.baseline > left.baseline ? right : left));
  const first = row.reduce((left, right) => (right.box.x < left.box.x ? right : left));
  const em = Math.max(last.height, first.height, 1);
  const gap = first.baseline - last.baseline;
  if (gap <= em * 0.35 || gap > em * 2.5) return false;
  const captionLeft = Math.min(...caption.map((line) => line.box.x));
  const inset = first.box.x - captionLeft;
  return inset >= -em * 0.25 && inset <= em * PARAGRAPH_INDENT_MAX_EM;
}

/**
 * Pulls numbered captions off the top of a region so they are not read as the first row of
 * the table they sit above.
 */
function peelLeadingCaptions(rows: readonly TextLine[][]): {
  captions: TextLine[][];
  rest: TextLine[][];
} {
  if (rows.length === 0) return { captions: [], rest: [] };
  const captions: TextLine[][] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (!row) break;
    const text = cellText(row);
    const cells = splitRowCells(row);
    if (index === 0 && isCaptionLine(text)) {
      captions.push(row);
      index += 1;
      continue;
    }
    const captionLines = captions[captions.length - 1];
    if (
      captionLines &&
      cells.length < 2 &&
      !isTableHeaderLine(text) &&
      !isCaptionLine(text) &&
      (text.length > 24 || /^[\p{Ll}]/u.test(text)) &&
      continuesCaptionWrap(captionLines, row)
    ) {
      // A wrapped caption stays one caption, not one caption block per line.
      captionLines.push(...row);
      index += 1;
      continue;
    }
    break;
  }
  return { captions, rest: [...rows.slice(index)] };
}

function groupBaselineRows(lines: readonly TextLine[]): TextLine[][] {
  return groupByBaseline(lines).map((row) =>
    [...row].sort((left, right) => left.box.x - right.box.x),
  );
}

/**
 * Groups cells into columns that run down the region, in left-to-right order.
 *
 * A cell joins the column it overlaps most. That is what a table needs: the cells of one
 * column share their horizontal extent, and a value in the next column shares nothing with
 * them, so a row's numbers never end up in its labels. It is also what a paragraph needs: its
 * last line is short but starts where the paragraph starts, so it overlaps its own column
 * fully and joins it rather than becoming a block of one short line.
 *
 * A column's extent is the median of its cells, not the union. A centred heading is one wide
 * cell in a column of full lines, and letting it set the width drew the heading across the
 * gutter and over the paragraph in the next column.
 */
function clusterColumns(cells: readonly RegionCell[]): { cells: RegionCell[]; room: Box }[] {
  const columns: { cells: RegionCell[]; lefts: number[]; rights: number[] }[] = [];

  for (const cell of cells) {
    const box = unionBox(cell.lines.map((line) => line.box));
    if (!box) continue;

    let best: (typeof columns)[number] | null = null;
    let bestOverlap = 0;
    const first = cell.lines[0];
    for (const column of columns) {
      const left = median(column.lefts);
      const right = median(column.rights);
      const shared = Math.min(right, boxRight(box)) - Math.max(left, box.x);
      const last = column.cells.at(-1)?.lines.at(-1);
      const hyphenJoin = first !== undefined && last !== undefined && isHyphenWrap(last, first);
      if (shared <= 0 && !hyphenJoin) continue;
      const narrower = Math.min(right - left, box.width);
      const ratio = narrower > 0 ? shared / narrower : 0;
      if (hyphenJoin && (ratio > bestOverlap || best === null)) {
        best = column;
        bestOverlap = Math.max(ratio, MIN_COLUMN_OVERLAP);
        continue;
      }
      if (ratio >= MIN_COLUMN_OVERLAP && ratio > bestOverlap) {
        best = column;
        bestOverlap = ratio;
      }
    }

    if (best) {
      best.cells.push(cell);
      best.lefts.push(box.x);
      best.rights.push(boxRight(box));
      continue;
    }
    columns.push({ cells: [cell], lefts: [box.x], rights: [boxRight(box)] });
  }

  return columns
    .sort((left, right) => median(left.lefts) - median(right.lefts))
    .map((column) => {
      const left = median(column.lefts);
      // The width is the widest a typical cell reaches, not the union of every cell: a heading
      // that happens to be centred over the whole page must not widen the column under it.
      // The widest is taken as the 75th percentile rather than the median, so a column of
      // paragraphs whose last lines are short still keeps its full measure.
      const right = percentile(column.rights, 0.75);
      return {
        cells: [...column.cells].sort((left, right) => left.row - right.row),
        room: { x: left, y: 0, width: Math.max(1, right - left), height: 0 },
      };
    });
}

/** The value below which this share of the samples falls. */
function percentile(values: readonly number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * share));
  return sorted[index] ?? 0;
}

/**
 * A cell whose box sits over a gutter belongs to the column it starts in, and its box is cut
 * at the gutter so the translation is too.
 *
 * A run-in note — `Unlike left-to-right language models…` set beside a paragraph — begins in
 * one column and runs into the next. Its box then covers part of both, and the translated
 * version, which is longer still, lands on the other column's text. Cutting the box at the
 * gutter keeps the note where the reader saw it started.
 */
function clipToColumn(room: Box, gutter: number | null): Box {
  if (gutter === null) return room;
  // A column that starts at or after the gutter is the right-hand one and needs no cut.
  if (room.x >= gutter - 0.5) return room;
  if (room.x + room.width <= gutter + 0.5) return room;
  return { ...room, width: Math.max(1, gutter - room.x - GUTTER_CLEARANCE / 2) };
}

/** The column's own leading, as a multiple of its font size. */
/**
 * The x most of a column's lines start at, which is the measure a formula is set in from.
 *
 * The mode rather than the minimum: a paper's column is a wall of lines at one x, and the
 * handful that start further right are indented paragraphs, list items and centred formulas.
 * Using the minimum would take the leftmost of those and call every line indented.
 */
function columnLeftEdge(cells: readonly RegionCell[]): number {
  const counts = new Map<number, number>();
  for (const cell of cells) {
    for (const line of cell.lines) {
      const key = Math.round(line.box.x * 2) / 2;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestCount = -1;
  for (const [x, count] of counts) {
    if (count > bestCount) {
      best = x;
      bestCount = count;
    }
  }
  return Number.isFinite(best) ? best : minLeft(cells.flatMap((cell) => cell.lines));
}

function columnLeading(cells: readonly RegionCell[]): number {
  const ratios: number[] = [];
  for (let index = 1; index < cells.length; index += 1) {
    const before = cells[index - 1]?.lines.at(-1);
    const after = cells[index]?.lines[0];
    if (!before || !after) continue;
    const gap = after.baseline - before.baseline;
    if (gap <= 0) continue;
    const ratio = gap / Math.max(after.height, 1);
    // Paragraph gaps are several times the leading. Including them in the median raised the
    // column's own leading until no gap could ever exceed it, fusing every paragraph.
    if (ratio > 2.5) continue;
    ratios.push(ratio);
  }
  return ratios.length > 0 ? median(ratios) : 1.35;
}

/** The line carrying the most text in the last baseline row of a run. */
function dominantLastLine(lines: readonly TextLine[]): TextLine | undefined {
  const last = lines[lines.length - 1];
  if (!last) return undefined;
  let best = last;
  for (const line of lines) {
    if (Math.abs(line.baseline - last.baseline) > Math.max(line.height, last.height) * 0.7 + 0.6) {
      continue;
    }
    if (line.text.trim().length > best.text.trim().length) best = line;
  }
  return best;
}

/**
 * True when the line cannot be a continuation of the previous one: the baseline jumped by
 * more than the column's own leading allows, the type size changed, the weight changed, the
 * line is indented after a completed sentence, or one of the two is an equation.
 *
 * The equation case is what keeps a formula out of the paragraph that introduces it. A
 * display equation is often set on the same pitch as the text around it, so the leading test
 * joins it to the sentence above and the whole block is then either translated as prose —
 * which replaces typeset mathematics with a paragraph — or left alone, taking the sentence
 * with it. A change from text to math is always a block boundary.
 */
function gapStartsBlock(
  previous: TextLine,
  line: TextLine,
  leading: number,
  columnLeft: number,
): boolean {
  if (isCaptionLine(previous.text)) return true;
  const scale = Math.max(line.height, previous.height, 1);
  const gap = (line.baseline - previous.baseline) / scale;
  // Wrapped pseudocode (`devEval = … by a` / `developer;`) must stay one listing. Splitting
  // at the wrap left a one-word line that was translated while the rest stayed code.
  if (gap <= leading * PARAGRAPH_RATIO * 1.8 && codeListingContinues(previous.text, line.text)) {
    return false;
  }
  // A gap this wide is a paragraph break whatever the column's median leading says. This is
  // the backstop for a column whose leading samples were still polluted by the paragraph gaps.
  if (gap > 2.8) return true;
  // `leading` is measured from this column's own cells, so the paragraph rule compares like
  // with like instead of using a page-wide pitch that could never be exceeded.
  if (gap > leading * PARAGRAPH_RATIO) return true;
  if (gap < -0.7) return true;

  const previousMath = previous.mathRatio >= EQUATION_LINE_SHARE;
  const lineMath = line.mathRatio >= EQUATION_LINE_SHARE;
  // A superscript or an inline formula is on the same baseline as the prose around it.
  // Only a line change can be the boundary between prose and a display equation.
  if (Math.abs(gap) >= 0.4 && previousMath !== lineMath) return true;
  const monoRun = isMostlyMono(previous) && isMostlyMono(line);
  // Indent-only paragraph typesetting does this: the previous line sits on the column wall and
  // ends a sentence, then the next paragraph starts one or two ems in. That is a paragraph
  // break even when the leading is the same as a wrapped line. A hanging reference or list
  // continuation is indented the same way and stays in its block.
  const em = Math.max(line.height, previous.height, 1);
  // A numeric table value followed by text shifted right is the next cell of the row, not a
  // continuation of the number. Without this, the wrapped tail of the neighbouring cell joined
  // the number into one block that overlapped both cells.
  if (
    isNumericCell(previous.text) &&
    line.baseline - previous.baseline > em * 0.5 &&
    line.box.x > previous.box.x + em * 1.5
  ) {
    return true;
  }
  const stepIn = line.box.x - columnLeft;
  if (
    !monoRun &&
    stepIn > em * PARAGRAPH_INDENT_MIN_EM &&
    stepIn < em * PARAGRAPH_INDENT_MAX_EM &&
    endsSentence(previous.text) &&
    !isReferenceLine(previous.text) &&
    !isReferenceContinuation(previous, line, columnLeft) &&
    !isListItemStart(previous.text)
  ) {
    return true;
  }
  // A formula whose function names are set in the text face does not reach the math share, so
  // the boundary is also drawn where a line is indented away from the column's left edge and
  // its predecessor was not: typesetting centres a display equation, and a paragraph does not
  // start in the middle of its column.
  // Display formulas sit several ems in from the column, beyond the paragraph-indent band.
  // A monospaced listing indents continuation lines too; those must stay code.
  const indent = Math.max(previous.height, line.height) * 3;
  // A line that starts far right is a centred formula only when it reads like one. A long
  // prose line can start mid-column after an inline formula was extracted as its own piece;
  // treating that as a display formula cut the paragraph at every superscript.
  const centred = (value: TextLine): boolean =>
    value.mathRatio >= 0.2 || value.text.trim().length <= 24;
  if (!monoRun && centred(line) && line.box.x > previous.box.x + indent) return true;
  // The reverse: a centred formula is followed by a line that returns to the column wall.
  // Without this, the sentence under the formula joined it and the whole block was then
  // either translated (replacing the mathematics) or skipped (taking the sentence with it).
  if (!monoRun && centred(previous) && previous.box.x > line.box.x + indent) return true;

  // A superscript on one piece makes `line.height` larger than the type the line is set in.
  // Comparing the dominant sizes keeps a formula from cutting the paragraph around it.
  const previousSize = textSize(previous);
  const lineSizeValue = textSize(line);
  const sizeChange = Math.abs(lineSizeValue - previousSize) / Math.max(previousSize, 1);
  if (sizeChange > SIZE_CHANGE) return true;

  // Weight changes do not split a block. A run-in heading is bold only on its opening
  // words, on the same line as the sentence it introduces; cutting there left a heading, a
  // label and a prose fragment, and one of those lines had no cover.

  // A numbered caption followed by a table header is two blocks, even when the leading
  // between them is no wider than a wrapped line.
  if (isCaptionLine(previous.text) && isTableHeaderLine(line.text)) return true;
  if (isListBoundary(previous, line)) return true;
  if (isStandaloneSectionHeading(previous.text) || isStandaloneSectionHeading(line.text)) {
    return true;
  }
  if (isBylineLabel(previous.text) || isBylineLabel(line.text)) return true;
  if (startsAffiliationEntry(previous.text, line.text)) return true;
  if (isKeywordLine(line.text) && !isKeywordLine(previous.text)) return true;

  return false;
}

/**
 * Splits a prose block when display-equation lines sit between its lines but landed in another
 * region — prose in one column can then jump across a centred formula without `gapStartsBlock`
 * seeing the equation row.
 */
function splitProseAcrossObstacles(
  blocks: readonly LayoutBlock[],
  allLines: readonly TextLine[],
  bodySize: number,
  figures: FigureAreas,
  pageHeight: number,
  pageIndex: number,
): LayoutBlock[] {
  const out: LayoutBlock[] = [];
  for (const block of blocks) {
    if (block.role === 'equation' || block.lines.length < 2) {
      out.push(block);
      continue;
    }
    const sorted = [...block.lines].sort((a, b) => a.baseline - b.baseline || a.box.x - b.box.x);
    const groups: TextLine[][] = [];
    let current: TextLine[] = [];
    for (let index = 0; index < sorted.length; index += 1) {
      const line = sorted[index];
      if (!line) continue;
      const previous = current[current.length - 1];
      if (
        previous &&
        proseObstacleBetween(previous, line, allLines, Math.min(previous.box.x, line.box.x))
      ) {
        if (current.length > 0) groups.push(current);
        current = [line];
        continue;
      }
      current.push(line);
    }
    if (current.length > 0) groups.push(current);
    if (groups.length <= 1) {
      out.push(block);
      continue;
    }
    for (const group of groups) {
      const rebuilt = buildBlock(
        group,
        block.room,
        block.column,
        bodySize,
        figures,
        block.box.x,
        pageHeight,
        pageIndex,
      );
      if (rebuilt) out.push(rebuilt);
    }
  }
  return out;
}

function proseObstacleBetween(
  previous: TextLine,
  line: TextLine,
  allLines: readonly TextLine[],
  columnLeft: number,
): boolean {
  const top = previous.baseline;
  const foot = line.baseline;
  const left = Math.min(previous.box.x, line.box.x);
  const right = Math.max(boxRight(previous.box), boxRight(line.box));
  for (const between of allLines) {
    if (between === previous || between === line) continue;
    if (between.baseline <= top + 0.35) continue;
    if (between.baseline >= foot - 0.35) continue;
    if (boxRight(between.box) < left + 6 || between.box.x > right - 6) continue;
    if (between.mathRatio >= EQUATION_LINE_SHARE) return true;
    if (isEquation([between], columnLeft)) return true;
    if (/^\(\d+\)$/u.test(between.text.trim())) return true;
    if (/^(?:Precision|Recall)\s*=/iu.test(between.text.trim())) return true;
  }
  return false;
}

function obstacleBetweenBlocks(
  left: LayoutBlock,
  right: LayoutBlock,
  allLines: readonly TextLine[],
): boolean {
  const tail = left.lines[left.lines.length - 1];
  const head = right.lines[0];
  if (!tail || !head) return false;
  const columnLeft = Math.min(left.box.x, right.box.x);
  return proseObstacleBetween(tail, head, allLines, columnLeft);
}

/** Font size most of a line's characters are set in, ignoring a lone superscript. */
function textSize(line: TextLine): number {
  const weights = new Map<number, number>();
  for (const piece of line.pieces) {
    if (piece.text.trim().length === 0) continue;
    const size = Math.round(piece.size * 2) / 2;
    weights.set(size, (weights.get(size) ?? 0) + piece.text.length);
  }
  let best = line.height;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

/** True when the text closes a sentence, with optional closing quotes or brackets after it. */
function endsSentence(text: string): boolean {
  return /[.!?:]["'”’»)\]]*$/u.test(text.trim());
}

/** A keywords / index-terms line belongs to the abstract's metadata, not to its prose. */
function isKeywordLine(text: string): boolean {
  return /^(?:key\s*words?|index\s+terms|ccs\s+concepts)\b/iu.test(text.trim());
}

/** A bibliography entry or numbered reference, whose continuation is a hanging indent. */
function isReferenceLine(text: string): boolean {
  return /^\s*\[\d+\](?=\s|$)/u.test(text);
}

/** A footnote or affiliation entry starts with a dagger, an asterisk or an email label. */
function isAffiliationLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (isAffiliationMarker(trimmed)) return true;
  return /^(?:the authors? (?:are|is) with|e-?mail(?:\s+address)?\s*:|corresponding author\b)/iu.test(
    trimmed,
  );
}

/** A dagger or star that marks a footnote, without the text it introduces. */
function isAffiliationMarker(text: string): boolean {
  return /^\s*[\u2020\u2021\u2217\u22C6\u22C7\u2731*]/u.test(text);
}

/** True when `line` opens a new affiliation entry rather than continuing the previous one. */
function startsAffiliationEntry(previous: string, line: string): boolean {
  if (!isAffiliationLine(line)) return false;
  if (isAffiliationMarker(line)) return !isAffiliationMarker(previous);
  return !isAffiliationLine(previous);
}

/** True when a run of lines starts a numbered bibliography entry. */
function isReferenceEntry(lines: readonly TextLine[]): boolean {
  return lines.length > 0 && isReferenceLine(lines[0]?.text ?? '');
}

/** Two lines at the same hanging indent keep a reference entry's wrapped tail together. */
function isReferenceContinuation(previous: TextLine, line: TextLine, columnLeft: number): boolean {
  if (isReferenceLine(line.text)) return false;
  const em = Math.max(previous.height, line.height, 1);
  const lineInset = line.box.x - columnLeft;
  if (lineInset < em * PARAGRAPH_INDENT_MIN_EM) return false;
  // The entry's first line sits on the column wall; its wrapped tail is the hanging indent.
  // A later continuation can drift a little from the line before it, so the tolerance is
  // wider than a word space but still much narrower than a new paragraph's indent.
  if (isReferenceLine(previous.text)) return true;
  const previousInset = previous.box.x - columnLeft;
  if (previousInset < em * PARAGRAPH_INDENT_MIN_EM) return false;
  return Math.abs(previous.box.x - line.box.x) <= em * 1.5;
}

/**
 * True when `line` wraps the bibliography entry whose lines are already in `entry`.
 *
 * The entry starts with `[n]`; every continuation is indented from that first line and hugs
 * the previous line horizontally. Comparing with the entry's first line rather than only its
 * immediate predecessor keeps a long entry together when one wrapped line is set a point or
 * two off the hanging indent.
 */
function continuesReferenceEntry(entry: readonly TextLine[], line: TextLine): boolean {
  const first = entry[0];
  if (!first || !isReferenceLine(first.text) || isReferenceLine(line.text)) return false;
  const previous = entry[entry.length - 1];
  if (!previous) return false;
  const em = Math.max(first.height, previous.height, line.height, 1);
  if (line.baseline <= previous.baseline) return false;
  if ((line.baseline - previous.baseline) / em > 2.2) return false;
  // A reference's wrapped tail is indented from its `[n]`; line breaks may drift between
  // the hanging indent and the right margin, so only the first line sets the anchor.
  return line.box.x > first.box.x + em * PARAGRAPH_INDENT_MIN_EM;
}

function isListBoundary(previous: TextLine, line: TextLine): boolean {
  if (isListItemStart(line.text) && previous.text.trim().length > 0) return true;
  const previousBold = previous.pieces.length > 0 && previous.pieces.every((piece) => piece.bold);
  const lineBold = line.pieces.length > 0 && line.pieces.every((piece) => piece.bold);
  const scale = Math.max(previous.height, line.height, 1);
  const gap = (line.baseline - previous.baseline) / scale;
  // A bold run-in on the same line as body text is one paragraph. Only a following line
  // that is bold in every piece starts the next list item.
  if (gap <= 0.4) return false;
  return /[.!?]$/u.test(previous.text.trim()) && lineBold && !previousBold;
}

function isListItemStart(text: string): boolean {
  return /^(?:[\u2022\u2023\u25E6\u2043•·‣▪◦●○*]|[-–—]|\d+[.)]|[a-z][.)])\s/u.test(text.trim());
}

function isHyphenWrap(previous: TextLine, next: TextLine): boolean {
  return /[\u002d\u2010\u2011]$/u.test(previous.text.trim()) && /^[\p{Ll}]/u.test(next.text.trim());
}

function isMostlyMono(line: TextLine): boolean {
  if (line.pieces.length === 0) return false;
  const mono = line.pieces.filter((piece) => piece.family === 'monospace').length;
  return mono * 2 >= line.pieces.length;
}

/**
 * A code identifier rather than a phrase: camelCase, snake_case, or a hyphen-broken token
 * from a wrapped cell. Translating one of these produces a wrong program.
 */
export function isCodeToken(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3 || /\s/u.test(trimmed)) return false;
  if (/^(?:[-–—]|[\u002d\u2010\u2011])+$/u.test(trimmed)) return false;
  // An internal capital after a lowercase run: `pieceChars`, `maxSegmentTokens`.
  // All-caps section titles (`ABSTRACT`) must not match: they have no lowercase letters.
  if (/^[A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/u.test(trimmed) && /[a-z]/u.test(trimmed)) return true;
  if (/^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/u.test(trimmed)) return true;
  if (/^[A-Za-z][A-Za-z0-9]*[\u002d\u2010\u2011][A-Za-z][A-Za-z0-9]*$/u.test(trimmed)) return true;
  if (/^[A-Za-z][A-Za-z0-9]*[\u002d\u2010\u2011]$/u.test(trimmed)) return true;
  return false;
}

/** A table value that must stay as drawn: `48`, `1.9 s`, `34.8`. */
export function isNumericCell(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (isTick(trimmed)) return true;
  return /^[\d.,]+(?:\s*(?:s|ms|µs|us|ns|%|pt|px|tok\/s))?$/iu.test(trimmed);
}

/**
 * True when a run is a row of values and legend keys rather than prose: axis ticks, a table
 * row, or a line such as `TS 0.87 0.62 0.58 0.74`.
 *
 * Each token must be a number, a one- or two-letter variable, or a short acronym. A single
 * long word makes the run prose, which keeps a sentence that happens to contain numbers out.
 */
export function isNumericRow(text: string): boolean {
  const tokens = text
    .trim()
    .split(/\s+/u)
    .map((token) => token.replace(/^[^\p{L}\p{N}+−-]+|[^\p{L}\p{N}+−-]+$/gu, ''))
    .filter((token) => token.length > 0);
  if (tokens.length < 2) return false;
  let values = 0;
  let labels = 0;
  for (const token of tokens) {
    if (/^[+−-]$/u.test(token)) {
      values += 1;
      continue;
    }
    if (/\d/u.test(token) && !/\p{L}{3,}/u.test(token)) {
      values += 1;
      continue;
    }
    if (/^\p{L}{1,2}$/u.test(token) || /^\p{Lu}{2,4}$/u.test(token)) {
      values += 1;
      continue;
    }
    // A compact notation token such as `N/A` belongs to the row; one natural-language label
    // is allowed so a table's setting name does not make the row look like a sentence.
    if (/^\p{Lu}[\p{Lu}\p{N}./-]*$/u.test(token) && token.length <= 6) {
      values += 1;
      continue;
    }
    labels += 1;
    if (labels > 1) return false;
  }
  return values >= (labels > 0 ? 3 : 2);
}

/**
 * Splits a run where it crosses a figure's painted area.
 *
 * A paragraph can begin outside a drawing and continue into it, or a caption can sit under a
 * figure while the line above it is part of the artwork. Classifying the whole run by voting
 * either paints the drawing's labels or leaves the exterior sentence untranslated. Splitting
 * at the boundary gives each side the role it actually has.
 */
function splitAtFigures(lines: readonly TextLine[], figures: FigureAreas): TextLine[][] {
  if (figures.images.length === 0 || lines.length < 2) return [[...lines]];
  const groups: TextLine[][] = [];
  let current: TextLine[] = [];
  let previousInside: boolean | null = null;
  let previous: TextLine | undefined;
  let carryProse = false;
  for (const line of lines) {
    // A numbered caption stays outside the artwork even when an over-wide drawing bbox
    // reaches under it; `roleOf` then marks it as a caption rather than a figure label.
    const drawn = !isCaptionLine(line.text) && insideFigure(line, figures);
    if (!drawn) carryProse = false;
    else if (
      !carryProse &&
      (previous === undefined || !endsSentence(previous.text)) &&
      /^[\p{Ll}\d,;:.…)\]}]/u.test(line.text.trim())
    ) {
      // A lower-case line that continues the sentence above is body prose crossing an
      // over-wide drawing bbox, not a label drawn inside the artwork.
      carryProse = true;
    } else if (
      !carryProse &&
      previous !== undefined &&
      isSectionHeading(previous.text) &&
      hasSourceProse(line.text.trim())
    ) {
      // A section title followed by column body in the same run stays prose even when a
      // drawing bbox sits between them only on paper geometry.
      carryProse = true;
    }
    const inside = drawn && !carryProse;
    if (previousInside !== null && inside !== previousInside && !(carryProse && drawn)) {
      groups.push(current);
      current = [];
    }
    current.push(line);
    previousInside = inside;
    previous = line;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Joins a row of body-size label fragments into the prose line they were cut from.
 *
 * Some extractors lose every word gap in a justified line. Each word then becomes its own
 * short label block, and the translation of each fragment is too long for its tiny box. The
 * fragments share a baseline and body type, so they can be put back into one prose block.
 */
type RefineProseContext = {
  tightenOnly?: boolean;
};

/** Clips prose boxes to the lines that belong in their column (gutter pages only). */
function refineProseBoxes(
  blocks: LayoutBlock[],
  _pageWidth: number,
  context?: RefineProseContext,
): void {
  if (context?.tightenOnly !== true) return;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block || (block.role !== 'prose' && block.role !== 'heading')) continue;
    const clip = unionBox(block.lines.map((line) => line.box));
    if (!clip) continue;
    const maxLine = Math.max(...block.lines.map((line) => line.box.width));
    const width = Math.min(Math.max(clip.width, maxLine), block.room.width);
    blocks[index] = { ...block, box: { ...clip, width } };
  }
}

function splitProseAtGutter(
  blocks: readonly LayoutBlock[],
  pageWidth: number,
  bodySize: number,
  figures: FigureAreas,
  pageHeight: number,
  pageIndex: number,
): LayoutBlock[] {
  if (pageWidth <= 0) return [...blocks];
  const gutter = pageWidth * 0.49;
  const out: LayoutBlock[] = [];
  for (const block of blocks) {
    if (block.role !== 'prose' && block.role !== 'heading') {
      out.push(block);
      continue;
    }
    const hasLeft = block.lines.some((line) => line.box.x < gutter - 2);
    const hasRight = block.lines.some((line) => line.box.x >= gutter - 2);
    if (!hasLeft || !hasRight) {
      out.push(block);
      continue;
    }
    const sides: Array<{ column: number; lines: TextLine[] }> = [
      { column: 0, lines: block.lines.filter((line) => line.box.x < gutter - 2) },
      { column: 1, lines: block.lines.filter((line) => line.box.x >= gutter - 2) },
    ];
    for (const side of sides) {
      if (side.lines.length === 0) continue;
      const built = buildBlock(
        side.lines,
        block.room,
        side.column,
        bodySize,
        figures,
        side.lines[0]?.box.x ?? block.box.x,
        pageHeight,
        pageIndex,
      );
      if (built) out.push({ ...built, role: block.role });
    }
  }
  return out;
}

/**
 * Splits a prose block that merges several numbered procedure steps into one step per item,
 * but only when the block spans the gutter so the list would otherwise paint over a neighbour.
 */
function splitNumberedListProse(
  blocks: readonly LayoutBlock[],
  bodySize: number,
  figures: FigureAreas,
  pageHeight: number,
  pageIndex: number,
  pageWidth: number,
): LayoutBlock[] {
  const gutter = pageWidth > 0 ? pageWidth * 0.49 : 0;
  const inBlockColumn = (line: TextLine, column: number): boolean => {
    if (gutter <= 0) return true;
    return column > 0 ? line.box.x >= gutter - 4 : line.box.x < gutter - 4;
  };
  const out: LayoutBlock[] = [];
  for (const block of blocks) {
    if (block.role !== 'prose' || block.lines.length < 4) {
      out.push(block);
      continue;
    }
    const orderedAll = [...block.lines].sort(
      (left, right) => left.baseline - right.baseline || left.box.x - right.box.x,
    );
    const spansGutter =
      gutter > 0 &&
      block.lines.some((line) => line.box.x < gutter - 4) &&
      block.lines.some((line) => line.box.x >= gutter - 4);
    const markerLines = orderedAll
      .filter((line) => inBlockColumn(line, block.column))
      .filter((line) => /^\d+\.$/u.test(line.text.trim())).length;
    if (markerLines < 2 || !spansGutter) {
      out.push(block);
      continue;
    }
    const ordered = orderedAll.filter((line) => inBlockColumn(line, block.column));
    if (ordered.length === 0) {
      out.push(block);
      continue;
    }
    const groups: TextLine[][] = [];
    let current: TextLine[] = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const line = ordered[index];
      if (!line) continue;
      const trimmed = line.text.trim();
      const isMarker = /^\d+\.$/u.test(trimmed);
      const isItemStart = /^\d+\.\s+\p{L}/u.test(trimmed);
      if (current.length > 0 && (isMarker || isItemStart)) {
        groups.push(current);
        current = [];
      }
      current.push(line);
      const next = ordered[index + 1];
      if (isMarker && next && Math.abs(next.baseline - line.baseline) <= line.height * 0.45) {
        index += 1;
        current.push(next);
      }
    }
    if (current.length > 0) groups.push(current);
    const realGroups = groups.filter((group) => joinLines(group).trim().length > 12);
    if (realGroups.length <= 1) {
      out.push(block);
      continue;
    }
    const neighbourLines = block.lines.filter((line) => !inBlockColumn(line, block.column));
    if (neighbourLines.length > 0) {
      const neighbourColumn = block.column > 0 ? 0 : 1;
      const neighbourBlock = buildBlock(
        neighbourLines,
        block.room,
        neighbourColumn,
        bodySize,
        figures,
        block.box.x,
        pageHeight,
        pageIndex,
      );
      if (neighbourBlock) out.push({ ...neighbourBlock, role: 'prose' });
    }
    for (const group of realGroups) {
      const columnGroup = group.filter((line) => inBlockColumn(line, block.column));
      if (columnGroup.length === 0) continue;
      const rebuilt = buildBlock(
        columnGroup,
        block.room,
        block.column,
        bodySize,
        figures,
        block.box.x,
        pageHeight,
        pageIndex,
      );
      if (rebuilt) out.push({ ...rebuilt, role: 'prose' });
    }
  }
  return out;
}

/** A run-in section title such as `Related work:` on the same line as the opening sentence. */
function runInSectionHeadingPrefix(text: string): boolean {
  return /^Related\s+[Ww]ork\s*:\s*\S/u.test(text.trimStart());
}

/** True when the whole trimmed line is a section title, not a title plus body on one line. */
function isStandaloneSectionHeading(text: string): boolean {
  return isSectionHeading(text.trim());
}

function shouldMergeAdjacentProse(
  left: LayoutBlock,
  right: LayoutBlock,
  allLines: readonly TextLine[],
): boolean {
  if (left.role !== 'prose' || right.role !== 'prose') return false;
  if (left.column !== right.column) return false;
  if (Math.abs(left.box.x - right.box.x) > 12) return false;
  const gap = right.box.y - (left.box.y + left.box.height);
  if (gap > Math.max(left.fontSize, right.fontSize) * 4) return false;
  if (obstacleBetweenBlocks(left, right, allLines)) return false;
  const tail = left.text.trimEnd();
  const head = right.text.trimStart();
  if (continuesProseText(tail, head)) return true;
  if (/[,;]\s*$/.test(tail) || /\band\s*$/i.test(tail)) return true;
  if (runInSectionHeadingPrefix(left.text) && !endsSentence(left.text)) return true;
  if (
    /Related\s+[Ww]ork\s*:/i.test(left.text) &&
    gap < Math.max(left.fontSize, right.fontSize) * 12
  ) {
    return true;
  }
  if (
    gap <= Math.max(left.fontSize, right.fontSize) * 9 &&
    (/^(?:Aim|Background|Method|Results)\s*:/i.test(head) ||
      (/^SUMMARY\b/i.test(left.text) && /^Aim\s*:/i.test(head)) ||
      (/^Aim\s*:/i.test(left.text) && /^[a-z]/u.test(head)))
  ) {
    return true;
  }
  return false;
}

function mergeAdjacentProseBlocks(
  blocks: readonly LayoutBlock[],
  bodySize: number,
  figures: FigureAreas,
  pageHeight: number,
  pageIndex: number,
  allLines: readonly TextLine[],
): LayoutBlock[] {
  const merged: LayoutBlock[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (previous && shouldMergeAdjacentProse(previous, block, allLines)) {
      const lines = [...previous.lines, ...block.lines].sort(
        (a, b) => a.baseline - b.baseline || a.box.x - b.box.x,
      );
      const room = unionBox([previous.room, block.room]) ?? previous.room;
      const rebuilt = buildBlock(
        lines,
        room,
        previous.column,
        bodySize,
        figures,
        Math.min(previous.box.x, block.box.x),
        pageHeight,
        pageIndex,
      );
      if (rebuilt) merged[merged.length - 1] = { ...rebuilt, role: 'prose' };
      else merged.push(block);
      continue;
    }
    merged.push(block);
  }
  return merged;
}

function splitMergedOverlongProse(
  blocks: readonly LayoutBlock[],
  bodySize: number,
  figures: FigureAreas,
  pageHeight: number,
  pageIndex: number,
): LayoutBlock[] {
  const out: LayoutBlock[] = [];
  for (const block of blocks) {
    if (block.role !== 'prose' || block.text.length <= MAX_PROSE_BLOCK_CHARS) {
      out.push(block);
      continue;
    }
    let lines = [...block.lines];
    for (;;) {
      const split = overlongProseSplit(lines);
      if (!split) break;
      const headBlock = buildBlock(
        split.head,
        block.room,
        block.column,
        bodySize,
        figures,
        block.box.x,
        pageHeight,
        pageIndex,
      );
      if (headBlock) out.push({ ...headBlock, role: 'prose' });
      lines = split.tail;
    }
    const tailBlock = buildBlock(
      lines,
      block.room,
      block.column,
      bodySize,
      figures,
      block.box.x,
      pageHeight,
      pageIndex,
    );
    if (tailBlock) out.push({ ...tailBlock, role: 'prose' });
  }
  return out;
}

function mergeLabelFragments(
  blocks: readonly LayoutBlock[],
  bodySize: number,
  figures: FigureAreas,
  pageHeight: number,
  pageIndex: number,
): LayoutBlock[] {
  if (bodySize <= 0 || blocks.length < 2) return [...blocks];
  const baselineOf = (block: LayoutBlock): number =>
    block.lines[0]?.baseline ?? block.box.y + block.box.height;
  const rowBlocks = blocks.filter(
    (block) =>
      (block.role === 'label' || block.role === 'prose') &&
      Math.abs(block.fontSize - bodySize) <= bodySize * SIZE_CHANGE &&
      block.lines.length > 0,
  );
  if (rowBlocks.length < 2) return [...blocks];

  const sorted = [...rowBlocks].sort(
    (left, right) => baselineOf(left) - baselineOf(right) || left.box.x - right.box.x,
  );
  const groups: LayoutBlock[][] = [];
  for (const block of sorted) {
    const group = groups[groups.length - 1];
    const previous = group?.[group.length - 1];
    const sameBaseline =
      previous !== undefined &&
      Math.abs(baselineOf(previous) - baselineOf(block)) <= Math.max(block.fontSize * 0.4, 0.5);
    const gap = previous === undefined ? Infinity : block.box.x - boxRight(previous.box);
    if (group && previous && sameBaseline && gap <= block.fontSize * 2) group.push(block);
    else groups.push([block]);
  }

  const replaced = new Map<LayoutBlock, LayoutBlock>();
  const consumed = new Set<LayoutBlock>();
  for (const group of groups) {
    if (group.length < 2 || !group.some((block) => block.role === 'label')) continue;
    const lines = group
      .flatMap((block) => block.lines)
      .sort((left, right) => left.baseline - right.baseline || left.box.x - right.box.x);
    const box = unionBox(lines.map((line) => line.box));
    if (!box) continue;
    const room = unionBox(group.map((block) => block.room)) ?? box;
    const merged = buildBlock(
      lines,
      room,
      group[0]?.column ?? 0,
      bodySize,
      figures,
      minLeft(lines),
      pageHeight,
      pageIndex,
    );
    if (!merged) continue;
    const first = group[0];
    if (!first) continue;
    replaced.set(first, { ...merged, role: 'prose' });
    for (const block of group.slice(1)) consumed.add(block);
  }

  return blocks.flatMap((block) => {
    if (consumed.has(block)) return [];
    return [replaced.get(block) ?? block];
  });
}

function buildBlock(
  lines: readonly TextLine[],
  room: Box,
  column: number,
  bodySize: number,
  figures: FigureAreas,
  columnLeft = -Infinity,
  pageHeight = 0,
  pageIndex = 0,
): LayoutBlock | null {
  if (lines.length === 0) return null;
  const inColumn = lines.filter(
    (line) => line.box.x >= room.x - 6 && line.box.x + line.box.width <= boxRight(room) + 8,
  );
  const baselinesEarly = lines.map((line) => line.baseline);
  const fontSizeEarly = median(lines.map((line) => line.height));
  const widestLine = Math.max(...lines.map((line) => line.box.width), 0);
  const multiLineProse =
    lines.length > 1 &&
    Math.max(...baselinesEarly) - Math.min(...baselinesEarly) > Math.max(fontSizeEarly, 1) * 0.65 &&
    room.width < widestLine * 0.92;
  const measureFrom =
    multiLineProse || inColumn.length < Math.max(1, Math.ceil(lines.length * 0.4))
      ? lines
      : inColumn;
  const box = unionBox(measureFrom.map((line) => line.box));
  if (!box) return null;

  const text = joinLines(lines);
  if (text.length === 0) return null;

  const fontSize = median(lines.map((line) => line.height));
  const baselines = lines.map((line) => line.baseline);
  const gaps: number[] = [];
  for (let index = 1; index < baselines.length; index += 1) {
    const delta = (baselines[index] ?? 0) - (baselines[index - 1] ?? 0);
    if (delta > 0) gaps.push(delta);
  }
  const lineHeight = gaps.length > 0 ? median(gaps) / Math.max(fontSize, 1) : 1.35;
  const bold = sharesWeight(lines, 'bold');

  // Room grows to the right of the source box, never to its left. Pulling a cell or a
  // centred line back to the region's left edge made its white cover sit on top of the
  // neighbour that actually owns that space.
  const regionRight = room.width > 0 ? boxRight(room) : boxRight(box);
  const grownRight = box.x + box.width * ROOM_GROWTH + 8;
  const roomRight = Math.min(regionRight, grownRight);
  const rawWidth = roomRight - box.x;
  // A gutter is white space in the source, so a translated box keeps a share of it on the
  // right when there is extra. Without this, two columns' boxes touch at the gutter.
  const roomWidth =
    rawWidth > box.width + GUTTER_CLEARANCE ? rawWidth - GUTTER_CLEARANCE : Math.max(1, rawWidth);
  const blockRoom: Box = {
    x: box.x,
    y: box.y,
    width: roomWidth,
    height: box.height,
  };

  return {
    box,
    room: blockRoom,
    lines: [...lines],
    text,
    role: roleOf(text, lines, fontSize, bodySize, bold, figures, columnLeft, pageHeight, pageIndex),
    fontSize,
    lineHeight: clamp(lineHeight, 1.05, 2.2),
    align: alignOf(lines),
    bold,
    italic: sharesWeight(lines, 'italic'),
    column,
    writing: writingOf(lines),
    advance: advanceOf(lines),
  };
}

function writingOf(lines: readonly TextLine[]): 0 | 90 | 180 | 270 {
  const votes = new Map<number, number>();
  for (const line of lines) {
    for (const piece of line.pieces) {
      const angle = piece.displayed;
      votes.set(angle, (votes.get(angle) ?? 0) + Math.max(1, piece.text.length));
    }
  }
  let best = 0;
  let bestWeight = -1;
  for (const [angle, weight] of votes) {
    if (weight > bestWeight) {
      best = angle;
      bestWeight = weight;
    }
  }
  return best === 90 || best === 270 || best === 180 ? best : 0;
}

function advanceOf(lines: readonly TextLine[]): number {
  let best = 1;
  for (const line of lines) {
    const displayed = line.pieces[0]?.displayed ?? 0;
    const along = displayed === 90 || displayed === 270 ? line.box.height : line.box.width;
    best = Math.max(best, along);
  }
  return best;
}

/**
 * Joins the lines of a block into one string.
 *
 * A hyphen at the end of a line is the one place where the source's layout leaks into its
 * words, and a paper is full of them: `instruc-ture`, `informa-tion`, and in a narrow table
 * cell even `maxSegmentTo-kens`. The hyphen is dropped when the next line continues in lower
 * case, which is what a soft hyphen means and what justifies the join. A real compound split
 * across lines loses its hyphen and reads as one word, which is a smaller error than leaving
 * `instruc-` in the middle of a sentence for the model to translate.
 */
function joinLines(lines: readonly TextLine[]): string {
  let output = '';
  for (const line of lines) {
    const value = line.text.trim();
    if (value.length === 0) continue;
    if (output.length === 0) {
      output = value;
      continue;
    }
    const endsHyphen = /[\u002d\u2010\u2011]$/u.test(output);
    const startsLower = /^[\p{Ll}]/u.test(value);
    output = endsHyphen && startsLower ? `${output.slice(0, -1)}${value}` : `${output} ${value}`;
  }
  return output.replace(/\s+/gu, ' ').trim();
}

/**
 * Splits an overlong run at the last complete sentence inside the cap.
 *
 * A long paragraph does not usually end its sentences at line boundaries: the sentence stops
 * in the middle of a line and the next one starts there. Splitting only between lines left a
 * 1300-character summary as one block that no fit could paint. The head keeps the sentence
 * that closes before the cap; a mid-line remainder starts the tail on the next line slot so
 * the two painted boxes never share a baseline.
 */
function overlongProseSplit(
  lines: readonly TextLine[],
): { head: TextLine[]; tail: TextLine[] } | null {
  let length = 0;
  const candidates: { index: number; end: number; at: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const text = line.text.trim();
    if (text.length === 0) continue;
    const offset = length > 0 ? 1 : 0;
    for (const match of text.matchAll(/[.!?]["'”’»)\]]*(?=\s|$)/gu)) {
      const end = (match.index ?? 0) + match[0].length;
      candidates.push({ index, end, at: length + offset + end });
    }
    length += offset + text.length;
  }
  if (length <= MAX_PROSE_BLOCK_CHARS) return null;
  // Balance two chunks instead of filling the first to the cap and leaving a one-line tail:
  // a short tail cannot absorb the extra line a translation needs, and has no gap to grow in.
  const target = length > MAX_PROSE_BLOCK_CHARS * 2 ? MAX_PROSE_BLOCK_CHARS : length / 2;
  let split: { index: number; end: number } | null = null;
  let after: { index: number; end: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.at <= target) split = { index: candidate.index, end: candidate.end };
    else if (after === null) after = { index: candidate.index, end: candidate.end };
  }
  split ??= after;
  if (!split) return null;
  const line = lines[split.index];
  if (!line) return null;
  const text = line.text.trim();
  const head = lines.slice(0, split.index);
  let tail: TextLine[];
  if (split.end >= text.length) {
    head.push(line);
    tail = [...lines.slice(split.index + 1)];
  } else {
    // Keep the original pieces on the head so every extracted piece still belongs to a block.
    // The head's cover is the whole source line. The remainder logically precedes the next
    // line, so it rides on that line's box instead of sharing the head's baseline; the next
    // source line is hidden by the tail's translation, not by a compressed extra line.
    head.push({ ...line, text: text.slice(0, split.end).trimEnd() });
    const remainder = text.slice(split.end).trimStart();
    if (remainder.length === 0) return null;
    const next = lines[split.index + 1];
    tail = next
      ? [{ ...next, text: `${remainder} ${next.text.trim()}` }, ...lines.slice(split.index + 2)]
      : [
          {
            ...line,
            text: remainder,
            box: { ...line.box, y: line.box.y + line.box.height },
            baseline: line.baseline + line.box.height,
            pieces: [],
          },
        ];
  }
  if (head.length === 0 || tail.length === 0) return null;
  return { head, tail };
}

/** True when a skipped `figure-label` is actually body copy swallowed by figure geometry. */
export function isMisclassifiedFigureProse(
  text: string,
  lines: readonly TextLine[],
  pageIndex: number,
): boolean {
  return hasSourceProse(text) && proseDespiteFigureOverlap(text, lines, pageIndex);
}

/**
 * True when overlapping figure geometry must not turn translatable body copy into figure labels.
 */
function proseDespiteFigureOverlap(
  text: string,
  lines: readonly TextLine[],
  pageIndex: number,
): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (isSectionHeading(trimmed) && hasWords(trimmed)) return true;
  const headSentence = trimmed.match(/^[^.!?]+[.!?]/)?.[0]?.trim();
  if (headSentence && isSectionHeading(headSentence) && hasSourceProse(trimmed)) return true;
  if (/^\p{Ll}/u.test(trimmed) && hasWords(trimmed)) return true;
  if (lines.length >= 2 && hasSourceProse(trimmed)) {
    if (lines.some((line) => isSectionHeading(line.text.trim()))) return true;
    if (/^\p{Ll}/u.test(lines[0]?.text.trim() ?? '')) return true;
  }
  const columnWide = lines.length > 0 && lines.every((line) => line.box.width >= 180);
  if (
    pageIndex > 0 &&
    columnWide &&
    lines.length === 1 &&
    hasSourceProse(trimmed) &&
    hasWords(trimmed)
  ) {
    return true;
  }
  return /^\p{Ll}/u.test(trimmed) && trimmed.length >= 60;
}

function roleOf(
  text: string,
  lines: readonly TextLine[],
  fontSize: number,
  bodySize: number,
  bold: boolean,
  figures: FigureAreas,
  columnLeft = -Infinity,
  pageHeight = 0,
  pageIndex = 0,
): AnyBlockRole {
  // A display equation is checked first, because it is the one thing a reader must get back
  // unchanged. Its own typesetting is the rendering: the paper drew the integral signs, the
  // fractions and the subscripts correctly, and replacing them with translated characters
  // puts running prose where the mathematics was.
  if (isEquation(lines, columnLeft)) return 'equation';
  const insideLines = lines.filter((line) => insideFigure(line, figures)).length;
  const insideFigureArea = lines.length > 0 && insideLines * 2 > lines.length;
  // A caption under a drawing stays a caption even when the drawing's bbox covers it.
  if (isCaptionLine(text)) return 'caption';
  // Footnote affiliations are identity furniture, not body prose. Keeping each one on its
  // own line stops a run of `† The author is with …` from becoming a paragraph.
  if (isAffiliationLine(text)) return 'furniture';
  // Other text drawn inside a picture belongs to the artwork. When a figure bbox is too wide it
  // can swallow the column-top paragraph that continues from the previous page or a `Related
  // work` section: that text is body copy and must stay translatable, not `figure-label`.
  if (insideFigureArea && !proseDespiteFigureOverlap(text, lines, pageIndex)) return 'figure-label';
  if (isCodeBlock(lines)) return 'code';
  // Section titles are headings even in all caps and even when they sit in the header band.
  if (isSectionHeading(text) && lines.length <= 2) return 'heading';
  if (isBylineLabel(text) && pageIndex === 0) return 'identity';
  // A marked name line is an author byline. Footnote affiliations are set smaller than the
  // body and stay prose-like identity text rather than stealing the byline rule.
  if (isMarkedAuthorLine(text) && (bodySize <= 0 || fontSize >= bodySize * 0.95)) {
    return 'identity';
  }
  if (isFurniture(text, lines, pageHeight, bodySize)) return 'furniture';
  if (
    isFirstPageIdentity(text, {
      pageIndex,
      y: lines[0]?.box.y ?? 0,
      pageHeight,
      fontSize,
      bodySize,
    })
  ) {
    return 'identity';
  }
  // A numbered caption is still a caption on a page without figures.
  if (isCaptionLine(text)) return 'caption';
  if (/^(?:[IVXLC]+\.|[A-Z]\.|\d+(?:\.\d+)*\.?)\s+\p{Lu}/u.test(text) && lines.length <= 2) {
    return 'heading';
  }
  // A row of axis ticks or legend values is table typesetting, not a sentence.
  if (isNumericRow(text)) return 'cell';
  // A unit such as `tok/s` is notation, not a title, even when the table header is bold.
  if (isUnitLabel(text)) return 'label';
  // Table column titles such as `Settings` are bold but must not become section headings.
  if (isTableHeaderLine(text) && lines.length <= 2) return 'label';
  if (bodySize > 0 && fontSize >= bodySize * 1.08) return 'heading';
  // A bold run of one or two lines above the body is a heading, even when the typesetter
  // gave it the body's size.
  if (bold && lines.length <= 2) return 'heading';
  if (lines.length === 1 && text.length <= 32 && !/[.!?]$/u.test(text)) return 'label';
  return 'prose';
}

/**
 * True when these lines are a listing rather than a paragraph.
 *
 * A paper's algorithm figure is often set in the body face, not Courier: `for each (m) {`
 * and `evalModules = …;` still have to stay untranslated, including a wrapped last word
 * (`developer;`) that would otherwise look like a one-word label.
 */
function isCodeBlock(lines: readonly TextLine[]): boolean {
  if (lines.length === 0) return false;
  const pieces = lines.flatMap((line) => line.pieces);
  if (pieces.length === 0) return false;
  const text = lines.map((line) => line.text).join(' ');
  if (isCaptionLine(text)) return false;
  if (cjkRatio(text) >= CJK_MAJORITY) return false;
  // A wrapped `developer;` only counts once a real listing line is already in this
  // block. Counting continuations on their own turned `pages;` / `forms;` and a
  // two-line bibliography wrap into `code`.
  let codeish = 0;
  let sawCodeLine = false;
  for (const line of lines) {
    if (looksLikeCodeLine(line.text)) {
      sawCodeLine = true;
      codeish += 1;
      continue;
    }
    if (sawCodeLine && looksLikeCodeContinuation(line.text)) codeish += 1;
  }
  if (lines.length >= 2 && sawCodeLine && codeish * 2 >= lines.length) return true;
  const mono = pieces.filter((piece) => piece.family === 'monospace').length;
  if (mono * 2 >= pieces.length) {
    if (lines.length >= 2) {
      const hits = lines.filter(
        (line) => looksLikeCodeLine(line.text) || cjkRatio(line.text) < 0.1,
      ).length;
      return hits * 2 >= lines.length;
    }
    return looksLikeCodeLine(lines[0]?.text ?? '');
  }
  return lines.length === 1 && looksLikeCodeLine(lines[0]?.text ?? '');
}

function codeListingContinues(previous: string, next: string): boolean {
  const before = looksLikeCodeLine(previous) || looksLikeCodeContinuation(previous);
  const after = looksLikeCodeLine(next) || looksLikeCodeContinuation(next);
  return before && after;
}

/** Drop one layer of `(…)`, `[…]`, `{…}` so commas inside arguments are not sentence commas. */
function withoutBracketSpans(text: string): string {
  return text.replace(/[([{][^)\]}]*(?:[)\]}]|$)/gu, ' ');
}

const ENGLISH_FUNCTION_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'and',
  'or',
  'that',
  'which',
  'whose',
  'when',
  'while',
  'before',
  'after',
  'with',
  'for',
  'by',
  'from',
  'this',
  'these',
  'those',
  'we',
  'it',
  'its',
  'their',
  'than',
  'as',
  'at',
  'on',
  'but',
  'not',
  'so',
  'into',
  'over',
]);

/** Keywords that mark a listing step. `set` / `end` are ordinary nouns (`Training set`) and are not here. */
const LISTING_STEP_WORD =
  /\b(?:if|then|else|while|for|each|repeat|until|do|return|emit|print|procedure|begin|break|continue|yield|init|def)\b/iu;

const LISTING_STEP_WORDS = new Set([
  'if',
  'then',
  'else',
  'while',
  'for',
  'each',
  'repeat',
  'until',
  'do',
  'end',
  'return',
  'emit',
  'print',
  'procedure',
  'begin',
  'break',
  'continue',
  'yield',
  'init',
  'set',
  'def',
]);

function wordsOf(text: string): string[] {
  return text
    .split(/\s+/u)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((token) => token.length > 0 && /\p{L}/u.test(token));
}

function functionWordShare(words: readonly string[]): number {
  if (words.length === 0) return 0;
  let hits = 0;
  for (const word of words) {
    if (ENGLISH_FUNCTION_WORDS.has(word.toLowerCase())) hits += 1;
  }
  return hits / words.length;
}

function contentWordCount(words: readonly string[]): number {
  let count = 0;
  for (const word of words) {
    const lower = word.toLowerCase();
    if (word.length <= 1) continue;
    if (ENGLISH_FUNCTION_WORDS.has(lower) || LISTING_STEP_WORDS.has(lower)) continue;
    count += 1;
  }
  return count;
}

/** Assignment, arrows, braces, or a call that opens the line — not a parenthetical cite. */
function hasCodeOperators(rest: string, bare: string): boolean {
  if (/[{}]/u.test(rest)) return true;
  if (/^[A-Za-z_][\w.]*\s*\(/u.test(rest)) return true;
  if (/(?:==|:=|<-|->|\+\+)/u.test(bare)) return true;
  return /(?<![<>=!])=(?!=)/u.test(bare);
}

/**
 * An English clause after the last comma that is not inside brackets: `whose blocks are queued…`.
 */
function englishClauseAfterComma(bare: string): boolean {
  const comma = bare.lastIndexOf(',');
  if (comma < 0) return false;
  const clause = wordsOf(bare.slice(comma + 1));
  if (clause.length < 3) return false;
  return ENGLISH_FUNCTION_WORDS.has(clause[0]?.toLowerCase() ?? '');
}

/**
 * `Set threshold` / `End if` / `End procedure` at the start of the line. `Set of blocks`,
 * `End of document`, and `End to end latency` are English (`set`/`end` + of/to/for/the/a).
 */
function isSetOrEndStep(rest: string): boolean {
  const match = /^(?:set|end)\b(.*)$/iu.exec(rest.trim());
  if (!match) return false;
  const after = (match[1] ?? '').trim();
  if (after.length === 0) return true;
  if (/^(?:of|to|for|the|a)\b/iu.test(after)) return false;
  return /^(?:if|while|for|procedure|repeat|until|do|else|then|[A-Za-z_][\w]*)\b/u.test(after);
}

/**
 * One- or two-token algorithm steps: `Repeat`, `If ready`, `While queue`, `Until done`,
 * `Procedure Run`, `Set threshold`. Not `While loading` (gerund), `Repeat runs` (plural
 * English), or `Set of` / `End of` / `End to`.
 */
function isBareListingStep(tokens: readonly string[]): boolean {
  if (tokens.length === 0 || tokens.length > 2) return false;
  const first = tokens[0]?.toLowerCase() ?? '';
  if (!LISTING_STEP_WORDS.has(first)) return false;
  if (tokens.length === 1) return true;
  const second = tokens[1]?.toLowerCase() ?? '';
  if (/^(?:of|to|for|the|a)$/u.test(second) || ENGLISH_FUNCTION_WORDS.has(second)) return false;
  if (/ing$/u.test(second)) return false;
  if (first === 'repeat' && /s$/u.test(second)) return false;
  return true;
}

/**
 * Numbered English, including a semicolon or colon that ends a sentence, not a listing.
 * Needs four or more words (checked before a comma clause, so `2 for each block, emit it`
 * is not saved by the clause), no operators outside brackets, and either a 30% function-word
 * share with three content words, a `.!?` ending with three content words, or a function-word
 * clause after the last bare comma. `1  for i in range(0, n):` has too few content words.
 */
function looksLikeEnglishProse(rest: string): boolean {
  const bare = withoutBracketSpans(rest);
  if (hasCodeOperators(rest, bare)) return false;
  const words = wordsOf(bare);
  if (words.length < 4) return false;
  if (englishClauseAfterComma(bare)) return true;
  const content = contentWordCount(words);
  if (content < 3) return false;
  return functionWordShare(words) >= 0.3 || /[.!?]\s*$/u.test(rest);
}

/**
 * Numbered short labels (`1 Introduction`, `3 If the model is cold`, `2 While loading`).
 * Title-case, at most six words, no listing punctuation. A bare algorithm step (`1 If ready`,
 * `1 While queue`, `2 Repeat`, `4 Until done`) is not a label; a gerund or longer Title-case
 * phrase (`2 While loading`, `4 For further details`, `6 Repeat runs`) is.
 */
function isNumberedShortLabel(rest: string): boolean {
  const words = rest
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0 || words.length > 6) return false;
  if (!/^\p{Lu}/u.test(words[0] ?? '')) return false;
  if (/[:{(=;]\s*$/u.test(rest) || /\b(?:then|do)\s*$/iu.test(rest)) return false;
  if (/[=()[\]{}]/u.test(rest)) return false;
  if (isSetOrEndStep(rest)) return false;
  const tokens = wordsOf(rest);
  if (LISTING_STEP_WORD.test(rest) || /^(?:set|end)\b/iu.test(rest)) {
    if (isBareListingStep(tokens)) return false;
    return tokens.length >= 2;
  }
  return true;
}

/** `1  a, b = b, a` — identifiers on both sides of `=`, not `1 for example, a = b`. */
function isIdentifierTupleAssign(rest: string): boolean {
  if (/^(?:for|if|while|def|repeat|until)\b/iu.test(rest)) return false;
  return /^[A-Za-z_][\w]*(?:\s*,\s*[A-Za-z_][\w]*)+\s*=\s*[A-Za-z_][\w]*(?:\s*,\s*[A-Za-z_][\w]*)*\s*;?$/u.test(
    rest,
  );
}

/**
 * The body of a numbered line after the leading digits. English is recognised first so a
 * trailing `;` / `:` cannot turn a sentence into a listing. Remaining lines with for/if/while/
 * def/repeat/until, `then`/`do`, trailing `[:{(=;]`, or tuple assignment stay code.
 */
function numberedLineIsCode(rest: string): boolean {
  const trimmed = rest.trim();
  if (trimmed.length === 0) return false;
  if (isNumberedShortLabel(trimmed)) return false;
  if (looksLikeEnglishProse(trimmed)) return false;

  const bare = withoutBracketSpans(trimmed);
  const listingLead =
    /^(?:for|if|while|def|repeat|until|init|procedure|begin)\b/iu.test(trimmed) ||
    isSetOrEndStep(trimmed);
  const trailingCode =
    /[:{(=;]\s*$/u.test(trimmed) ||
    /\)\s*;?\s*$/u.test(trimmed) ||
    /\b(?:then|do)\s*$/iu.test(trimmed);
  const sentence = /[.!?]\s*$/u.test(trimmed) || (/,/u.test(bare) && !trailingCode && !listingLead);
  if (sentence) return isIdentifierTupleAssign(trimmed);

  if (trailingCode) return true;
  if (/[=()[\]]/u.test(bare)) return true;
  if (
    /(?:[;{}]|[a-z][A-Z]|\b(?:for\s+each\s*[{(]|for\s*\(|if\s*\(|while\s*\(|return\b|def\b|emit\b))/u.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (listingLead) return true;
  if (/^[A-Za-z_][\w.]*\(/u.test(trimmed) && /[);{]\s*$/u.test(trimmed)) return true;
  return isIdentifierTupleAssign(trimmed);
}

/** A line of pseudocode or a program, even when the page set it in a body face. */
export function looksLikeCodeLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (
    /^(?:for\s+each\s*[{(]|foreach\b|for\s*\(|while\s*\(|if\s*\(|else\b|repeat\b|until\b|end\s+(?:for|if|while|procedure)\b)/iu.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (/^[A-Za-z_][\w.]*\s*=.+;\s*$/u.test(trimmed)) return true;
  if (/^[A-Za-z_][\w]*\s*=\s*.+/u.test(trimmed) && /[;{}]\s*$/u.test(trimmed)) return true;
  if (/^[a-z]+[A-Z][A-Za-z0-9]*\s*[=:(]/u.test(trimmed)) return true;
  if (trimmed.length < 96 && /[a-z][A-Z]/u.test(trimmed) && /(?:^|\s)=\s*\S/u.test(trimmed)) {
    return true;
  }
  if (/^(?:\}|;)\s*$/u.test(trimmed) || /^\}\s*(?:else|catch)/u.test(trimmed)) return true;
  if (
    /(?:^|[;{}]\s*)(?:continue|return|break|yield)\b/u.test(trimmed) &&
    /[;{}()]/u.test(trimmed)
  ) {
    return true;
  }
  // Numbered listing (`1  for i in range(0, n):`, `1 While queue:`). English is
  // recognised first so a trailing `;` / `:` on `1 The reader applies the following
  // rules in order:` cannot turn a sentence into a listing.
  if (/^\d+\s+/u.test(trimmed)) {
    return numberedLineIsCode(trimmed.replace(/^\d+\s+/u, ''));
  }
  if (
    /[_=(){}[\];]/u.test(trimmed) &&
    (/\b(?:if|while|for|switch|catch)\s*\(/u.test(trimmed) ||
      /\b(?:def|function|const|let|var|class)\s+[A-Za-z_$][\w$]*\s*[=(:]/u.test(trimmed) ||
      /\b(?:emit|print)\s*\(/u.test(trimmed))
  ) {
    return true;
  }
  return /^[A-Za-z_][\w.]*\(/u.test(trimmed) && /[);{]\s*$/u.test(trimmed);
}

/** A wrapped remainder of a listing: `developer;` or `output evaluation = …`. */
function looksLikeCodeContinuation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 48) return false;
  if (/^[A-Za-z][\w]*;\s*$/u.test(trimmed)) return true;
  if (/^[A-Za-z][\w ]+=\s*\S/u.test(trimmed) && /(?:[a-z][A-Z]|[;{}])/u.test(trimmed)) {
    return true;
  }
  if (/^[A-Za-z][\w ]+;\s*$/u.test(trimmed)) return true;
  return /^[)}\];]+$/u.test(trimmed);
}

/**
 * True when a short run at the top or foot of the page is a running header, a footer, or a
 * page number. Those strings repeat on every page and are not the document a reader came for.
 */
function isFurniture(
  text: string,
  lines: readonly TextLine[],
  pageHeight: number,
  bodySize: number,
): boolean {
  if (pageHeight <= 0 || lines.length === 0) return false;
  const box = lines[0]?.box;
  if (!box) return false;
  const atTop = box.y < FURNITURE_MARGIN;
  const atFoot = box.y + box.height > pageHeight - FURNITURE_MARGIN;
  if (!atTop && !atFoot) return false;
  if (/^\d{1,4}$/u.test(text.trim())) return true;
  if (
    lines.length <= 2 &&
    text.length <= 80 &&
    bodySize > 0 &&
    (lines[0]?.height ?? 0) < bodySize * 0.95
  ) {
    return true;
  }
  return false;
}

/** A line whose characters are mostly set in the paper's math fonts. */
const EQUATION_LINE_SHARE = 0.6;
/** A line holding this many math characters is part of an equation even in a short run. */
const EQUATION_MIN_MATH_CHARS = 2;
/**
 * A line with more prose letters than this is a sentence, whatever its math share.
 *
 * `with query and key vectors q , k ∈ R` scores 55% math because a typesetter sets those
 * variables in an italic math face, but it also holds 28 letters of running English. A display
 * equation holds at most a function name or two, so the threshold sits well above one word and
 * well below the shortest sentence a document writes.
 */
const EQUATION_MAX_PROSE_CHARS = 16;

/**
 * True when these lines are a display equation rather than a sentence.
 *
 * The signal is the font: a LaTeX paper sets its math in `CMMI`/`CMSY`/`CMEX`, and no sentence
 * is ever typeset in them. Reading the font rather than the characters is what makes this
 * work on `E = mc²` and on a bare `α`, which no character test separates from prose.
 *
 * A math share alone would call half of a survey's body text mathematics, because its prose is
 * full of italic variables set in those same faces. So a line needs a second reason:
 *
 * - it carries almost no ordinary text — `Diag`, `Sigmoid`, a comma — which is what a display
 *   equation looks like; or
 * - it is indented away from its column's left edge, which is how a typesetter centres a
 *   formula, and it does not end a sentence. This is what catches `q , k = LayerNorm(xW)`,
 *   whose function names are set in the text face and would otherwise look like prose.
 */
const EQUATION_OPERATOR = /[=∈≈≤≥≠+−×÷⊙∑∏∫√±∞∂∇]/u;

export function isEquation(lines: readonly TextLine[], columnLeft = -Infinity): boolean {
  if (lines.length === 0) return false;
  let mathLines = 0;
  let mathChars = 0;
  let proseChars = 0;
  for (const line of lines) {
    proseChars += line.proseChars;
    if (line.mathRatio >= EQUATION_LINE_SHARE) {
      mathLines += 1;
      mathChars += line.text.length;
      continue;
    }
    if (line.mathRatio > 0) mathChars += Math.round(line.text.length * line.mathRatio);
  }

  const hasOperator = lines.some((line) => EQUATION_OPERATOR.test(line.text));
  // A display formula whose variables are set in italic Times, not in a math face: it still
  // sits indented (or centred) and is built out of operators rather than of a sentence.
  const indented = lines.every((line) => line.box.x > columnLeft + line.height * 3);
  const complete = /[.!?]$/u.test(lines[lines.length - 1]?.text.trimEnd() ?? '');
  // A horizontal cut can isolate a centred formula as its own region, so `columnLeft` is the
  // formula's own left edge and the indent test is vacuously false. An all-italic (or math)
  // operator line with almost no prose is still a formula in that case.
  const isolated = lines.length === 1 && Math.abs((lines[0]?.box.x ?? 0) - columnLeft) < 1;
  const styled = lines.every(
    (line) => line.pieces.length > 0 && line.pieces.every((piece) => piece.italic || piece.math),
  );
  const displayShape =
    hasOperator &&
    !complete &&
    proseChars <= EQUATION_MAX_PROSE_CHARS &&
    (indented || (isolated && styled));

  if (mathChars >= EQUATION_MIN_MATH_CHARS) {
    if (proseChars <= EQUATION_MAX_PROSE_CHARS)
      return mathLines > 0 || lines.length === 1 || displayShape;
    if (!indented || complete) return false;
    return hasOperator;
  }
  return displayShape;
}

/**
 * Alignment from the line boxes. Centred text puts every line's midpoint in the same place
 * and does not share a left edge; justified text shares *both* edges, so its midpoints agree
 * too and it has to be tested for left alignment first. Everything that shares neither edge
 * reads as left-aligned, which is also what ragged-right text is.
 */
function alignOf(lines: readonly TextLine[]): BlockAlign {
  if (lines.length < 2) return 'left';
  const centers = lines.map((line) => line.box.x + line.box.width / 2);
  const lefts = lines.map((line) => line.box.x);
  const rights = lines.map((line) => boxRight(line.box));
  const tolerance = Math.max(0.8, median(lines.map((line) => line.height)) * 0.5);

  if (spread(lefts) <= tolerance) return 'left';
  if (spread(rights) <= tolerance) return 'right';
  if (spread(centers) <= tolerance) return 'center';
  return 'left';
}

function spread(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function sharesWeight(lines: readonly TextLine[], weight: 'bold' | 'italic'): boolean {
  const all = lines.flatMap((line) => line.pieces);
  if (all.length === 0) return false;
  const matching = all.filter((piece) => piece[weight]).length;
  return matching * 2 > all.length;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
