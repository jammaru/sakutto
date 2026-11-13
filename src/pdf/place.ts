import { fitText, growBudgetFor, type FitResult } from './fit';
import { boxRight, intersectionArea, type Box } from './geometry';
import {
  verticalWriting,
  type AnyBlockRole,
  type BlockAlign,
  type LayoutBlock,
  type PageLayout,
} from './layout';

/** Space kept clear at the foot of a page, in points, so a last paragraph cannot run off it. */
export const PAGE_FOOT_MARGIN = 28;

/** Two boxes that share this much area, in square points, are treated as overlapping. */
export const OVERLAP_AREA = 1;
/** White space kept at a box's right edge so two columns never touch, in points. */
const GUTTER_CLEARANCE = 4;
/**
 * Extra cover below the source box, as a fraction of em, to hide Latin descenders.
 *
 * 0.22em covers `g`/`p`/`y` without the 0.32em pad that grew covers into the next block.
 */
export const COVER_DESCENDER_EM = 0.22;
/** Tiny extra above the source box, as a fraction of em. Keep small so covers do not collide. */
export const COVER_PAD_TOP_EM = 0.02;
/**
 * How much a CSS line at `fontSize * scale` px can grow past the canvas measure at the
 * source point size, as a fraction. Font hinting at the painted size is the usual cause.
 */
export const HINTING_GROWTH = 1.015;
/** Extra cover width, in CSS pixels, so a hinted last glyph is not clipped. */
export const HINTING_PAD_PX = 2;
/** Largest scale the reader uses; the layout-only clip check assumes this worst case. */
export const DEFAULT_PAINT_SCALE = 1.6;

/** Hinting pad in page points at the given paint scale. */
export function hintingPadPt(scale = DEFAULT_PAINT_SCALE): number {
  return HINTING_PAD_PX / Math.max(0.4, scale);
}

export function descenderPad(fontSize: number): number {
  return fontSize * COVER_DESCENDER_EM;
}

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
/** Painted blocks whose cover stops short of the source box bottom (original glyphs show through). */
export function underCoveredProse(placed: readonly PlacedBlock[]): number {
  let count = 0;
  for (const entry of placed) {
    if (!entry.paint || !entry.drawn) continue;
    if (
      entry.block.role !== 'prose' &&
      entry.block.role !== 'heading' &&
      entry.block.role !== 'caption'
    ) {
      continue;
    }
    const sourceBottom = entry.block.box.y + entry.block.box.height;
    const coverBottom = entry.drawn.y + entry.drawn.height;
    if (coverBottom + 1.5 < sourceBottom) count += 1;
  }
  return count;
}

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

  return resolveOverlaps(placed, pageWidth);
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
 * overflowing it and being clipped. `fitText` then wraps to `HINTING_WRAP` of this width so
 * font hinting at the painted CSS size cannot clip the last glyph.
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
  // A neighbouring block just above can still grow down into this row, so it also bounds
  // the unused space to the right. Looking only at boxes that already overlap vertically
  // let a paragraph widen into the next column and then lose the overlap pass to a larger
  // block on the other side.
  const reach = Math.max(1, block.box.height * 2);
  for (const obstacle of obstacles) {
    if (obstacle === block.box) continue;
    if (obstacle.x + 1 < block.box.x + block.box.width) continue;
    if (obstacle.y + obstacle.height < top - reach) continue;
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

/** True when body text is only part of a line and must not paint across the full column. */
export function inlineProseFragment(
  block: Pick<LayoutBlock, 'box' | 'room' | 'role' | 'fontSize' | 'text'>,
): boolean {
  if (block.role !== 'prose' && block.role !== 'heading' && block.role !== 'caption') {
    return false;
  }
  if (block.room.width <= 0) return false;
  const inset = block.box.x - block.room.x;
  if (
    (block.box.width < block.room.width * 0.6 && inset > 6) ||
    (inset > block.fontSize && block.box.width < block.room.width * 0.85)
  ) {
    return true;
  }
  // Room was trimmed to the token; treat short runs beside a line as inline fragments.
  return (
    block.box.width < block.fontSize * 14 &&
    block.text.length < 48 &&
    block.box.height <= block.fontSize * 2.5
  );
}

export function drawnBox(block: LayoutBlock, fit: FitResult, wrap = 0, pageWidth = 0): Box {
  if (verticalWriting(block)) {
    const descender = descenderPad(block.fontSize);
    const cross = Math.max(block.box.width, fit.height) + descender;
    const along = Math.max(block.box.height, wrap, block.advance);
    return { x: block.box.x, y: block.box.y, width: cross, height: along };
  }
  const descender = descenderPad(block.fontSize);
  const height = fit.fits
    ? Math.max(block.box.height + descender, fit.height)
    : Math.max(block.box.height + descender, fit.visibleLines.length * fit.lineHeight);
  const fragment = inlineProseFragment(block);
  const x = fragment ? block.box.x : Math.min(block.box.x, block.room.x);
  const baseWidth = fragment
    ? Math.max(block.box.width, wrap, block.advance)
    : Math.max(block.room.width, block.box.width, wrap, block.advance);
  const width = capToColumn(baseWidth, x, block, pageWidth);
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
 * CSS width of a horizontally-written cover, in page points.
 *
 * `drawnBox` may come out a fraction of a point narrower than the wrap after `capToPage`.
 * Painting to that trimmed width with `overflow: hidden` clips the last glyph, so the cover
 * is at least as wide as the wrap, plus a small hinting pad for the CSS size.
 */
export function coverPaintWidth(
  fitWidth: number,
  drawnWidth: number,
  scale = DEFAULT_PAINT_SCALE,
): number {
  return Math.max(fitWidth, drawnWidth) + hintingPadPt(scale);
}

/**
 * Left edge of a widened cover, in page points, so centre/right alignment stays on the
 * original box. Extra width from the wrap or the hinting pad hangs off the opposite side.
 */
export function coverPaintOriginX(
  drawnX: number,
  drawnWidth: number,
  paintWidth: number,
  align: BlockAlign,
): number {
  const extra = paintWidth - drawnWidth;
  if (align === 'right') return drawnX - extra;
  if (align === 'center') return drawnX - extra / 2;
  return drawnX;
}

/**
 * Painted cover in page points: wrap width, hinting pad, and alignment offset, capped to
 * the page so a pad cannot walk into the next column's gutter.
 */
export function coverPaintLayout(
  block: Pick<LayoutBlock, 'align' | 'writing' | 'column' | 'box' | 'lines'>,
  fitWidth: number,
  drawn: Box,
  scale = DEFAULT_PAINT_SCALE,
  pageWidth = 0,
): { x: number; width: number } {
  if (verticalWriting(block)) return { x: drawn.x, width: drawn.width };
  const fitCap =
    pageWidth > 0 ? capToColumn(fitWidth, drawn.x, block, pageWidth) : fitWidth;
  const width = coverPaintWidth(fitCap, drawn.width, scale);
  const x = coverPaintOriginX(drawn.x, drawn.width, width, block.align);
  const left = Math.max(0, x);
  let painted = width + Math.min(0, x);
  if (pageWidth > 0) {
    painted = capToColumn(painted, left, block, pageWidth);
  }
  return { x: left, width: painted };
}

/**
 * Extra width painted lines occupy beyond the box they are drawn in, in points.
 *
 * Horizontal writing is clipped by the painted cover width (wrap, plus hinting pad). A line
 * is compared at `HINTING_GROWTH` so a canvas measure at the source point size is not treated
 * as identical to CSS at `fontSize * scale` px. Vertical writing is wrapped to `fit.width`
 * and then rotated, so that wrap width is the edge that must not be crossed.
 */
export function clippedPaintWidth(
  entry: PlacedBlock,
  measure: (text: string, fontSize: number) => number,
  scale = DEFAULT_PAINT_SCALE,
): number {
  if (!entry.paint || !entry.fit || entry.fit.lines.length === 0) return 0;
  const along = verticalWriting(entry.block)
    ? entry.fit.width + hintingPadPt(scale)
    : coverPaintLayout(
        entry.block,
        entry.fit.width,
        entry.drawn ?? { x: 0, y: 0, width: entry.fit.width, height: 0 },
        scale,
      ).width;
  let extra = 0;
  const core = verticalWriting(entry.block)
    ? entry.fit.width
    : Math.max(entry.fit.width, entry.drawn?.width ?? entry.fit.width);
  if (along + 1e-9 < core) extra += core - along;
  for (const line of entry.fit.lines) {
    const hinted = measure(line, entry.fit.fontSize) * HINTING_GROWTH;
    extra += Math.max(0, hinted - along);
  }
  return extra;
}

function capToPage(width: number, x: number, pageWidth: number): number {
  if (pageWidth <= 0) return width;
  return Math.max(1, Math.min(width, pageWidth - x - GUTTER_CLEARANCE));
}

/** True when source lines cross the column gutter (title, author, byline rows). */
export function blockSpansGutter(
  block: Pick<LayoutBlock, 'box' | 'lines'>,
  pageWidth: number,
): boolean {
  if (pageWidth <= 0) return false;
  const gutter = pageWidth * 0.49;
  const left =
    block.lines.length > 0
      ? Math.min(...block.lines.map((line) => line.box.x))
      : block.box.x;
  const right =
    block.lines.length > 0
      ? Math.max(...block.lines.map((line) => line.box.x + line.box.width))
      : block.box.x + block.box.width;
  return left + 4 < gutter && right > gutter + GUTTER_CLEARANCE;
}

/** Caps cover width so a translation cannot paint over the neighbour column. */
function capToColumn(
  width: number,
  x: number,
  block: Pick<LayoutBlock, 'column' | 'box' | 'lines'>,
  pageWidth: number,
): number {
  const capped = capToPage(width, x, pageWidth);
  if (pageWidth <= 0 || blockSpansGutter(block, pageWidth)) return capped;
  const gutter = pageWidth * 0.49;
  if (block.column === 0) {
    return Math.max(1, Math.min(capped, gutter - GUTTER_CLEARANCE - x));
  }
  if (block.column > 0) {
    const left = Math.max(x, gutter + GUTTER_CLEARANCE);
    return Math.max(1, Math.min(capped, pageWidth - GUTTER_CLEARANCE - left));
  }
  return capped;
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
 * When two painted boxes overlap, keep the larger block and leave the smaller fragment in
 * the source typesetting. A reference list or a table can produce a short fragment whose
 * grown translation lands on the paragraph beside it; dropping the fragment to a marker
 * keeps the page readable without withholding both translations. The dropped translation is
 * kept as overflow so the reader can still open it.
 */
/** True when overlap is only a sliver across the column gutter between neighbours. */
export function gutterSliverOverlap(
  firstCore: Box,
  secondCore: Box,
  firstColumn: number,
  secondColumn: number,
  pageWidth: number,
): boolean {
  if (pageWidth <= 0 || firstColumn === secondColumn) return false;
  const gutter = pageWidth * 0.49;
  const x1 = Math.max(firstCore.x, secondCore.x);
  const x2 = Math.min(boxRight(firstCore), boxRight(secondCore));
  const y1 = Math.max(firstCore.y, secondCore.y);
  const y2 = Math.min(firstCore.y + firstCore.height, secondCore.y + secondCore.height);
  if (x2 <= x1 || y2 <= y1) return false;
  return x1 >= gutter - 8 && x2 <= gutter + 12;
}

/** Same-row inline fragment beside a full-width line: the wide cover must not hide it. */
function ignoreInlineOverlap(left: PlacedBlock, right: PlacedBlock): boolean {
  const fragment = inlineProseFragment(left.block)
    ? left
    : inlineProseFragment(right.block)
      ? right
      : null;
  const wide = fragment === left ? right : fragment === right ? left : null;
  if (!fragment?.paint || !wide?.paint || !fragment.drawn || !wide.drawn) return false;
  const fragBase = fragment.block.lines[0]?.baseline ?? fragment.block.box.y;
  const sharedRow = wide.block.lines.some(
    (line) => Math.abs(line.baseline - fragBase) <= Math.max(fragment.block.fontSize * 0.4, 0.5),
  );
  if (!sharedRow) return false;
  if (fragment.block.box.x + 1 <= wide.block.box.x + wide.block.box.width * 0.55) {
    return false;
  }
  return intersectionArea(overlapRegion(wide) ?? wide.drawn, fragment.block.box) >= OVERLAP_AREA;
}

export function resolveOverlaps(placed: readonly PlacedBlock[], pageWidth = 0): PlacedBlock[] {
  const next = placed.map((entry) => ({ ...entry }));
  for (let left = 0; left < next.length; left += 1) {
    const first = next[left];
    if (!first?.paint || !first.drawn) continue;
    for (let right = left + 1; right < next.length; right += 1) {
      const second = next[right];
      if (!second?.paint || !second.drawn) continue;
      if (ignoreInlineOverlap(first, second)) {
        const fragment = inlineProseFragment(first.block) ? first : second;
        const wide = fragment === first ? second : first;
        if (wide.drawn && fragment.block.box.x > wide.drawn.x + 1) {
          wide.drawn = {
            ...wide.drawn,
            width: Math.max(fragment.block.box.x - wide.drawn.x - GUTTER_CLEARANCE, 1),
          };
        }
        continue;
      }
      const firstCore = overlapRegion(first);
      const secondCore = overlapRegion(second);
      if (!firstCore || !secondCore) continue;
      if (
        gutterSliverOverlap(
          firstCore,
          secondCore,
          first.block.column,
          second.block.column,
          pageWidth,
        )
      ) {
        continue;
      }
      if (intersectionArea(firstCore, secondCore) < OVERLAP_AREA) continue;
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

/**
 * Box the reader paints, including the tiny pad above the source and the painted width.
 */
export function paintedCoverBox(block: LayoutBlock, fit: FitResult, wrap = 0, pageWidth = 0): Box {
  const drawn = drawnBox(block, fit, wrap, pageWidth);
  if (verticalWriting(block)) return drawn;
  const padTop = block.fontSize * COVER_PAD_TOP_EM;
  return {
    x: drawn.x,
    y: drawn.y - padTop,
    width: coverPaintWidth(fit.width, drawn.width),
    height: drawn.height + padTop,
  };
}

/**
 * Count of painted covers that sit on top of each other, ignoring descender padding.
 *
 * The hang below a line that hides `g`/`p` is supposed to overlap the gap, not the next
 * cover's type. `overlapRegion` leaves that pad out so a 0.22em descender does not fail
 * a page whose cores do not collide. Width follows the painted cover, not the capped box.
 */
export function paintedCoverOverlaps(placed: readonly PlacedBlock[], pageWidth = 0): number {
  void pageWidth;
  const boxes: Box[] = [];
  for (const entry of placed) {
    if (!entry.paint || !entry.fit || !entry.drawn) continue;
    const region = overlapRegion(entry);
    if (!region) continue;
    boxes.push({
      x: region.x,
      y: region.y,
      // Hinting pad hangs into the gutter; it must not count as two covers colliding.
      width: region.width,
      height: region.height,
    });
  }
  let count = 0;
  for (let left = 0; left < boxes.length; left += 1) {
    const first = boxes[left];
    if (!first) continue;
    for (let right = left + 1; right < boxes.length; right += 1) {
      const second = boxes[right];
      if (!second) continue;
      if (intersectionArea(first, second) >= OVERLAP_AREA) count += 1;
    }
  }
  return count;
}

/**
 * Box used to decide whether two covers collide. Descender padding is left out so a cover
 * that only hangs below its source line to hide `g`/`p` does not knock out the row under it.
 */
export function overlapRegion(entry: PlacedBlock): Box | null {
  if (!entry.drawn) return null;
  if (verticalWriting(entry.block)) return entry.drawn;
  const core = Math.max(entry.block.box.height, entry.fit?.height ?? 0);
  return { ...entry.drawn, height: Math.max(0.1, Math.min(entry.drawn.height, core)) };
}

/** How far a painted cover falls short of hiding the source line box, including descenders. */
export function verticalCut(entry: PlacedBlock): number {
  if (!entry.paint || !entry.drawn) return 0;
  const descender = descenderPad(entry.block.fontSize);
  if (verticalWriting(entry.block)) {
    const need = Math.max(entry.block.box.width, entry.fit?.height ?? 0) + descender;
    return Math.max(0, need - entry.drawn.width);
  }
  const need = entry.block.box.height + descender;
  return Math.max(0, need - entry.drawn.height);
}

function whichToHide(left: PlacedBlock, right: PlacedBlock): 'left' | 'right' {
  const leftArea = left.block.box.width * left.block.box.height;
  const rightArea = right.block.box.width * right.block.box.height;
  if (leftArea !== rightArea) return leftArea < rightArea ? 'left' : 'right';
  const leftPainted = overlapRegion(left);
  const rightPainted = overlapRegion(right);
  const leftPaintArea = (leftPainted?.width ?? 0) * (leftPainted?.height ?? 0);
  const rightPaintArea = (rightPainted?.width ?? 0) * (rightPainted?.height ?? 0);
  if (leftPaintArea !== rightPaintArea) {
    return leftPaintArea < rightPaintArea ? 'left' : 'right';
  }
  const leftGrown = (left.fit?.fits === true && left.fit.grown) || false;
  const rightGrown = (right.fit?.fits === true && right.fit.grown) || false;
  if (leftGrown !== rightGrown) return leftGrown ? 'left' : 'right';
  const leftRank = ROLE_PRIORITY[left.block.role] ?? 80;
  const rightRank = ROLE_PRIORITY[right.block.role] ?? 80;
  if (leftRank !== rightRank) return leftRank > rightRank ? 'left' : 'right';
  return 'right';
}
