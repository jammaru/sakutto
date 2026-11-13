import { boxBottom, boxRight, unionBox, type Box } from './geometry';
import type { TextLine } from './lines';
import type { PdfOperatorList } from './extract';

/**
 * Where a page's drawings are, so the text inside them can be left alone.
 *
 * A figure in a paper is not one object: it is a raster image, a few hundred vector paths, and
 * text drawn in the page's own coordinates. pdf.js reports all of it as one flat operator
 * list, so the only way to know that a caption-like line sits *inside* a diagram rather than
 * beside it is to reconstruct where the drawing painted.
 *
 * The area a figure occupies is taken from two things: images, whose drawn rectangle is exact,
 * and paths, whose union is an over-estimate (a path can be a rule or an underline). Text is
 * only treated as figure text when it sits inside the image area, which is the case that
 * matters — a diagram's boxes and axis labels — and never for a rule that happens to run under
 * a paragraph.
 */
export interface FigureAreas {
  /** Rects a raster image was painted into, in page units with the origin top-left. */
  images: Box[];
}

/** A 2D affine transform in pdf.js's `[a, b, c, d, e, f]` order. */
type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function apply(matrix: Matrix, x: number, y: number): { x: number; y: number } {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

/** The axis-aligned box of a transformed unit square, in PDF space. */
function unitSquare(matrix: Matrix): Box {
  const corners = [
    apply(matrix, 0, 0),
    apply(matrix, 1, 0),
    apply(matrix, 0, 1),
    apply(matrix, 1, 1),
  ];
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/**
 * Reads where the page paints its pictures.
 *
 * A figure in a paper is usually vector art: hundreds of `constructPath` operations, each in
 * page coordinates, with its labels drawn as ordinary text. There is no single object that
 * says "this is the figure", so the areas are inferred from what the page actually draws:
 *
 * - a raster image's drawn rectangle, which is exact;
 * - the union of path rectangles and explicit `rectangle` operators that are large enough to
 *   be part of a drawing rather than a rule, a table border or an underline. A rule is one
 *   path that is thin in one direction; a diagram is many paths that overlap in both.
 *
 * A single large path does not count on purpose: a table's outer border is one rectangle
 * drawn round a block of prose, and treating it as a figure would hide the table's text. A
 * figure is recognised by having *many* large paths in the same neighbourhood.
 *
 * The transform is tracked through `save`/`restore`/`transform` exactly as a renderer would,
 * so the rectangles are the ones finally drawn on the page.
 */
/**
 * A path cluster larger than this share of the page is a background, a rule grid or a
 * full-page frame, not a figure. Treating it as a figure would mark the title and the body
 * as labels with no room to grow.
 */
export const MAX_FIGURE_PAGE_SHARE = 0.35;

export function figureAreas(
  operators: PdfOperatorList | null,
  ops: Record<string, number> | null,
  pageHeight: number,
  pageWidth = 0,
  lines: readonly TextLine[] = [],
): FigureAreas {
  if (!operators || !ops) return { images: [] };

  const images: Box[] = [];
  const paths: Box[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;

  const save = ops.save;
  const restore = ops.restore;
  const transform = ops.transform;
  const paintImage = ops.paintImageXObject;
  const paintInline = ops.paintInlineImageXObject;
  const paintJpeg = ops.paintImageMaskXObject;
  const constructPath = ops.constructPath;
  const rectangle = ops.rectangle;

  const codes = new Set(
    [save, restore, transform, paintImage, paintInline, paintJpeg, constructPath, rectangle].filter(
      (code): code is number => typeof code === 'number',
    ),
  );

  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const fn = operators.fnArray[index];
    if (fn === undefined || !codes.has(fn)) continue;

    if (fn === save) {
      stack.push(ctm);
      continue;
    }
    if (fn === restore) {
      ctm = stack.pop() ?? IDENTITY;
      continue;
    }
    if (fn === transform) {
      const next = toMatrix(operators.argsArray[index]);
      if (next) ctm = multiply(ctm, next);
      continue;
    }
    if (fn === rectangle) {
      const rect = rectangleBounds(operators.argsArray[index], ctm);
      if (
        rect &&
        rect.width >= MIN_PATH_SIZE &&
        rect.height >= MIN_PATH_SIZE &&
        !coversAlmostPage(rect, pageWidth, pageHeight)
      ) {
        paths.push(flip(rect, pageHeight));
      }
      continue;
    }
    if (fn === constructPath) {
      const rect = pathBounds(operators.argsArray[index], ctm);
      if (
        rect &&
        rect.width >= MIN_PATH_SIZE &&
        rect.height >= MIN_PATH_SIZE &&
        !coversAlmostPage(rect, pageWidth, pageHeight)
      ) {
        paths.push(flip(rect, pageHeight));
      }
      continue;
    }

    // An image is drawn as the unit square under the CTM in force at that point.
    const rect = unitSquare(ctm);
    if (rect.width < 4 || rect.height < 4) continue;
    images.push(flip(rect, pageHeight));
  }

  const clusters = figureClusters(paths).filter(
    (box) => isPlausibleFigure(box, pageWidth, pageHeight) && !coversMostText(box, lines),
  );
  return { images: mergeContained([...images, ...clusters]) };
}

/** True when a cluster is small enough to be a drawing rather than the page itself. */
export function isPlausibleFigure(box: Box, pageWidth: number, pageHeight: number): boolean {
  if (pageWidth > 0 && box.width > pageWidth * 1.05) return false;
  if (pageHeight > 0 && box.height > pageHeight * 1.05) return false;
  const pageArea = pageWidth * pageHeight;
  if (pageArea > 0 && box.width * box.height > pageArea * MAX_FIGURE_PAGE_SHARE) return false;
  return true;
}

/**
 * True when a box contains most of the page's text. A cluster that large is a frame around
 * the article, not a figure, and the body inside it must stay prose.
 */
export function coversMostText(box: Box, lines: readonly TextLine[]): boolean {
  const readable = lines.filter((line) => line.text.trim().length > 0);
  if (readable.length < 4) return false;
  let inside = 0;
  for (const line of readable) {
    const centreX = line.box.x + line.box.width / 2;
    const centreY = line.box.y + line.box.height / 2;
    if (
      centreX >= box.x &&
      centreX <= box.x + box.width &&
      centreY >= box.y &&
      centreY <= box.y + box.height
    ) {
      inside += 1;
    }
  }
  return inside > readable.length * 0.5;
}

/** A path smaller than this in either direction is a rule, a tick or a glyph outline. */
const MIN_PATH_SIZE = 12;
/** A figure needs at least this many large paths in one neighbourhood. */
const MIN_CLUSTER_PATHS = 6;
/** Two paths are in the same neighbourhood when their boxes come this close, in points. */
const CLUSTER_GAP = 24;

/**
 * Groups large path rectangles into figures, and returns one box per group.
 *
 * A diagram's shapes overlap, so the groups fall out of a simple overlap test widened by
 * `CLUSTER_GAP`. A table's border cells also overlap, but a table has its text inside the
 * same rows, and the reader separately recognises a table and reads it cell by cell; a box
 * that ended up covering the table would leave its numbers untranslated, which is a smaller
 * error than painting over the drawing.
 */
function figureClusters(paths: readonly Box[]): Box[] {
  if (paths.length < MIN_CLUSTER_PATHS) return [];

  const remaining = [...paths];
  const groups: Box[] = [];
  while (remaining.length >= MIN_CLUSTER_PATHS) {
    const seed = remaining.shift();
    if (!seed) break;
    let group = seed;
    let grew = true;
    while (grew) {
      grew = false;
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        const candidate = remaining[index];
        if (!candidate) continue;
        if (!nearby(group, candidate, CLUSTER_GAP)) continue;
        group = union(group, candidate);
        remaining.splice(index, 1);
        grew = true;
      }
    }
    if (group.width >= 40 && group.height >= 40) groups.push(group);
  }
  return groups;
}

function nearby(left: Box, right: Box, gap: number): boolean {
  return (
    left.x - gap <= boxRight(right) &&
    boxRight(left) + gap >= right.x &&
    left.y - gap <= boxBottom(right) &&
    boxBottom(left) + gap >= right.y
  );
}

function union(left: Box, right: Box): Box {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return {
    x,
    y,
    width: Math.max(boxRight(left), boxRight(right)) - x,
    height: Math.max(boxBottom(left), boxBottom(right)) - y,
  };
}

/** A path's bounds from two opposite corners, after the transform in force. */
function boundsOfCorners(x1: number, y1: number, x2: number, y2: number, ctm: Matrix): Box {
  const first = apply(ctm, x1, y1);
  const second = apply(ctm, x2, y2);
  const left = Math.min(first.x, second.x);
  const top = Math.min(first.y, second.y);
  return {
    x: left,
    y: top,
    width: Math.abs(second.x - first.x),
    height: Math.abs(second.y - first.y),
  };
}

/**
 * The box a path's coordinates cover, after the transform in force.
 *
 * pdf.js passes the path's own min/max as the third argument. Prefer it when present: it is
 * the bounds of the painted path, whereas the coordinate list can contain control points and
 * points from a clip that extend past the visible drawing.
 */
function pathBounds(value: unknown, ctm: Matrix): Box | null {
  if (!Array.isArray(value)) return null;
  const minMax = value[2];
  if (Array.isArray(minMax) && minMax.length >= 4) {
    const [x1, y1, x2, y2] = minMax.slice(0, 4).map(Number);
    if ([x1, y1, x2, y2].every((entry) => Number.isFinite(entry))) {
      return boundsOfCorners(x1 as number, y1 as number, x2 as number, y2 as number, ctm);
    }
  }

  const coords = value[1];
  if (!Array.isArray(coords) || coords.length < 4) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index + 1 < coords.length; index += 2) {
    const x = Number(coords[index]);
    const y = Number(coords[index + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const point = apply(ctm, x, y);
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** An explicit rectangle operator, whose arguments are `x, y, width, height`. */
function rectangleBounds(value: unknown, ctm: Matrix): Box | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [x, y, width, height] = value.slice(0, 4).map(Number);
  if (![x, y, width, height].every((entry) => Number.isFinite(entry) && entry !== undefined)) {
    return null;
  }
  return boundsOfCorners(
    x as number,
    y as number,
    (x as number) + (width as number),
    (y as number) + (height as number),
    ctm,
  );
}

/** A clip rectangle that covers essentially the whole page is a frame, not a figure. */
function coversAlmostPage(box: Box, pageWidth: number, pageHeight: number): boolean {
  if (pageWidth <= 0 || pageHeight <= 0) return false;
  return box.width * box.height >= pageWidth * pageHeight * 0.95;
}

function toMatrix(value: unknown): Matrix | null {
  if (!Array.isArray(value) || value.length < 6) return null;
  const numbers = value.slice(0, 6).map(Number);
  if (numbers.some((entry) => !Number.isFinite(entry))) return null;
  return numbers as unknown as Matrix;
}

/** pdf.js draws in bottom-left space; the reader works top-left. */
function flip(box: Box, pageHeight: number): Box {
  return { x: box.x, y: pageHeight - boxBottom(box), width: box.width, height: box.height };
}

/**
 * Drops rectangles already inside another one, so a figure that paints a background and then
 * its contents reports one area rather than twenty.
 */
function mergeContained(boxes: readonly Box[]): Box[] {
  const sorted = [...boxes].sort(
    (left, right) => right.width * right.height - left.width * left.height,
  );
  const kept: Box[] = [];
  for (const box of sorted) {
    if (kept.some((outer) => contains(outer, box))) continue;
    kept.push(box);
  }
  return kept;
}

function contains(outer: Box, inner: Box): boolean {
  const margin = 1;
  return (
    inner.x >= outer.x - margin &&
    inner.y >= outer.y - margin &&
    boxRight(inner) <= boxRight(outer) + margin &&
    boxBottom(inner) <= boxBottom(outer) + margin
  );
}

/**
 * True when a line sits inside a figure's picture area.
 *
 * A small margin keeps a label that brushes the image's edge, which is where an axis tick
 * usually is; the line must also be mostly inside, so a caption that starts under a figure
 * and runs past its width is still read as a caption.
 */
export function insideFigure(line: TextLine, areas: FigureAreas): boolean {
  if (areas.images.length === 0) return false;
  const centre = {
    x: line.box.x + line.box.width / 2,
    y: line.box.y + line.box.height / 2,
  };
  return areas.images.some(
    (area) =>
      centre.x >= area.x &&
      centre.x <= boxRight(area) &&
      centre.y >= area.y &&
      centre.y <= boxBottom(area),
  );
}

/** The union of the figure areas, for a caller that wants to report them. */
export function figureBounds(areas: FigureAreas): Box | null {
  return unionBox(areas.images);
}
