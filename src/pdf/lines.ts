import { boxBottom, boxRight, median, type Box } from './geometry';

/**
 * One run of text a PDF draws in a single operation, converted to top-left space.
 *
 * `height` is the font size from the page's own text state rather than the box pdf.js reports,
 * and `baseline` is where the glyphs sit in page space. Keeping the baseline lets the renderer
 * align a substitute font on the same line as the source glyphs, which is the difference
 * between a page that reads like the original and one where every line sits a couple of
 * points too high.
 */
export interface TextPiece {
  text: string;
  box: Box;
  baseline: number;
  fontName: string;
  /** CSS generic family pdf.js reports for the font: `serif`, `sans-serif`, `monospace`. */
  family: string;
  bold: boolean;
  italic: boolean;
  /**
   * The piece is set in a typesetting math font, so it is part of an equation rather than a
   * sentence. Kept per piece because a line of prose can end with an inline formula: the
   * question the layout asks is how much of the line is mathematics, not whether any of it is.
   */
  math: boolean;
  /**
   * The text runs upwards or downwards rather than across, in degrees clockwise: 90 is a
   * label rotated to run down the page, 270 one that runs up.
   *
   * A paper uses this for a stamp — a repository identifier written up the left margin — and
   * for a handful of axis labels. Such text is almost never prose: it is a fixed string that
   * must not be translated, and its box spans the whole column, so leaving it in the page's
   * line grouping is what reads a stamp into the middle of a paragraph.
   */
  orientation: number;
  /**
   * Font size in viewport space, from the text matrix rather than the axis-aligned box.
   *
   * `/Rotate 90` and `/Rotate 270` swap the box so `height` is the advance, not the em, and
   * grouping by that height would treat a column as one line.
   */
  size: number;
  /**
   * Writing direction after the page viewport is applied, in degrees clockwise.
   *
   * Distinct from `orientation`, which is the text matrix alone so a page `/Rotate` does not
   * mark body text as a stamp. `displayed` is what wrapping and painting use: 90 and 270 mean
   * the line's advance sits on the box's height.
   */
  displayed: number;
}

/** A run of pieces a reader reads as one line, left to right. */
export interface TextLine {
  text: string;
  box: Box;
  baseline: number;
  /** Font size of the line: the largest piece, so a superscript does not shrink it. */
  height: number;
  pieces: TextPiece[];
  /**
   * Share of the line's characters set in a math font, from 0 to 1.
   *
   * A display equation is entirely math faces and scores near 1; a sentence that names a
   * variable scores low. On its own this is not enough to tell an equation from a sentence
   * full of symbols — a survey's prose can be half notation — which is what `proseChars`
   * measures.
   */
  mathRatio: number;
  /**
   * Characters set in an ordinary text face, which is what a sentence is made of.
   *
   * The count, not the share, because the question "is this a sentence?" is answered by how
   * much real language is in it. A display equation has a handful of such characters at most
   * — `Diag`, `Sigmoid`, a comma — while a line that says "with query and key vectors" has
   * dozens even when its math share is high.
   */
  proseChars: number;
}

/** Characters in `pieces` that sit in a math font, over every character in them. */
function mathShare(pieces: readonly TextPiece[]): { ratio: number; proseChars: number } {
  let math = 0;
  let all = 0;
  let prose = 0;
  for (const piece of pieces) {
    const length = piece.text.length;
    all += length;
    if (piece.math) math += length;
    else if (/\p{L}/u.test(piece.text)) prose += length;
  }
  return { ratio: all === 0 ? 0 : math / all, proseChars: prose };
}

/** A word space the PDF did not draw is this wide, in ems. */
const WORD_GAP = 0.14;
/** Two pieces share a line when their baselines differ by less than this fraction of the em. */
const SAME_BASELINE = 0.4;
/**
 * A gap this wide separates two things that are not words of one line: a column gutter, a
 * table cell boundary, a label set apart from its value. Written in ems, because both scale
 * with the type.
 *
 * The value comes from measuring a justified two-column paper. A word space inside a
 * justified line reaches about 0.65 em before the typesetter would rather hyphenate, and the
 * narrowest real boundary in a table header was 0.97 em, so the threshold sits between them.
 */
export const SEGMENT_GAP = 0.8;

function em(piece: TextPiece): number {
  const { width, height } = piece.box;
  // Prefer the text-matrix size. After a page rotate the AABB swaps, so `height` is the
  // advance; fall back to the shorter side when a fixture omitted `size`.
  return Math.max(0.1, piece.size || Math.min(width, height) || height);
}

function gapBetween(left: Box, right: Box): number {
  return right.x - boxRight(left);
}

/**
 * Joins the pieces of one line. A PDF stores text as runs, and where a word space falls
 * between two runs it is often simply absent: the reader sees `the reader's` because the
 * next run starts a little further right. The gap is the only evidence, so a run separated
 * by more than a fifth of an em gets a space and runs that touch get none.
 *
 * A run written vertically is joined without spaces: its pieces are one letter each, stacked,
 * and a space between them would be a space between the letters of a word.
 */
export function joinPieces(pieces: readonly TextPiece[]): string {
  let output = '';
  let previous: TextPiece | null = null;

  for (const piece of pieces) {
    const value = piece.text;
    if (previous === null) {
      output = value;
      previous = piece;
      continue;
    }
    if (previous.orientation !== 0) {
      output += value;
      previous = piece;
      continue;
    }
    const gap = gapBetween(previous.box, piece.box);
    const scale = Math.min(em(previous), em(piece));
    const needsSpace =
      gap > WORD_GAP * scale &&
      value.length > 0 &&
      output.length > 0 &&
      !/\s$/u.test(output) &&
      !/^\s/u.test(value);
    output += needsSpace ? ` ${value}` : value;
    previous = piece;
  }

  return output.replace(/\s+/gu, ' ').trim();
}

export function lineFrom(pieces: TextPiece[]): TextLine {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  let height = 0;
  for (const piece of pieces) {
    left = Math.min(left, piece.box.x);
    right = Math.max(right, boxRight(piece.box));
    top = Math.min(top, piece.box.y);
    bottom = Math.max(bottom, boxBottom(piece.box));
    height = Math.max(height, em(piece));
  }
  const joined = joinPieces(pieces);
  const share = mathShare(pieces);
  return {
    text: joined,
    box: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0.1, bottom - top) },
    baseline: pieces[0]?.baseline ?? bottom,
    height: Math.max(0.1, height),
    pieces,
    mathRatio: share.ratio,
    proseChars: share.proseChars,
  };
}

/** Pieces in the order a reader meets them: down the page, then left to right. */
function readingOrder(pieces: readonly TextPiece[]): TextPiece[] {
  return [...pieces].sort((left, right) => {
    const dy = right.baseline - left.baseline;
    if (Math.abs(dy) > 0.4) return dy;
    return left.box.x - right.box.x;
  });
}

/**
 * Turns the pieces of one page into lines.
 *
 * Two pieces belong to the same line when they sit on the same baseline, which is exact for
 * text and differs by the whole leading for the line below. A line is then split wherever
 * the gap between two runs is wider than a word space: those gaps are the page's own
 * structure, a column gutter or the white space between two table cells, and joining across
 * one reads the right column's words into the left column's sentence.
 *
 * Text written at an angle is grouped on its own. A vertical stamp down the margin shares no
 * baseline with the body — every one of its letters is on a different one — so the normal rule
 * would either drop it or merge it, and either way the stamp ends up inside a paragraph.
 */
export function groupLines(pieces: readonly TextPiece[]): TextLine[] {
  const upright: TextPiece[] = [];
  const rotated: TextPiece[] = [];
  for (const piece of pieces) {
    if (piece.text.trim().length === 0) continue;
    if (piece.orientation === 0) upright.push(piece);
    else rotated.push(piece);
  }

  return [...uprightLines(upright), ...rotatedLines(rotated)].sort(
    (left, right) => left.box.y - right.box.y || left.box.x - right.box.x,
  );
}

function uprightLines(pieces: readonly TextPiece[]): TextLine[] {
  const ordered = readingOrder(pieces);
  if (ordered.length === 0) return [];

  const rows: TextPiece[][] = [];
  for (const piece of ordered) {
    const row = rows[rows.length - 1];
    const anchor = row?.[0];
    if (row && anchor && Math.abs(piece.baseline - anchor.baseline) <= SAME_BASELINE * em(anchor)) {
      row.push(piece);
      continue;
    }
    rows.push([piece]);
  }

  const lines: TextLine[] = [];
  for (const row of rows) {
    // A row can collect runs from two columns whose baselines differ by a fraction of the em.
    // They are grouped as one row here and separated below, so the row has to be in x order
    // before the gaps between the columns are measured.
    row.sort((left, right) => left.box.x - right.box.x);
    let run: TextPiece[] = [];
    for (const piece of row) {
      const previous = run[run.length - 1];
      if (previous && gapBetween(previous.box, piece.box) > SEGMENT_GAP * em(piece)) {
        const line = lineFrom(run);
        if (line.text.length > 0) lines.push(line);
        run = [piece];
        continue;
      }
      run.push(piece);
    }
    if (run.length > 0) {
      const line = lineFrom(run);
      if (line.text.length > 0) lines.push(line);
    }
  }

  return lines;
}

/**
 * Groups rotated text into runs of its own.
 *
 * A vertical stamp is drawn one letter per operation, each on its own baseline, so the usual
 * baseline test puts every letter in a separate line and the layout below then treats each as
 * a one-letter block. Grouping by proximity along the writing direction turns the whole stamp
 * into the one line it is, which is what lets the reader leave it alone.
 */
function rotatedLines(pieces: readonly TextPiece[]): TextLine[] {
  if (pieces.length === 0) return [];

  const runs: TextPiece[][] = [];
  const ordered = [...pieces].sort((left, right) => {
    if (left.orientation !== right.orientation) return left.orientation - right.orientation;
    return left.orientation === 90 ? right.box.y - left.box.y : left.box.y - right.box.y;
  });

  for (const piece of ordered) {
    const run = runs[runs.length - 1];
    const previous = run?.[run.length - 1];
    if (previous && canJoinRotated(previous, piece)) {
      run.push(piece);
      continue;
    }
    runs.push([piece]);
  }

  return runs.map((run) => lineFrom(run)).filter((line) => line.text.length > 0);
}

function canJoinRotated(previous: TextPiece, piece: TextPiece): boolean {
  if (previous.orientation !== piece.orientation) return false;
  const scale = Math.max(em(previous), em(piece));
  if (Math.abs(previous.baseline - piece.baseline) > scale * 1.6) return false;
  // Along the writing direction: 90° runs downwards, 270° runs upwards.
  const along =
    piece.orientation === 90
      ? previous.box.y - (piece.box.y + piece.box.height)
      : piece.box.y - (previous.box.y + previous.box.height);
  return along >= -scale * 0.6 && along <= scale * 1.6;
}

/** The most common font size on the page, weighted by how many letters are set in it. */
export function bodyFontSize(lines: readonly TextLine[]): number {
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

/** The gap between the baselines of consecutive lines of one paragraph, per page. */
export function leadingOf(lines: readonly TextLine[]): number {
  const deltas: number[] = [];
  for (const line of lines) {
    if (deltas.length > 400) break;
    deltas.push(line.height);
  }
  const size = median(deltas) || 10;
  return size * 1.35;
}

/** True when every piece of the line was written at an angle. */
export function isRotated(line: TextLine): boolean {
  return line.pieces.length > 0 && line.pieces.every((piece) => piece.orientation !== 0);
}
