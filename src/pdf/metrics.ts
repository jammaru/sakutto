import { CJK_MAJORITY, cjkRatio } from './fonts';
import { intersectionArea, unionBox, type Box } from './geometry';
import type { LayoutBlock, PageLayout } from './layout';
import { OVERLAP_AREA, overlapRegion, underCoveredProse, type PlacedBlock } from './place';

/**
 * What a layout-only run reports about one page.
 *
 * These numbers are the ones a painted page can fail on: overlapping boxes, type that shrank
 * below a readable size, translations that had to be withheld because they would not fit, and
 * the share of prose that actually received a box. They do not score meaning — that is a
 * different check, run on a sampled page with the real model.
 */
export interface PageMetrics {
  blocks: number;
  skipped: number;
  painted: number;
  withheld: number;
  /** Translations shown via a marker rather than in place. */
  overflowed: number;
  /** Pairs of painted boxes whose interiors overlap. */
  overlapPairs: number;
  /** Total overlapping area, in square points. */
  overlapArea: number;
  minFontSize: number | null;
  /** Painted boxes whose type is below this share of the source size. */
  shrunk: number;
  /** Prose / heading / caption / cell blocks that received a painted translation, 0–1. */
  prosePainted: number;
  /**
   * Same coverage, restricted to an actually painted cover. Markers and deliberately kept
   * blocks do not count; this is the number the page reader's acceptance check uses.
   */
  prosePaintedOnly: number;
  /**
   * Share of those same blocks that a reader can read as a translation: painted in place or
   * opened from a marker. A page that withholds silently scores low here; a page that keeps
   * the original and offers the translation on a marker scores high.
   */
  proseCovered: number;
  /** Blocks the layout marked as not-prose that were painted anyway, 0–1. */
  nonProsePainted: number;
  /** Painted boxes that extend past the page's own box. */
  overflow: number;
  /** Union of figure obstacles as a share of the page area, 0–1. */
  figureAreaShare: number;
  /** Actual covered area of figure obstacles as a share of the page, 0–1. */
  figureCoveredShare: number;
  /** Share of all classified blocks that are labels or figure-labels, 0–1. */
  labelShare: number;
  /** Share of classified blocks marked `code`, 0–1. */
  codeShare: number;
  /** Share of classified blocks marked `equation`, 0–1. */
  equationShare: number;
  /** Share of letters in classified blocks that are Han / Hiragana / Katakana, 0–1. */
  cjkShare: number;
  /** Prose blocks painted without fully covering the source box vertically. */
  underCoveredProse: number;
}

export const METRIC_LIMITS = {
  /** A painted page may not put two translations on top of each other. */
  maxOverlapPairs: 0,
  /** Type below this, in points, is treated as unreadable. Body text may reach 6pt. */
  minFontSize: 6,
  /** A block may shrink this far and no further. */
  minScale: 0.67,
  /** At least this share of translatable prose must receive a painted box. */
  minProsePainted: 0.7,
  /** Painted-only coverage: a marker or a deliberate keep is not a translated page. */
  minProsePaintedOnly: 0.97,
  /**
   * At least this share of translatable prose must be readable as a translation, in place
   * or from a marker. Silent English leftovers are the failure this number catches.
   */
  minProseCovered: 0.97,
  /** None of the skipped roles may be painted. */
  maxNonProsePainted: 0,
  /** A painted box may not run off the page. */
  maxOverflow: 0,
  /**
   * A cluster that covers more of the page than this, together with a high label share,
   * is a page frame treated as a figure — titles and prose then get no grow budget.
   */
  maxFigureAreaShare: 0.5,
  /** When figures are that large, labels may not be this share of every classified block. */
  maxLabelShareWhenFigureHeavy: 0.35,
  /** Almost every block marked code is a mass misclassification, in any language. */
  maxCodeShare: 0.85,
  /** A CJK-majority page is body text; a listing should be a small share of it. */
  maxCodeShareWhenCjk: 0.25,
  maxEquationShareWhenCjk: 0.25,
  maxUnderCoveredProse: 0,
} as const;

/** Roles whose translation is the point of the page: body, titles, captions, table values. */
const COVERAGE_ROLES = new Set(['prose', 'heading', 'caption', 'cell']);
/** Every role the reader will try to paint, including short labels. */
const PAINTED_ROLES = new Set(['prose', 'heading', 'caption', 'cell', 'label']);

const PROSE_WORD = /\p{L}{3,}/gu;
const ENGLISH_WORD = /\b[A-Za-z]{3,}\b/gu;
/** Roles whose text is genuinely not prose, even when it contains whole words. */
const NON_PROSE_ROLES = new Set(['code', 'equation', 'furniture', 'identity']);

/**
 * True when a skipped block reads as prose rather than as notation or a short label.
 *
 * A skipped block is not in `layout.blocks`, so before this it disappeared from the coverage
 * denominator entirely: a paragraph misclassified as a figure label looked like a page with
 * nothing to translate. Counting its source text makes that mistake fail instead of hiding.
 */
function isProseLike(text: string): boolean {
  return (text.match(PROSE_WORD)?.length ?? 0) >= 3 || (text.match(ENGLISH_WORD)?.length ?? 0) >= 8;
}

/**
 * True when a skipped figure-label is actually diagram type, not body prose caught by a bad
 * figure box. Real labels are set well below body size; a full-size label is prose and must
 * stay in the coverage denominator even if the obstacle test says it is inside a drawing.
 */
function isDiagramLabel(block: LayoutBlock, layout: PageLayout): boolean {
  return layout.bodySize > 0 && block.fontSize < layout.bodySize * 0.85;
}

/** Area covered by a set of rectangles, counting overlaps once rather than their bounding box. */
function coveredArea(boxes: readonly Box[]): number {
  const xs = [...new Set(boxes.flatMap((box) => [box.x, box.x + box.width]))].sort(
    (left, right) => left - right,
  );
  let area = 0;
  for (let index = 1; index < xs.length; index += 1) {
    const left = xs[index - 1] ?? 0;
    const right = xs[index] ?? 0;
    if (right <= left) continue;
    const spans: [number, number][] = [];
    for (const box of boxes) {
      if (box.x > left + 1e-9 || box.x + box.width < right - 1e-9) continue;
      spans.push([box.y, box.y + box.height]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let start = -Infinity;
    let end = -Infinity;
    for (const [top, bottom] of spans) {
      if (top > end) {
        if (end > start) covered += end - start;
        start = top;
        end = bottom;
      } else {
        end = Math.max(end, bottom);
      }
    }
    if (end > start) covered += end - start;
    area += (right - left) * covered;
  }
  return area;
}

export function pageMetrics(
  layout: PageLayout,
  placed: readonly PlacedBlock[],
  pageBox: Box | null = null,
): PageMetrics {
  const painted = placed.filter((entry) => entry.paint && entry.drawn);
  let overlapPairs = 0;
  let overlapArea = 0;
  for (let left = 0; left < painted.length; left += 1) {
    const leftEntry = painted[left];
    const first = leftEntry ? overlapRegion(leftEntry) : null;
    if (!first) continue;
    for (let right = left + 1; right < painted.length; right += 1) {
      const rightEntry = painted[right];
      const second = rightEntry ? overlapRegion(rightEntry) : null;
      if (!second) continue;
      const area = intersectionArea(first, second);
      if (area < OVERLAP_AREA) continue;
      overlapPairs += 1;
      overlapArea += area;
    }
  }

  const sizes = painted
    .map((entry) => entry.fit?.fontSize ?? null)
    .filter((size): size is number => size !== null);

  const translatable = [
    ...layout.blocks.filter((block) => COVERAGE_ROLES.has(block.role)),
    ...layout.skipped.filter(
      (block) =>
        !NON_PROSE_ROLES.has(block.role) &&
        !(block.role === 'figure-label' && isDiagramLabel(block, layout)) &&
        isProseLike(block.text),
    ),
  ];
  const paintedProse = placed.filter(
    (entry) => entry.paint && COVERAGE_ROLES.has(entry.block.role),
  ).length;
  const paintedProseOnly = placed.filter(
    (entry) =>
      entry.paint && COVERAGE_ROLES.has(entry.block.role) && entry.translation.trim().length > 0,
  ).length;
  const coveredProse = placed.filter(
    (entry) =>
      COVERAGE_ROLES.has(entry.block.role) &&
      (entry.paint || entry.overflow) &&
      entry.translation.trim().length > 0,
  ).length;
  const skippedPainted = placed.filter(
    (entry) => entry.paint && !PAINTED_ROLES.has(entry.block.role),
  ).length;

  let overflow = 0;
  if (pageBox) {
    for (const entry of painted) {
      const box = entry.drawn;
      if (!box) continue;
      if (
        box.x < pageBox.x - 1 ||
        box.y < pageBox.y - 1 ||
        box.x + box.width > pageBox.x + pageBox.width + 1 ||
        box.y + box.height > pageBox.y + pageBox.height + 1
      ) {
        overflow += 1;
      }
    }
  }

  const pageArea = pageBox ? pageBox.width * pageBox.height : 0;
  const figureUnion = unionBox(layout.obstacles ?? []);
  const figureAreaShare =
    pageArea > 0 && figureUnion !== null
      ? Math.min(1, (figureUnion.width * figureUnion.height) / pageArea)
      : 0;
  const figureCoveredShare =
    pageArea > 0 ? Math.min(1, coveredArea(layout.obstacles ?? []) / pageArea) : 0;
  const classified = [...layout.blocks, ...layout.skipped];
  const labelCount = classified.filter(
    (block) => block.role === 'label' || block.role === 'figure-label',
  ).length;
  const labelShare = classified.length === 0 ? 0 : labelCount / classified.length;
  const codeCount = classified.filter((block) => block.role === 'code').length;
  const equationCount = classified.filter((block) => block.role === 'equation').length;
  const codeShare = classified.length === 0 ? 0 : codeCount / classified.length;
  const equationShare = classified.length === 0 ? 0 : equationCount / classified.length;
  const cjkShare = cjkRatio(classified.map((block) => block.text).join(''));

  return {
    blocks: layout.blocks.length,
    skipped: layout.skipped.length,
    painted: painted.length,
    withheld: placed.filter((entry) => !entry.paint && !entry.overflow).length,
    overflowed: placed.filter((entry) => entry.overflow).length,
    overlapPairs,
    overlapArea,
    minFontSize: sizes.length > 0 ? Math.min(...sizes) : null,
    shrunk: painted.filter(
      (entry) =>
        entry.fit !== null &&
        entry.fit.fontSize < entry.block.fontSize * METRIC_LIMITS.minScale - 1e-9,
    ).length,
    prosePainted: translatable.length === 0 ? 1 : paintedProse / translatable.length,
    prosePaintedOnly: translatable.length === 0 ? 1 : paintedProseOnly / translatable.length,
    proseCovered: translatable.length === 0 ? 1 : coveredProse / translatable.length,
    nonProsePainted: layout.skipped.length === 0 ? 0 : skippedPainted / layout.skipped.length,
    overflow,
    figureAreaShare,
    figureCoveredShare,
    labelShare,
    codeShare,
    equationShare,
    cjkShare,
    underCoveredProse: underCoveredProse(placed),
  };
}

export function metricsPass(metrics: PageMetrics): boolean {
  if (metrics.overlapPairs > METRIC_LIMITS.maxOverlapPairs) return false;
  if (metrics.minFontSize !== null && metrics.minFontSize < METRIC_LIMITS.minFontSize - 0.05) {
    return false;
  }
  if (metrics.proseCovered < METRIC_LIMITS.minProseCovered) return false;
  if (metrics.prosePaintedOnly < METRIC_LIMITS.minProsePaintedOnly) return false;
  if (metrics.underCoveredProse > METRIC_LIMITS.maxUnderCoveredProse) return false;
  if (metrics.nonProsePainted > METRIC_LIMITS.maxNonProsePainted) return false;
  if (metrics.overflow > METRIC_LIMITS.maxOverflow) return false;
  if (
    metrics.figureAreaShare > METRIC_LIMITS.maxFigureAreaShare &&
    metrics.labelShare > METRIC_LIMITS.maxLabelShareWhenFigureHeavy
  ) {
    return false;
  }
  if (metrics.codeShare > METRIC_LIMITS.maxCodeShare) return false;
  if (metrics.cjkShare >= CJK_MAJORITY && metrics.codeShare > METRIC_LIMITS.maxCodeShareWhenCjk) {
    return false;
  }
  if (
    metrics.cjkShare >= CJK_MAJORITY &&
    metrics.equationShare > METRIC_LIMITS.maxEquationShareWhenCjk
  ) {
    return false;
  }
  return true;
}
