/**
 * Geometry for the PDF reader.
 *
 * Every coordinate is in PDF user units (points, 72 per inch) with the origin at the top
 * left of the page and y growing downwards. That is the space a browser lays out in, so the
 * renderer can multiply by one scale factor and be done; the extractor converts pdf.js's
 * bottom-left space into this one exactly once.
 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function boxRight(box: Box): number {
  return box.x + box.width;
}

export function boxBottom(box: Box): number {
  return box.y + box.height;
}

/** The smallest box that holds every one of them, or null for an empty list. */
export function unionBox(boxes: readonly Box[]): Box | null {
  const first = boxes[0];
  if (!first) return null;
  let left = first.x;
  let top = first.y;
  let right = boxRight(first);
  let bottom = boxBottom(first);
  for (const box of boxes.slice(1)) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, boxRight(box));
    bottom = Math.max(bottom, boxBottom(box));
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Overlapping area of two boxes, or 0 when they do not touch. */
export function intersectionArea(left: Box, right: Box): number {
  const width = Math.min(boxRight(left), boxRight(right)) - Math.max(left.x, right.x);
  const height = Math.min(boxBottom(left), boxBottom(right)) - Math.max(left.y, right.y);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}
