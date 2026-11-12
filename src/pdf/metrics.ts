import { intersectionArea, type Box } from './geometry';
import type { PageLayout } from './layout';
import { OVERLAP_AREA, type PlacedBlock } from './place';

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
   * Share of those same blocks that a reader can read as a translation: painted in place or
   * opened from a marker. A page that withholds silently scores low here; a page that keeps
   * the original and offers the translation on a marker scores high.
   */
  proseCovered: number;
  /** Blocks the layout marked as not-prose that were painted anyway, 0–1. */
  nonProsePainted: number;
  /** Painted boxes that extend past the page's own box. */
  overflow: number;
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
  /**
   * At least this share of translatable prose must be readable as a translation, in place
   * or from a marker. Silent English leftovers are the failure this number catches.
   */
  minProseCovered: 0.97,
  /** None of the skipped roles may be painted. */
  maxNonProsePainted: 0,
  /** A painted box may not run off the page. */
  maxOverflow: 0,
} as const;

/** Roles whose translation is the point of the page: body, titles, captions, table values. */
const COVERAGE_ROLES = new Set(['prose', 'heading', 'caption', 'cell']);
/** Every role the reader will try to paint, including short labels. */
const PAINTED_ROLES = new Set(['prose', 'heading', 'caption', 'cell', 'label']);

export function pageMetrics(
  layout: PageLayout,
  placed: readonly PlacedBlock[],
  pageBox: Box | null = null,
): PageMetrics {
  const painted = placed.filter((entry) => entry.paint && entry.drawn);
  let overlapPairs = 0;
  let overlapArea = 0;
  for (let left = 0; left < painted.length; left += 1) {
    const first = painted[left]?.drawn;
    if (!first) continue;
    for (let right = left + 1; right < painted.length; right += 1) {
      const second = painted[right]?.drawn;
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

  const translatable = layout.blocks.filter((block) => COVERAGE_ROLES.has(block.role));
  const paintedProse = placed.filter(
    (entry) => entry.paint && COVERAGE_ROLES.has(entry.block.role),
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
    proseCovered: translatable.length === 0 ? 1 : coveredProse / translatable.length,
    nonProsePainted: layout.skipped.length === 0 ? 0 : skippedPainted / layout.skipped.length,
    overflow,
  };
}

export function metricsPass(metrics: PageMetrics): boolean {
  if (metrics.overlapPairs > METRIC_LIMITS.maxOverlapPairs) return false;
  if (metrics.minFontSize !== null && metrics.minFontSize < METRIC_LIMITS.minFontSize - 0.05) {
    return false;
  }
  if (metrics.proseCovered < METRIC_LIMITS.minProseCovered) return false;
  if (metrics.nonProsePainted > METRIC_LIMITS.maxNonProsePainted) return false;
  if (metrics.overflow > METRIC_LIMITS.maxOverflow) return false;
  return true;
}
