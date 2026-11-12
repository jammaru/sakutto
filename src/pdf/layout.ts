import { boxBottom, boxRight, median, unionBox, type Box } from './geometry';
import { insideFigure, type FigureAreas } from './figures';
import { gutterCandidates, horizontalGaps, groupByBaseline } from './gaps';
import { isFirstPageIdentity } from './identity';
import { SEGMENT_GAP, isRotated, type TextLine } from './lines';

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
/** A type size change of this fraction is a different kind of thing. */
const SIZE_CHANGE = 0.12;
/** Two cells belong to the same column when this much of the narrower one is shared. */
const MIN_COLUMN_OVERLAP = 0.5;
/** A run of rows is a table when this fraction of them hold two or more cells. */
const TABLE_ROW_SHARE = 0.5;
/** The widest text a table cell may hold, in characters. */
const CELL_MAX_CHARS = 44;
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
  if (clean.length === 0) {
    return empty();
  }

  const unit = Math.max(1, median(clean.map((line) => line.height)));
  const bodySize = bodySizeOf(clean);
  const blocks: LayoutBlock[] = [];

  for (const region of cutRegions(clean, unit)) {
    appendRegionBlocks(region, bodySize, blocks, figures, pageHeight, pageIndex);
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
  // box on top of the first. A table cell like `48` is a value the reader wants translated with
  // its column, so the test needs more than "few words": notation has no word at all and is set
  // smaller than the body.
  const isProse = (block: LayoutBlock): boolean => {
    if (block.role === 'caption' || block.role === 'heading' || block.role === 'prose') {
      return true;
    }
    if (isTick(block.text) && block.role !== 'cell' && block.role !== 'label') return false;
    if (block.role === 'label') {
      if (hasWord(block.text)) return true;
      // A table value such as `48` is a one-word label at body size; it still belongs on
      // the translated page. An axis tick inside a figure has already been classified as
      // figure-label and never reaches this test.
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
      block.role !== 'heading'
    ) {
      return false;
    }
    if (block.lines.some((line) => contentsRows.has(line.baseline))) return false;
    return isProse(block);
  };

  return {
    blocks: blocks.filter(translatable),
    bodySize,
    lineHeight: unit,
    skipped: blocks.filter((block) => !translatable(block)),
    pageHeight,
    pageWidth,
    pageIndex,
    obstacles,
  };
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
  for (const row of rows) {
    const cells = splitRowCells(row);
    if (cells.length < 2) continue;
    if (!cells.every((cell) => cellText(cell).length <= CELL_MAX_CHARS)) return false;
    wide += 1;
  }
  return wide >= Math.max(2, rows.length * TABLE_ROW_SHARE);
}

function cellText(cell: readonly TextLine[]): string {
  return cell
    .map((line) => line.text)
    .join(' ')
    .trim();
}

/** Splits one row where a gap is wider than a word space. */
function splitRowCells(row: readonly TextLine[]): TextLine[][] {
  const cells: TextLine[][] = [];
  let current: TextLine[] = [];

  for (const line of row) {
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
      const splits =
        gap > SEGMENT_GAP * scale &&
        !startsRunIn(line) &&
        (previous.text.trim().length > 3 || gap > scale * 3);
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

  const emit = (lines: readonly TextLine[], room: Box, column: number, columnLeft: number) => {
    const block = buildBlock(
      lines,
      room,
      column,
      bodySize,
      figures,
      columnLeft,
      pageHeight,
      pageIndex,
    );
    if (block) out.push(block);
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
  for (const [index, row] of rest.entries()) {
    const rowCells = splitRowCells(row);
    for (const cell of rowCells) {
      cells.push({ lines: cell, row: index, shared: isTable && rowCells.length > 1 });
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

    for (const cell of column.cells) {
      const previous = current[current.length - 1];
      const next = cell.lines[0];
      // A table cell always starts a block: its row ends there, so the next row's value in the
      // same column is a different thing however evenly the rows are pitched. A wrapped cell
      // is a continuation row with one cell, so it joins the block above it.
      const starts =
        cell.shared ||
        (previous !== undefined && next !== undefined && gapStartsBlock(previous, next, leading));
      if (previous && next && starts) {
        emit(current, room, region.column, columnLeft);
        current = [];
      }
      current.push(...cell.lines);
    }

    emit(current, room, region.column, columnLeft);
  }
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
    if (
      captions.length > 0 &&
      cells.length < 2 &&
      !isTableHeaderLine(text) &&
      !isCaptionLine(text) &&
      (text.length > 24 || /^[\p{Ll}]/u.test(text))
    ) {
      captions.push(row);
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
    for (const column of columns) {
      const left = median(column.lefts);
      const right = median(column.rights);
      const shared = Math.min(right, boxRight(box)) - Math.max(left, box.x);
      if (shared <= 0) continue;
      const narrower = Math.min(right - left, box.width);
      const ratio = narrower > 0 ? shared / narrower : 0;
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
    ratios.push(gap / Math.max(after.height, 1));
  }
  return ratios.length > 0 ? median(ratios) : 1.35;
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
function gapStartsBlock(previous: TextLine, line: TextLine, leading: number): boolean {
  const scale = Math.max(line.height, previous.height, 1);
  const gap = (line.baseline - previous.baseline) / scale;
  if (gap > leading * PARAGRAPH_RATIO) return true;
  if (gap < -0.7) return true;

  const previousMath = previous.mathRatio >= EQUATION_LINE_SHARE;
  const lineMath = line.mathRatio >= EQUATION_LINE_SHARE;
  if (previousMath !== lineMath) return true;
  // A formula whose function names are set in the text face does not reach the math share, so
  // the boundary is also drawn where a line is indented away from the column's left edge and
  // its predecessor was not: typesetting centres a display equation, and a paragraph does not
  // start in the middle of its column.
  // Display formulas sit several ems in from the column. A hanging indent (a wrapped
  // reference, a first-line paragraph indent) is one or two ems and must stay in the block;
  // cutting there left each wrapped line as its own 8pt box with no room to grow.
  const indent = Math.max(previous.height, line.height) * 3;
  if (line.box.x > previous.box.x + indent) return true;
  // The reverse: a centred formula is followed by a line that returns to the column wall.
  // Without this, the sentence under the formula joined it and the whole block was then
  // either translated (replacing the mathematics) or skipped (taking the sentence with it).
  if (previous.box.x > line.box.x + indent) return true;

  const sizeChange = Math.abs(line.height - previous.height) / Math.max(previous.height, 1);
  if (sizeChange > SIZE_CHANGE) return true;

  const previousBold = previous.pieces.length > 0 && previous.pieces.every((piece) => piece.bold);
  const lineBold = line.pieces.length > 0 && line.pieces.every((piece) => piece.bold);
  // A weight change splits a block only when the two lines are on different rows. A run-in
  // heading — `Attention variants` set in bold, then the sentence it introduces, on the same
  // line — is one paragraph with a bold opening, and splitting it put a heading block and a
  // body block at the same y: both then claimed the column's measure and printed over each
  // other. `gap` is the baseline distance in ems, so a value near zero means the same row.
  if (previousBold && !lineBold && gap > 0.4) return true;

  // A numbered caption followed by a table header is two blocks, even when the leading
  // between them is no wider than a wrapped line.
  if (isCaptionLine(previous.text) && isTableHeaderLine(line.text)) return true;

  return false;
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
  const box = unionBox(lines.map((line) => line.box));
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
  };
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
  if (isCodeBlock(lines)) return 'code';
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
  // A caption or numbered heading is recognised before the figure test, because a drawing's
  // bounding box often swallows the line under it. That line is still a caption.
  if (isCaptionLine(text)) return 'caption';
  if (/^(?:[IVXLC]+\.|[A-Z]\.|\d+(?:\.\d+)*\.?)\s+\p{Lu}/u.test(text) && lines.length <= 2) {
    return 'heading';
  }
  // Text the page drew inside a picture. Axis ticks and lone symbols stay on the drawing;
  // a short word that names a box (`Encoder`, `Training loss`) is a label the reader does
  // want translated, fitted tightly so the rest of the picture is not covered.
  if (lines.length > 0 && lines.every((line) => insideFigure(line, figures))) {
    if (isTick(text) || fontSize < MIN_TRANSLATE_PT) return 'figure-label';
    return 'label';
  }
  if (bodySize > 0 && fontSize >= bodySize * 1.08) return 'heading';
  // A bold run of one or two lines above the body is a heading, even when the typesetter
  // gave it the body's size.
  if (bold && lines.length <= 2) return 'heading';
  if (lines.length === 1 && text.length <= 32 && !/[.!?]$/u.test(text)) return 'label';
  return 'prose';
}

/**
 * True when these lines are a listing rather than a paragraph: mostly a monospaced face,
 * more than one line, and not a caption. Translating source code produces a wrong program,
 * which is worse than leaving the listing as drawn.
 */
function isCodeBlock(lines: readonly TextLine[]): boolean {
  if (lines.length < 2) return false;
  const pieces = lines.flatMap((line) => line.pieces);
  if (pieces.length === 0) return false;
  const mono = pieces.filter((piece) => piece.family === 'monospace').length;
  if (mono * 2 < pieces.length) return false;
  const text = lines.map((line) => line.text).join(' ');
  if (isCaptionLine(text)) return false;
  return true;
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
