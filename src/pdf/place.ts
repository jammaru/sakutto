import { fitText, growBudgetFor, type FitResult } from './fit';
import { intersectionArea, type Box } from './geometry';
import { verticalWriting, type AnyBlockRole, type LayoutBlock, type PageLayout } from './layout';

/** Space kept clear at the foot of a page, in points, so a last paragraph cannot run off it. */
export const PAGE_FOOT_MARGIN = 28;

/** Two boxes that share this much area, in square points, are treated as overlapping. */
export const OVERLAP_AREA = 1;
/** White space kept at a box's right edge so two columns never touch, in points. */
const GUTTER_CLEARANCE = 4;

export interface PlaceRequest {
  layout: PageLayout;
  translationOf: (block: LayoutBlock) => string;
  target: 'ja' | 'en' | 'other';
  measure: (block: LayoutBlock, text: string, fontSize: number) => number;
  /** Page height in points. 0 means "unknown": growth then uses the default allowance. */
  pageHeight: number;
  /** Page width in points. 0 means wrapping stays inside the block's own room. */
  pageWidth?: number;
}

export interface PlacedBlock {
  block: LayoutBlock;
  translation: string;
  fit: FitResult | null;
  /**
   * False when the translation must not be drawn: it did not fit, it would cover another
   * block, or restoring an inline formula failed. The original typesetting stays visible.
   */
  paint: boolean;
  /**
   * True when a translation exists but is not painted in place. The reader shows a marker
   * that opens the full translation, so the page never displays a cut sentence.
   */
  overflow: boolean;
  /** The box that would be drawn, in page points, or null when `paint` is false. */
  drawn: Box | null;
}

/**
 * Fits every translated block of a page and drops any that would cover another.
 *
 * This is the layout-only path the tests run: no engine, no DOM. The reader uses the same
 * grow and overlap rules so a green unit test is the same decision a painted page makes.
 */
export function placePage(request: PlaceRequest): PlacedBlock[] {
  const obstacles = pageObstacles(request.layout);
  const pageWidth = request.pageWidth ?? request.layout.pageWidth ?? 0;

  const placed: PlacedBlock[] = request.layout.blocks.map((block) => {
    const translation = request.translationOf(block).trim();
    if (translation.length === 0) {
      return { block, translation: '', fit: null, paint: false, overflow: false, drawn: null };
    }
    const width = wrapWidth(block, obstacles, pageWidth);
    const measureAt = (text: string, size: number) => request.measure(block, text, size);
    const fit = fitText(
      {
        box: fitBox(block, width),
        growBudget: verticalWriting(block)
          ? 0
          : pageGrowBudget(block, obstacles, request.pageHeight),
        fontSize: block.fontSize,
        lineHeight: block.lineHeight,
        width,
        measure: measureAt,
        role: block.role,
      },
      translation,
      request.target,
    );
    // A translation that does not fit is not shown in place. Cutting it short would be a
    // wrong translation. The full text is kept for a marker the reader can open.
    if (!fit.fits || lineOverflows(fit, width, (text) => measureAt(text, fit.fontSize))) {
      return { block, translation, fit, paint: false, overflow: true, drawn: null };
    }
    const drawn = drawnBox(block, fit, width, pageWidth);
    if (exceedsPage(drawn, pageWidth, request.pageHeight)) {
      return { block, translation, fit, paint: false, overflow: true, drawn: null };
    }
    return {
      block,
      translation,
      fit,
      paint: true,
      overflow: false,
      drawn,
    };
  });

  return resolveOverlaps(placed);
}

/** Every box that occupies space on the page: translatable blocks, skipped blocks, figures. */
export function pageObstacles(layout: PageLayout): Box[] {
  return [
    ...layout.blocks.map((block) => block.box),
    ...layout.skipped.map((block) => block.box),
    ...(layout.obstacles ?? []),
  ];
}

/** Room below a block on its page, in points. Cells and labels do not grow; they use a marker. */
export function pageGrowBudget(
  block: Pick<LayoutBlock, 'box' | 'room' | 'role' | 'fontSize'>,
  neighbours: readonly Box[],
  pageHeight: number,
): number {
  const foot = pageHeight > 0 ? Math.max(0, pageHeight - PAGE_FOOT_MARGIN) : Infinity;
  const others = neighbours.filter((candidate) => candidate !== block.box);
  const room = growBudgetFor(block.box, others, block.room.x + block.room.width, foot);
  if (block.role === 'prose' || block.role === 'caption') return room;
  // A title that wraps to one extra line is still the title; longer than that opens a marker.
  if (block.role === 'heading') return Math.min(room, Math.max(block.fontSize * 1.4, 12));
  return 0;
}

/**
 * Width the translation wraps to. A little narrower than the room, so a canvas measurement
 * that disagrees with the CSS shaper by a hair still lands inside the painted box instead of
 * overflowing it and being clipped.
 *
 * Body text may also use unused space to the right — a column gutter, the side of a short
 * last line — up to the next obstacle, so a translation that is only slightly longer does
 * not have to wrap to a second line.
 */
export function wrapWidth(
  block: Pick<LayoutBlock, 'box' | 'room' | 'role' | 'advance' | 'writing'>,
  obstacles: readonly Box[] = [],
  pageWidth = 0,
): number {
  if (verticalWriting(block)) return Math.max(1, block.advance);
  const base = Math.max(1, block.room.width, block.box.width, block.advance);
  const tight = Math.max(1, base * 0.96);
  if (block.role !== 'prose' && block.role !== 'caption' && block.role !== 'heading') {
    return tight;
  }

  let right = pageWidth > 0 ? pageWidth - GUTTER_CLEARANCE : Infinity;
  const top = block.box.y;
  const bottom = block.box.y + block.box.height;
  for (const obstacle of obstacles) {
    if (obstacle === block.box) continue;
    if (obstacle.x + 1 < block.box.x + block.box.width) continue;
    if (obstacle.y + obstacle.height < top + 1) continue;
    if (obstacle.y > bottom - 1) continue;
    right = Math.min(right, obstacle.x);
  }
  const extra = right - GUTTER_CLEARANCE - block.box.x;
  if (!Number.isFinite(extra) || extra <= tight) {
    return capToPage(Math.max(1, base * 0.98), block.box.x, pageWidth);
  }
  // Never take more than a modest share past the source measure, so a paragraph cannot
  // walk into the next column when that column's first line happens to sit lower.
  return capToPage(Math.max(1, Math.min(extra, base * 1.28, tight * 1.22)), block.box.x, pageWidth);
}

export function drawnBox(block: LayoutBlock, fit: FitResult, wrap = 0, pageWidth = 0): Box {
  if (verticalWriting(block)) {
    const cross = Math.max(block.box.width, fit.height);
    const along = Math.max(block.box.height, wrap, block.advance);
    return { x: block.box.x, y: block.box.y, width: cross, height: along };
  }
  const height = fit.fits
    ? Math.max(block.box.height, fit.height)
    : Math.max(block.box.height, fit.visibleLines.length * fit.lineHeight);
  const x = Math.min(block.box.x, block.room.x);
  const width = capToPage(
    Math.max(block.room.width, block.box.width, wrap, block.advance),
    x,
    pageWidth,
  );
  return {
    x,
    y: block.box.y,
    width,
    height,
  };
}

/** Box `fitText` measures against: for a page-rotated line the em is the height budget. */
export function fitBox(block: LayoutBlock, wrap: number): Box {
  if (!verticalWriting(block)) return block.box;
  const em = Math.min(block.box.width, block.box.height);
  return { x: block.box.x, y: block.box.y, width: wrap, height: Math.max(0.1, em) };
}

const WIDTH_SLACK = 1;

/** True when a fitted line is wider than the width wrapping was asked to honour. */
export function lineOverflows(
  fit: FitResult,
  width: number,
  measure: (text: string) => number,
): boolean {
  const lines = fit.fits ? fit.lines : fit.visibleLines;
  for (const line of lines) {
    if (measure(line) > width + WIDTH_SLACK) return true;
  }
  return false;
}

/**
 * Extra width painted lines occupy beyond the box they are drawn in, in points.
 *
 * Horizontal writing is clipped by `drawn.width`. Vertical writing is wrapped to `fit.width`
 * and then rotated, so that wrap width is the edge that must not be crossed.
 */
export function clippedPaintWidth(
  entry: PlacedBlock,
  measure: (text: string, fontSize: number) => number,
): number {
  if (!entry.paint || !entry.fit || entry.fit.lines.length === 0) return 0;
  const along = verticalWriting(entry.block)
    ? entry.fit.width
    : (entry.drawn?.width ?? entry.fit.width);
  let extra = 0;
  for (const line of entry.fit.lines) {
    extra += Math.max(0, measure(line, entry.fit.fontSize) - along - WIDTH_SLACK);
  }
  return extra;
}

function capToPage(width: number, x: number, pageWidth: number): number {
  if (pageWidth <= 0) return width;
  return Math.max(1, Math.min(width, pageWidth - x - GUTTER_CLEARANCE));
}

export function exceedsPage(box: Box, pageWidth: number, pageHeight: number): boolean {
  if (pageWidth > 0 && box.x + box.width > pageWidth + 1) return true;
  if (pageHeight > 0 && box.y + box.height > pageHeight + 1) return true;
  return false;
}

const ROLE_PRIORITY: Record<AnyBlockRole, number> = {
  heading: 10,
  prose: 20,
  caption: 30,
  cell: 40,
  label: 50,
  equation: 0,
  'figure-label': 0,
  code: 0,
  furniture: 0,
  identity: 0,
};

/**
 * When two painted boxes overlap, keep the one a reader needs more and leave the other in
 * the source typesetting. Growing a paragraph into a heading or a cell is how a page ends up
 * with two sentences printed over each other; hiding the grown box is the conservative fix.
 * The dropped translation is kept as overflow so the reader can still open it.
 */
export function resolveOverlaps(placed: readonly PlacedBlock[]): PlacedBlock[] {
  const next = placed.map((entry) => ({ ...entry }));
  for (let left = 0; left < next.length; left += 1) {
    const first = next[left];
    if (!first?.paint || !first.drawn) continue;
    for (let right = left + 1; right < next.length; right += 1) {
      const second = next[right];
      if (!second?.paint || !second.drawn) continue;
      if (intersectionArea(first.drawn, second.drawn) < OVERLAP_AREA) continue;
      const drop = whichToHide(first, second);
      if (drop === 'left') {
        first.paint = false;
        first.drawn = null;
        first.overflow = first.translation.trim().length > 0;
        break;
      }
      second.paint = false;
      second.drawn = null;
      second.overflow = second.translation.trim().length > 0;
    }
  }
  return next;
}

function whichToHide(left: PlacedBlock, right: PlacedBlock): 'left' | 'right' {
  const leftGrown = (left.fit?.fits === true && left.fit.grown) || false;
  const rightGrown = (right.fit?.fits === true && right.fit.grown) || false;
  if (leftGrown !== rightGrown) return leftGrown ? 'left' : 'right';
  const leftRank = ROLE_PRIORITY[left.block.role] ?? 80;
  const rightRank = ROLE_PRIORITY[right.block.role] ?? 80;
  if (leftRank !== rightRank) return leftRank > rightRank ? 'left' : 'right';
  return 'right';
}
