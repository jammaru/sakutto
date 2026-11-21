import type {
  DetectedRegion,
  ImageCoordinateTransform,
  OcrPoint,
  OcrQuad,
  ProbabilityMap,
} from './types';

export interface DbDecodeOptions {
  /** Binarization threshold for the DB probability map. */
  readonly threshold?: number;
  /** Minimum mean probability of a connected region. */
  readonly boxThreshold?: number;
  readonly unclipRatio?: number;
  /** Minimum short side, in probability-map pixels, before unclipping. */
  readonly minSize?: number;
  readonly maxCandidates?: number;
  /** Height/width at or above which a box is treated as vertical. */
  readonly verticalRatio?: number;
  /** Transform produced by detection preprocessing. */
  readonly transform?: ImageCoordinateTransform;
  /** Alternative to transform for an unpadded, directly resized probability map. */
  readonly originalWidth?: number;
  readonly originalHeight?: number;
}

export const DEFAULT_DB_OPTIONS = Object.freeze({
  threshold: 0.3,
  boxThreshold: 0.6,
  unclipRatio: 1.5,
  minSize: 3,
  maxCandidates: 1000,
  verticalRatio: 1.5,
});

interface MutablePoint {
  x: number;
  y: number;
}

interface Candidate {
  readonly quad: OcrQuad;
  readonly confidence: number;
  readonly sequence: number;
}

function assertUnitInterval(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number between 0 and 1`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function cross(origin: MutablePoint, a: MutablePoint, b: MutablePoint): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

function convexHull(points: MutablePoint[]): MutablePoint[] {
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const unique = points.filter(
    (point, index) =>
      index === 0 || point.x !== points[index - 1]?.x || point.y !== points[index - 1]?.y,
  );
  if (unique.length <= 2) return unique;

  const lower: MutablePoint[] = [];
  for (const point of unique) {
    while (lower.length >= 2) {
      const a = lower[lower.length - 2];
      const b = lower[lower.length - 1];
      if (a && b && cross(a, b, point) > 0) break;
      lower.pop();
    }
    lower.push(point);
  }

  const upper: MutablePoint[] = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    if (!point) continue;
    while (upper.length >= 2) {
      const a = upper[upper.length - 2];
      const b = upper[upper.length - 1];
      if (a && b && cross(a, b, point) > 0) break;
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function minimumAreaQuad(hull: readonly MutablePoint[]): OcrQuad {
  if (hull.length < 3) throw new RangeError('A connected region must have a non-degenerate hull');

  let best:
    | {
        area: number;
        centerX: number;
        centerY: number;
        ux: number;
        uy: number;
        width: number;
        height: number;
      }
    | undefined;

  for (let index = 0; index < hull.length; index += 1) {
    const start = hull[index];
    const end = hull[(index + 1) % hull.length];
    if (!start || !end) continue;
    const edgeLength = Math.hypot(end.x - start.x, end.y - start.y);
    if (edgeLength === 0) continue;
    const ux = (end.x - start.x) / edgeLength;
    const uy = (end.y - start.y) / edgeLength;
    const vx = -uy;
    const vy = ux;
    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;

    for (const point of hull) {
      const u = point.x * ux + point.y * uy;
      const v = point.x * vx + point.y * vy;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }

    const width = maxU - minU;
    const height = maxV - minV;
    const area = width * height;
    if (best && area >= best.area) continue;
    const centerU = (minU + maxU) / 2;
    const centerV = (minV + maxV) / 2;
    best = {
      area,
      centerX: centerU * ux + centerV * vx,
      centerY: centerU * uy + centerV * vy,
      ux,
      uy,
      width,
      height,
    };
  }

  if (!best) throw new RangeError('A connected region must have a non-degenerate bounding box');
  const vx = -best.uy;
  const vy = best.ux;
  const halfWidth = best.width / 2;
  const halfHeight = best.height / 2;
  const point = (u: number, v: number): OcrPoint => ({
    x: best.centerX + u * best.ux + v * vx,
    y: best.centerY + u * best.uy + v * vy,
  });
  return orderQuad([
    point(-halfWidth, -halfHeight),
    point(halfWidth, -halfHeight),
    point(halfWidth, halfHeight),
    point(-halfWidth, halfHeight),
  ]);
}

/** Orders any convex quadrilateral clockwise, starting at the top-left-most vertex. */
export function orderQuad(points: readonly OcrPoint[]): OcrQuad {
  if (
    points.length !== 4 ||
    points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))
  ) {
    throw new RangeError('A quad must contain four finite points');
  }
  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }),
    {
      x: 0,
      y: 0,
    },
  );
  const clockwise = [...points].sort((a, b) => {
    const angle =
      Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x);
    return angle || a.x - b.x || a.y - b.y;
  });
  let start = 0;
  for (let index = 1; index < clockwise.length; index += 1) {
    const point = clockwise[index];
    const first = clockwise[start];
    if (!point || !first) continue;
    if (
      point.x + point.y < first.x + first.y ||
      (point.x + point.y === first.x + first.y && point.x < first.x)
    ) {
      start = index;
    }
  }
  const ordered = clockwise.map((_, index) => clockwise[(start + index) % 4]);
  if (ordered.length !== 4 || ordered.some((point) => !point)) {
    throw new RangeError('Unable to order quadrilateral');
  }
  return ordered as unknown as OcrQuad;
}

function quadSides(quad: OcrQuad): { width: number; height: number } {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  const width =
    (Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y) +
      Math.hypot(bottomRight.x - bottomLeft.x, bottomRight.y - bottomLeft.y)) /
    2;
  const height =
    (Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y) +
      Math.hypot(bottomRight.x - topRight.x, bottomRight.y - topRight.y)) /
    2;
  return { width, height };
}

function unclipQuad(quad: OcrQuad, ratio: number): OcrQuad {
  if (ratio === 0) return quad;
  const { width, height } = quadSides(quad);
  const perimeter = 2 * (width + height);
  if (perimeter === 0) return quad;
  const distance = (width * height * ratio) / perimeter;
  const [topLeft, topRight, , bottomLeft] = quad;
  const topLength = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
  const sideLength = Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y);
  if (topLength === 0 || sideLength === 0) return quad;
  const ux = (topRight.x - topLeft.x) / topLength;
  const uy = (topRight.y - topLeft.y) / topLength;
  const vx = (bottomLeft.x - topLeft.x) / sideLength;
  const vy = (bottomLeft.y - topLeft.y) / sideLength;
  const center = quad.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), {
    x: 0,
    y: 0,
  });
  const halfWidth = width / 2 + distance;
  const halfHeight = height / 2 + distance;
  const point = (u: number, v: number): OcrPoint => ({
    x: center.x + u * ux + v * vx,
    y: center.y + u * uy + v * vy,
  });
  return orderQuad([
    point(-halfWidth, -halfHeight),
    point(halfWidth, -halfHeight),
    point(halfWidth, halfHeight),
    point(-halfWidth, halfHeight),
  ]);
}

function toOriginalPoint(point: OcrPoint, map: ProbabilityMap, options: DbDecodeOptions): OcrPoint {
  const transform = options.transform;
  const hasOriginalSize =
    options.originalWidth !== undefined || options.originalHeight !== undefined;
  if (transform && hasOriginalSize) {
    throw new RangeError('Specify either transform or original dimensions, not both');
  }
  if (transform) {
    assertPositiveInteger(transform.originalWidth, 'transform.originalWidth');
    assertPositiveInteger(transform.originalHeight, 'transform.originalHeight');
    if (!(transform.scaleX > 0) || !(transform.scaleY > 0)) {
      throw new RangeError('Coordinate transform scales must be positive');
    }
    return {
      x: Math.min(
        transform.originalWidth,
        Math.max(0, (point.x - transform.offsetX) / transform.scaleX),
      ),
      y: Math.min(
        transform.originalHeight,
        Math.max(0, (point.y - transform.offsetY) / transform.scaleY),
      ),
    };
  }
  if (hasOriginalSize) {
    const width = options.originalWidth;
    const height = options.originalHeight;
    if (width === undefined || height === undefined) {
      throw new RangeError('Both originalWidth and originalHeight are required');
    }
    assertPositiveInteger(width, 'originalWidth');
    assertPositiveInteger(height, 'originalHeight');
    return {
      x: Math.min(width, Math.max(0, (point.x * width) / map.width)),
      y: Math.min(height, Math.max(0, (point.y * height) / map.height)),
    };
  }
  return point;
}

function validateOptions(
  options: DbDecodeOptions,
): Required<Omit<DbDecodeOptions, 'transform' | 'originalWidth' | 'originalHeight'>> {
  const resolved = {
    threshold: options.threshold ?? DEFAULT_DB_OPTIONS.threshold,
    boxThreshold: options.boxThreshold ?? DEFAULT_DB_OPTIONS.boxThreshold,
    unclipRatio: options.unclipRatio ?? DEFAULT_DB_OPTIONS.unclipRatio,
    minSize: options.minSize ?? DEFAULT_DB_OPTIONS.minSize,
    maxCandidates: options.maxCandidates ?? DEFAULT_DB_OPTIONS.maxCandidates,
    verticalRatio: options.verticalRatio ?? DEFAULT_DB_OPTIONS.verticalRatio,
  };
  assertUnitInterval(resolved.threshold, 'threshold');
  assertUnitInterval(resolved.boxThreshold, 'boxThreshold');
  if (!Number.isFinite(resolved.unclipRatio) || resolved.unclipRatio < 0) {
    throw new RangeError('unclipRatio must be a non-negative finite number');
  }
  if (!Number.isFinite(resolved.minSize) || resolved.minSize < 0) {
    throw new RangeError('minSize must be a non-negative finite number');
  }
  if (!Number.isSafeInteger(resolved.maxCandidates) || resolved.maxCandidates < 0) {
    throw new RangeError('maxCandidates must be a non-negative integer');
  }
  if (!Number.isFinite(resolved.verticalRatio) || resolved.verticalRatio <= 0) {
    throw new RangeError('verticalRatio must be a positive finite number');
  }
  return resolved;
}

/** Decodes a PP-OCR DB probability map without canvas or native image dependencies. */
export function decodeDbProbabilityMap(
  map: ProbabilityMap,
  options: DbDecodeOptions = {},
): DetectedRegion[] {
  assertPositiveInteger(map.width, 'map.width');
  assertPositiveInteger(map.height, 'map.height');
  if (map.data.length !== map.width * map.height) {
    throw new RangeError('Probability-map data length does not match its dimensions');
  }
  for (let index = 0; index < map.data.length; index += 1) {
    const value = map.data[index];
    if (value === undefined) throw new RangeError('Probability-map data is incomplete');
    assertUnitInterval(value, `probability at index ${index}`);
  }
  const resolved = validateOptions(options);
  if (resolved.maxCandidates === 0) return [];

  const size = map.width * map.height;
  const visited = new Uint8Array(size);
  const candidates: Candidate[] = [];
  let sequence = 0;

  for (let start = 0; start < size; start += 1) {
    const initial = map.data[start];
    if (visited[start] || initial === undefined || initial <= resolved.threshold) continue;
    const stack = [start];
    const pixels: number[] = [];
    const boundaryPoints: MutablePoint[] = [];
    let confidence = 0;
    visited[start] = 1;

    while (stack.length > 0) {
      const pixel = stack.pop();
      if (pixel === undefined) break;
      pixels.push(pixel);
      const value = map.data[pixel];
      if (value !== undefined) confidence += value;
      const x = pixel % map.width;
      const y = Math.floor(pixel / map.width);
      let boundary = false;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= map.width || ny < 0 || ny >= map.height) {
            boundary = true;
            continue;
          }
          const neighbour = ny * map.width + nx;
          const probability = map.data[neighbour];
          if (probability === undefined || probability <= resolved.threshold) {
            boundary = true;
          } else if (!visited[neighbour]) {
            visited[neighbour] = 1;
            stack.push(neighbour);
          }
        }
      }

      if (boundary) {
        boundaryPoints.push({ x, y }, { x: x + 1, y }, { x: x + 1, y: y + 1 }, { x, y: y + 1 });
      }
    }

    const meanConfidence = confidence / pixels.length;
    if (meanConfidence < resolved.boxThreshold) continue;
    const hull = convexHull(boundaryPoints);
    const box = minimumAreaQuad(hull);
    const { width, height } = quadSides(box);
    if (Math.min(width, height) < resolved.minSize) continue;
    const expanded = unclipQuad(box, resolved.unclipRatio);
    const original = expanded.map((point) =>
      toOriginalPoint(point, map, options),
    ) as unknown as OcrQuad;
    candidates.push({ quad: original, confidence: meanConfidence, sequence });
    sequence += 1;
  }

  const selected = candidates
    .sort((a, b) => b.confidence - a.confidence || a.sequence - b.sequence)
    .slice(0, resolved.maxCandidates)
    .sort((a, b) => {
      const aTop = Math.min(...a.quad.map((point) => point.y));
      const bTop = Math.min(...b.quad.map((point) => point.y));
      const aLeft = Math.min(...a.quad.map((point) => point.x));
      const bLeft = Math.min(...b.quad.map((point) => point.x));
      return aTop - bTop || aLeft - bLeft || a.sequence - b.sequence;
    });

  return selected.map((candidate) => {
    const { width, height } = quadSides(candidate.quad);
    return {
      quad: candidate.quad,
      confidence: candidate.confidence,
      vertical: height / Math.max(width, Number.EPSILON) >= resolved.verticalRatio,
    };
  });
}
