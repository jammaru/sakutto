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

/** Lines grouped by the baseline they sit on, which is what a row of a page is. */
export function groupByBaseline(lines: readonly TextLine[]): TextLine[][] {
  const ordered = [...lines].sort(
    (left, right) => left.baseline - right.baseline || left.box.x - right.box.x,
  );
  const rows: TextLine[][] = [];
  let current: TextLine[] = [];
  let anchor = 0;

  for (const line of ordered) {
    if (
      current.length > 0 &&
      Math.abs(line.baseline - anchor) <= Math.max(0.6, line.height * 0.4)
    ) {
      current.push(line);
      continue;
    }
    if (current.length > 0) rows.push(current);
    current = [line];
    anchor = line.baseline;
  }
  if (current.length > 0) rows.push(current);
  return rows;
}
