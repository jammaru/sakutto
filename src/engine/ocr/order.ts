import { isVerticalQuad } from './image';
import type { OcrQuad, ReadingLine, TextOrientation } from './types';

export interface LayoutRegion {
  readonly quad: OcrQuad;
  readonly vertical?: boolean;
}

export interface ReadingOrderOptions {
  /** Auto selects vertical layout when at least half of the boxes are tall. */
  readonly orientation?: TextOrientation | 'auto';
  readonly verticalRatio?: number;
  /** Maximum centre drift as a fraction of line height/column width. */
  readonly lineTolerance?: number;
}

interface IndexedRegion<T> {
  readonly item: T;
  readonly index: number;
  /** Horizontal newspaper-style column; zero for vertical writing and single-column pages. */
  column: number;
  readonly bounds: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
    readonly centerX: number;
    readonly centerY: number;
    readonly width: number;
    readonly height: number;
  };
}

function regionBounds(quad: OcrQuad): IndexedRegion<unknown>['bounds'] {
  const xs = quad.map((point) => point.x);
  const ys = quad.map((point) => point.y);
  if ([...xs, ...ys].some((value) => !Number.isFinite(value))) {
    throw new RangeError('Reading-order quads must contain finite coordinates');
  }
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return {
    left,
    right,
    top,
    bottom,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
    width: right - left,
    height: bottom - top,
  };
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function belongsToLine<T extends LayoutRegion>(
  entry: IndexedRegion<T>,
  line: readonly IndexedRegion<T>[],
  orientation: TextOrientation,
  tolerance: number,
): number {
  if (orientation === 'horizontal') {
    const lineCenter = average(line.map((item) => item.bounds.centerY));
    const lineHeight = average(line.map((item) => item.bounds.height));
    const drift = Math.abs(entry.bounds.centerY - lineCenter);
    const allowed = Math.max(lineHeight, entry.bounds.height, 1) * tolerance;
    const overlap =
      Math.min(entry.bounds.bottom, ...line.map((item) => item.bounds.bottom)) -
      Math.max(entry.bounds.top, ...line.map((item) => item.bounds.top));
    return drift <= allowed && overlap >= -allowed ? drift / allowed : Number.POSITIVE_INFINITY;
  }
  const lineCenter = average(line.map((item) => item.bounds.centerX));
  const lineWidth = average(line.map((item) => item.bounds.width));
  const drift = Math.abs(entry.bounds.centerX - lineCenter);
  const allowed = Math.max(lineWidth, entry.bounds.width, 1) * tolerance;
  const overlap =
    Math.min(entry.bounds.right, ...line.map((item) => item.bounds.right)) -
    Math.max(entry.bounds.left, ...line.map((item) => item.bounds.left));
  return drift <= allowed && overlap >= -allowed ? drift / allowed : Number.POSITIVE_INFINITY;
}

function assignHorizontalColumns<T>(entries: IndexedRegion<T>[]): void {
  if (entries.length < 4) return;
  const sorted = [...entries].sort((a, b) => a.bounds.centerX - b.bounds.centerX);
  const widths = sorted.map((entry) => entry.bounds.width).sort((a, b) => a - b);
  const medianWidth = widths[Math.floor(widths.length / 2)] ?? 1;
  let split = -1;
  let largestGap = 0;
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const next = sorted[index];
    if (!previous || !next) continue;
    const gap = next.bounds.centerX - previous.bounds.centerX;
    if (gap > largestGap) {
      largestGap = gap;
      split = index;
    }
  }
  if (split < 2 || sorted.length - split < 2 || largestGap < Math.max(40, medianWidth * 0.75)) {
    return;
  }
  const left = sorted.slice(0, split);
  const right = sorted.slice(split);
  const gutter =
    Math.min(...right.map((entry) => entry.bounds.left)) -
    Math.max(...left.map((entry) => entry.bounds.right));
  if (gutter <= 0) return;
  const leftTop = Math.min(...left.map((entry) => entry.bounds.top));
  const rightTop = Math.min(...right.map((entry) => entry.bounds.top));
  const leftBottom = Math.max(...left.map((entry) => entry.bounds.bottom));
  const rightBottom = Math.max(...right.map((entry) => entry.bounds.bottom));
  const overlap = Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop);
  if (overlap <= 0) return;
  for (const entry of left) entry.column = 1;
  for (const entry of right) entry.column = 2;
}

/** Groups horizontal rows or vertical Japanese columns and returns their reading order. */
export function groupReadingLines<T extends LayoutRegion>(
  regions: readonly T[],
  options: ReadingOrderOptions = {},
): ReadingLine<T>[] {
  const tolerance = options.lineTolerance ?? 0.6;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new RangeError('lineTolerance must be a positive finite number');
  }
  const requested = options.orientation ?? 'auto';
  if (requested !== 'auto' && requested !== 'horizontal' && requested !== 'vertical') {
    throw new RangeError('Unknown reading orientation');
  }
  const verticalCount = regions.filter(
    (region) => region.vertical ?? isVerticalQuad(region.quad, options.verticalRatio),
  ).length;
  const orientation: TextOrientation =
    requested === 'auto'
      ? regions.length > 0 && verticalCount * 2 >= regions.length
        ? 'vertical'
        : 'horizontal'
      : requested;

  const entries: IndexedRegion<T>[] = regions.map((item, index) => ({
    item,
    index,
    column: 0,
    bounds: regionBounds(item.quad),
  }));
  if (orientation === 'horizontal') assignHorizontalColumns(entries);
  entries.sort((a, b) =>
    orientation === 'horizontal'
      ? a.column - b.column ||
        a.bounds.centerY - b.bounds.centerY ||
        a.bounds.left - b.bounds.left ||
        a.index - b.index
      : b.bounds.centerX - a.bounds.centerX || a.bounds.top - b.bounds.top || a.index - b.index,
  );

  const grouped: IndexedRegion<T>[][] = [];
  for (const entry of entries) {
    let bestLine = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < grouped.length; index += 1) {
      const line = grouped[index];
      if (!line || line[0]?.column !== entry.column) continue;
      const distance = belongsToLine(entry, line, orientation, tolerance);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestLine = index;
      }
    }
    if (bestLine < 0) grouped.push([entry]);
    else grouped[bestLine]?.push(entry);
  }

  for (const line of grouped) {
    line.sort((a, b) =>
      orientation === 'horizontal'
        ? a.bounds.left - b.bounds.left || a.bounds.top - b.bounds.top || a.index - b.index
        : a.bounds.top - b.bounds.top || b.bounds.right - a.bounds.right || a.index - b.index,
    );
  }
  grouped.sort((a, b) => {
    const column = (a[0]?.column ?? 0) - (b[0]?.column ?? 0);
    if (column !== 0) return column;
    const aCenterX = average(a.map((entry) => entry.bounds.centerX));
    const bCenterX = average(b.map((entry) => entry.bounds.centerX));
    const aCenterY = average(a.map((entry) => entry.bounds.centerY));
    const bCenterY = average(b.map((entry) => entry.bounds.centerY));
    const aLeft = Math.min(...a.map((entry) => entry.bounds.left));
    const bLeft = Math.min(...b.map((entry) => entry.bounds.left));
    const aTop = Math.min(...a.map((entry) => entry.bounds.top));
    const bTop = Math.min(...b.map((entry) => entry.bounds.top));
    return orientation === 'horizontal'
      ? aCenterY - bCenterY || aLeft - bLeft
      : bCenterX - aCenterX || aTop - bTop;
  });

  return grouped.map((line) => ({
    orientation,
    items: line.map((entry) => entry.item),
    indices: line.map((entry) => entry.index),
  }));
}

export function orderTextRegions<T extends LayoutRegion>(
  regions: readonly T[],
  options: ReadingOrderOptions = {},
): T[] {
  return groupReadingLines(regions, options).flatMap((line) => line.items);
}
