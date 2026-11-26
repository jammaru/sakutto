import { boxBottom, boxRight, type Box } from './geometry';
import type { TextLine } from './lines';

/**
 * The gap profile of a page: every empty band between two rows of lines, and every empty
 * band between two columns of them, widest first. The layout cut reads this instead of
 * asking one question at a time, because a page's own structure is easier to see as a list
 * of gaps than as a chain of yes/no decisions.
 */
export interface Gap {
  /** Position of the band's middle, in page units. */
  at: number;
  gap: number;
}

export interface GapProfile {
  horizontalProfile: Gap[];
  verticalProfile: Gap[];
  horizontal: Gap;
  vertical: Gap;
}

const EMPTY: Gap = { at: 0, gap: 0 };

/** Every band between two rows of lines that no line crosses, widest first. */
export function horizontalGaps(lines: readonly TextLine[]): Gap[] {
  const ordered = [...lines].sort((left, right) => left.box.y - right.box.y);
  const gaps: Gap[] = [];
  let bottom = -Infinity;
  for (const line of ordered) {
    if (Number.isFinite(bottom) && line.box.y > bottom) {
      gaps.push({ at: (line.box.y + bottom) / 2, gap: line.box.y - bottom });
    }
    bottom = Math.max(bottom, boxBottom(line.box));
  }
  return gaps.sort((left, right) => right.gap - left.gap);
}

/**
 * Every band no line's horizontal span covers, widest first. Spans are merged into
 * intervals, so a gutter is found even when the two columns have different numbers of lines.
 */
export function verticalGaps(lines: readonly TextLine[], limit: Box): Gap[] {
  const spans = lines
    .map((line) => ({ left: line.box.x, right: boxRight(line.box) }))
    .sort((left, right) => left.left - right.left);
  const gaps: Gap[] = [];
  let right = -Infinity;
  for (const span of spans) {
    if (Number.isFinite(right) && span.left > right) {
      gaps.push({ at: (span.left + right) / 2, gap: span.left - right });
    }
    right = Math.max(right, span.right);
  }
  // The margins are gaps too, and a page whose text stops short of its own box has one on
  // the side. They are reported so a cut can use them without special-casing an edge.
  if (limit.width > 0) {
    const first = spans[0];
    const left = first ? first.left : limit.x;
    if (left > limit.x + 1) gaps.push({ at: (left + limit.x) / 2, gap: left - limit.x });
    const edge = limit.x + limit.width;
    if (edge > right + 1) gaps.push({ at: (edge + right) / 2, gap: edge - right });
  }
  return gaps.sort((left, right) => right.gap - left.gap);
}

export function widestGaps(
  lines: readonly TextLine[],
  limit: Box = { x: 0, y: 0, width: 0, height: 0 },
): GapProfile {
  const horizontalProfile = horizontalGaps(lines);
  const verticalProfile = verticalGaps(lines, limit);
  return {
    horizontalProfile,
    verticalProfile,
    horizontal: horizontalProfile[0] ?? EMPTY,
    vertical: verticalProfile[0] ?? EMPTY,
  };
}

/** How many rows of a page support a column boundary at one x position. */
export interface GutterCandidate {
  /** Position of the gutter's middle, in page units. */
  at: number;
  /** Width of the clear band at its narrowest point among the rows that have it. */
  width: number;
  /** Rows that are split in two at this position. */
  rows: number;
  /** Rows that run straight across it — a full-width title, a caption, a wide formula. */
  crossings: number;
}

/**
 * A column boundary detected from horizontal line spans rather than baseline-aligned pairs.
 * Used when two columns have slightly different line leading so their baselines drift apart.
 */
export interface StaggeredGutterCandidate {
  /** Position of the gutter's middle, in page units. */
  at: number;
  /** Clear width between the rightmost left-column line and leftmost right-column line. */
  width: number;
  /** Horizontal span of the left column, in page units. */
  leftWidth: number;
  /** Horizontal span of the right column, in page units. */
  rightWidth: number;
  /** Lines strictly to the left of the gutter. */
  leftCount: number;
  /** Lines strictly to the right of the gutter. */
  rightCount: number;
  /** Left-column lines that sit inside the vertical band shared with the right column. */
  overlapLeft: number;
  /** Right-column lines that sit inside the vertical band shared with the left column. */
  overlapRight: number;
  /** Vertical overlap between the two columns, in page units. */
  overlapHeight: number;
  /** Lines whose horizontal span crosses or falls inside the gutter. */
  crossings: number;
}

/**
 * Finds the vertical gutters of a page by counting rows, not by looking for a band no line
 * crosses.
 *
 * A two-column paper is not a single empty band: its title, its abstract and its wide figures
 * run straight across both columns, so there is no x that every line avoids. Requiring one is
 * why the first page of a survey read as a single column, with the stamp and the abstract
 * merged into one paragraph.
 *
 * What a gutter really is, is a position where most rows are split and only a few run across.
 * Each row's own gaps are collected, the positions are clustered, and a cluster that most rows
 * agree on becomes the boundary. `crossings` says how many rows will be cut out of both columns
 * and read on their own, which is what a full-width title is.
 */
export function gutterCandidates(lines: readonly TextLine[], unit: number): GutterCandidate[] {
  const rows = groupByBaseline(lines);
  if (rows.length < 3) return [];

  const tolerance = Math.max(2, unit * 0.9);
  const clusters: { at: number; width: number; rows: number }[] = [];

  for (const row of rows) {
    const ordered = [...row].sort((left, right) => left.box.x - right.box.x);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (!previous || !current) continue;
      const left = boxRight(previous.box);
      const right = current.box.x;
      const width = right - left;
      if (width < unit * 0.55) continue;
      const at = (left + right) / 2;
      const found = clusters.find((cluster) => Math.abs(cluster.at - at) <= tolerance);
      if (found) {
        found.at = (found.at * found.rows + at) / (found.rows + 1);
        found.width = Math.max(found.width, width);
        found.rows += 1;
        continue;
      }
      clusters.push({ at, width, rows: 1 });
    }
  }

  return clusters
    .map((cluster) => ({
      at: cluster.at,
      width: cluster.width,
      rows: cluster.rows,
      crossings: rows.length - cluster.rows,
    }))
    .sort((left, right) => right.rows - left.rows || right.width - left.width);
}

/**
 * Finds vertical gutters from line horizontal extents without requiring left and right lines
 * to share a baseline.
 *
 * When a two-column page uses slightly different leading in each column (or a heading shifts
 * one column's vertical rhythm), `groupByBaseline` puts left and right lines into separate
 * single-line rows so `gutterCandidates` sees too few paired rows. Scanning candidate split
 * positions directly recovers the column boundary while tracking vertical overlap so disjoint
 * top/bottom regions are never misread as side-by-side columns.
 */
export function staggeredGutterCandidates(
  lines: readonly TextLine[],
  unit: number,
): StaggeredGutterCandidate[] {
  if (lines.length < 4) return [];

  const minWidth = unit;
  const isInlinePrefix = (line: TextLine): boolean =>
    line.text.trim().length <= 3 &&
    line.box.width <= unit * 2.5 &&
    lines.some(
      (peer) =>
        peer !== line &&
        Math.abs(peer.baseline - line.baseline) <= Math.max(peer.height, line.height) * 0.4 &&
        peer.box.x > boxRight(line.box) &&
        peer.box.x - boxRight(line.box) <= unit * 1.6,
    );
  const edges: number[] = [];
  for (const right of lines
    .filter((line) => !isInlinePrefix(line))
    .map((line) => boxRight(line.box))
    .sort((a, b) => a - b)) {
    const previous = edges[edges.length - 1];
    if (previous === undefined || right - previous > 0.5) edges.push(right);
  }

  const candidates: StaggeredGutterCandidate[] = [];
  for (const edge of edges) {
    const left: TextLine[] = [];
    const right: TextLine[] = [];
    for (const line of lines) {
      if (boxRight(line.box) <= edge + 0.5) left.push(line);
      else if (line.box.x >= edge + minWidth - 0.5) right.push(line);
    }
    if (left.length < 2 || right.length < 2) continue;

    let leftMinX = Infinity;
    let leftWall = -Infinity;
    let leftTop = Infinity;
    let leftBottom = -Infinity;
    for (const line of left) {
      leftMinX = Math.min(leftMinX, line.box.x);
      leftWall = Math.max(leftWall, boxRight(line.box));
      leftTop = Math.min(leftTop, line.box.y);
      leftBottom = Math.max(leftBottom, boxBottom(line.box));
    }

    let rightWall = Infinity;
    let rightMaxX = -Infinity;
    let rightTop = Infinity;
    let rightBottom = -Infinity;
    for (const line of right) {
      rightWall = Math.min(rightWall, line.box.x);
      rightMaxX = Math.max(rightMaxX, boxRight(line.box));
      rightTop = Math.min(rightTop, line.box.y);
      rightBottom = Math.max(rightBottom, boxBottom(line.box));
    }

    const width = rightWall - leftWall;
    if (width < minWidth) continue;

    const at = (leftWall + rightWall) / 2;
    if (candidates.some((existing) => Math.abs(existing.at - at) <= 1)) continue;

    const overlapTop = Math.max(leftTop, rightTop);
    const overlapBottom = Math.min(leftBottom, rightBottom);
    const overlapHeight = Math.max(0, overlapBottom - overlapTop);
    let overlapLeft = 0;
    let overlapRight = 0;
    if (overlapHeight > 0) {
      // Count only lines that genuinely sit side-by-side with a line in the opposite column.
      // Alternating single-column lines (such as unindented vs indented code lines) share an
      // overall y-range but have zero pairwise vertical overlap.
      for (const l of left) {
        if (right.some((r) => boxBottom(l.box) > r.box.y && l.box.y < boxBottom(r.box))) {
          overlapLeft += 1;
        }
      }
      for (const r of right) {
        if (left.some((l) => boxBottom(r.box) > l.box.y && r.box.y < boxBottom(l.box))) {
          overlapRight += 1;
        }
      }
    }

    candidates.push({
      at,
      width,
      leftWidth: Math.max(0, leftWall - leftMinX),
      rightWidth: Math.max(0, rightMaxX - rightWall),
      leftCount: left.length,
      rightCount: right.length,
      overlapLeft,
      overlapRight,
      overlapHeight,
      crossings: lines.length - left.length - right.length,
    });
  }

  return candidates.sort((a, b) => {
    const scoreA = a.leftCount + a.rightCount - a.crossings;
    const scoreB = b.leftCount + b.rightCount - b.crossings;
    if (scoreB !== scoreA) return scoreB - scoreA;
    const minOverlapA = Math.min(a.overlapLeft, a.overlapRight);
    const minOverlapB = Math.min(b.overlapLeft, b.overlapRight);
    if (minOverlapB !== minOverlapA) return minOverlapB - minOverlapA;
    return b.width - a.width;
  });
}

/** A one-to-three character run that can be a superscript or subscript marker. */
function scriptFragment(line: TextLine): boolean {
  const text = line.text.trim();
  return text.length > 0 && text.length <= 3 && /^[\p{L}\p{N}]+$/u.test(text);
}

/**
 * True when a line shares the anchor's row.
 *
 * Ordinary lines keep the original per-line tolerance. A script run is smaller or merely a
 * short marker shifted off the baseline, so it also joins when its em box still overlaps the
 * anchor; without that, a raised marker sorted first becomes a row of its own.
 */
function sameRow(anchor: TextLine, line: TextLine): boolean {
  const shift = Math.abs(line.baseline - anchor.baseline);
  if (shift <= Math.max(0.6, line.height * 0.4)) return true;
  const scale = Math.max(anchor.height, line.height, 1);
  if (
    Math.min(anchor.height, line.height) > scale * 0.85 &&
    !scriptFragment(anchor) &&
    !scriptFragment(line)
  ) {
    return false;
  }
  if (shift > scale * 0.8) return false;
  const overlap =
    Math.min(boxBottom(anchor.box), boxBottom(line.box)) - Math.max(anchor.box.y, line.box.y);
  return overlap > Math.min(anchor.height, line.height) * 0.1;
}

/** Lines grouped by the baseline they sit on, which is what a row of a page is. */
export function groupByBaseline(lines: readonly TextLine[]): TextLine[][] {
  const ordered = [...lines].sort(
    (left, right) => left.baseline - right.baseline || left.box.x - right.box.x,
  );
  const rows: TextLine[][] = [];
  let current: TextLine[] = [];
  let anchor: TextLine | null = null;

  for (const line of ordered) {
    if (current.length > 0 && anchor !== null && sameRow(anchor, line)) {
      current.push(line);
      continue;
    }
    if (current.length > 0) rows.push(current);
    current = [line];
    anchor = line;
  }
  if (current.length > 0) rows.push(current);
  return rows;
}
