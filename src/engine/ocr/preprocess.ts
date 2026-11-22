/**
 * Pure image transforms for the OCR bench and on-device pipeline.
 */
import type { ImageDataLike, OcrPoint } from './types';

export interface PreprocessedImage {
  readonly image: ImageDataLike;
  readonly mapBack: (point: OcrPoint) => OcrPoint;
}

export type OcrPreprocessStep =
  | 'grayscale'
  | 'contrast'
  | 'otsu'
  | 'sauvola'
  | 'denoise'
  | 'deskew'
  | 'trim-border';

const identity = (point: OcrPoint): OcrPoint => ({ x: point.x, y: point.y });

function clone(image: ImageDataLike): Uint8ClampedArray {
  return new Uint8ClampedArray(image.data);
}

function luma(data: ArrayLike<number>, offset: number): number {
  return (data[offset] ?? 0) * 0.299 + (data[offset + 1] ?? 0) * 0.587 + (data[offset + 2] ?? 0) * 0.114;
}

function histogram(image: ImageDataLike): Uint32Array {
  const result = new Uint32Array(256);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const index = Math.round(luma(image.data, offset));
    result[index] = (result[index] ?? 0) + 1;
  }
  return result;
}

export function scaleOcrImage(image: ImageDataLike, factor: number): PreprocessedImage {
  if (!Number.isFinite(factor) || factor <= 0) throw new RangeError('scale must be positive');
  if (factor === 1) return { image, mapBack: identity };
  const width = Math.max(1, Math.round(image.width * factor));
  const height = Math.max(1, Math.round(image.height * factor));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.max(0, (y + 0.5) / factor - 0.5));
    const top = Math.floor(sourceY);
    const nextTop = Math.min(image.height - 1, top + 1);
    const fy = sourceY - top;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.max(0, (x + 0.5) / factor - 0.5));
      const left = Math.floor(sourceX);
      const nextLeft = Math.min(image.width - 1, left + 1);
      const fx = sourceX - left;
      const output = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const a = image.data[(top * image.width + left) * 4 + channel] ?? 0;
        const b = image.data[(top * image.width + nextLeft) * 4 + channel] ?? 0;
        const c = image.data[(nextTop * image.width + left) * 4 + channel] ?? 0;
        const d = image.data[(nextTop * image.width + nextLeft) * 4 + channel] ?? 0;
        data[output + channel] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      }
    }
  }
  return { image: { data, width, height }, mapBack: (point) => ({ x: point.x / factor, y: point.y / factor }) };
}

export function grayscaleOcrImage(image: ImageDataLike): PreprocessedImage {
  const data = clone(image);
  for (let offset = 0; offset < data.length; offset += 4) {
    const value = luma(image.data, offset);
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
  }
  return { image: { data, width: image.width, height: image.height }, mapBack: identity };
}

/** Histogram stretch of luminance, which lifts faint scan ink. */
export function contrastOcrImage(image: ImageDataLike, percentile = 0.02): PreprocessedImage {
  const counts = histogram(image);
  const total = image.width * image.height;
  let low = 0;
  let high = 255;
  let seen = 0;
  for (let value = 0; value < 256; value += 1) {
    seen += counts[value] ?? 0;
    if (seen >= total * percentile) { low = value; break; }
  }
  seen = 0;
  for (let value = 255; value >= 0; value -= 1) {
    seen += counts[value] ?? 0;
    if (seen >= total * percentile) { high = value; break; }
  }
  // A nearly blank scan puts both percentiles at 255; stretching that would paint it black.
  if (high - low < 8) return { image, mapBack: identity };
  const span = high - low;
  const data = clone(image);
  for (let offset = 0; offset < data.length; offset += 4) {
    const stretched = (Math.min(high, Math.max(low, luma(image.data, offset))) - low) * (255 / span);
    data[offset] = stretched;
    data[offset + 1] = stretched;
    data[offset + 2] = stretched;
  }
  return { image: { data, width: image.width, height: image.height }, mapBack: identity };
}

export function otsuBinarizeOcrImage(image: ImageDataLike): PreprocessedImage {
  const counts = histogram(image);
  const total = image.width * image.height;
  let sum = 0;
  for (let value = 0; value < 256; value += 1) sum += value * (counts[value] ?? 0);
  let weightBackground = 0;
  let sumBackground = 0;
  let best = -1;
  let threshold = 127;
  for (let value = 0; value < 256; value += 1) {
    weightBackground += counts[value] ?? 0;
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += value * (counts[value] ?? 0);
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (between > best) { best = between; threshold = value; }
  }
  const data = clone(image);
  for (let offset = 0; offset < data.length; offset += 4) {
    const value = luma(image.data, offset) < threshold ? 0 : 255;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
  }
  return { image: { data, width: image.width, height: image.height }, mapBack: identity };
}

/** Sauvola local threshold with integral images, so cost stays linear in pixels. */
export function sauvolaBinarizeOcrImage(image: ImageDataLike, radius = 8, k = 0.2): PreprocessedImage {
  const { width, height } = image;
  const stride = width + 1;
  const sums = new Float64Array(stride * (height + 1));
  const squares = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = luma(image.data, (y * width + x) * 4);
      sums[(y + 1) * stride + x + 1] = value + (sums[y * stride + x + 1] ?? 0) + (sums[(y + 1) * stride + x] ?? 0) - (sums[y * stride + x] ?? 0);
      squares[(y + 1) * stride + x + 1] = value * value + (squares[y * stride + x + 1] ?? 0) + (squares[(y + 1) * stride + x] ?? 0) - (squares[y * stride + x] ?? 0);
    }
  }
  const data = clone(image);
  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      const count = (right - left + 1) * (bottom - top + 1);
      const total = (sums[(bottom + 1) * stride + right + 1] ?? 0) - (sums[top * stride + right + 1] ?? 0) - (sums[(bottom + 1) * stride + left] ?? 0) + (sums[top * stride + left] ?? 0);
      const totalSquares = (squares[(bottom + 1) * stride + right + 1] ?? 0) - (squares[top * stride + right + 1] ?? 0) - (squares[(bottom + 1) * stride + left] ?? 0) + (squares[top * stride + left] ?? 0);
      const mean = total / count;
      const variance = Math.max(0, totalSquares / count - mean * mean);
      const threshold = mean * (1 + k * (Math.sqrt(variance) / 128 - 1));
      const value = luma(image.data, (y * width + x) * 4) < threshold ? 0 : 255;
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
    }
  }
  return { image: { data, width, height }, mapBack: identity };
}

/** 3x3 median of luminance; removes speckle without blurring glyph edges as much as a blur. */
export function denoiseOcrImage(image: ImageDataLike): PreprocessedImage {
  const { width, height } = image;
  const data = clone(image);
  const samples: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      samples.length = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          samples.push(luma(image.data, (py * width + px) * 4));
        }
      }
      samples.sort((a, b) => a - b);
      const value = samples[Math.floor(samples.length / 2)] ?? 0;
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
    }
  }
  return { image: { data, width, height }, mapBack: identity };
}

/** Crops blank margins with a small white border; returns the removed offset for geometry. */
export function trimOcrBorder(image: ImageDataLike, margin = 8): PreprocessedImage {
  const { width, height } = image;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (luma(image.data, (y * width + x) * 4) >= 245) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left) return { image, mapBack: identity };
  const cropLeft = Math.max(0, left - margin);
  const cropTop = Math.max(0, top - margin);
  const cropRight = Math.min(width, right + margin + 1);
  const cropBottom = Math.min(height, bottom + margin + 1);
  const cropWidth = cropRight - cropLeft;
  const cropHeight = cropBottom - cropTop;
  const data = new Uint8ClampedArray(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const source = ((y + cropTop) * width + x + cropLeft) * 4;
      const target = (y * cropWidth + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) data[target + channel] = image.data[source + channel] ?? 0;
    }
  }
  return {
    image: { data, width: cropWidth, height: cropHeight },
    mapBack: (point) => ({ x: point.x + cropLeft, y: point.y + cropTop }),
  };
}

function inverseRotation(point: OcrPoint, angle: number, width: number, height: number): OcrPoint {
  const radians = (-angle * Math.PI) / 180;
  const cx = width / 2;
  const cy = height / 2;
  const x = point.x - cx;
  const y = point.y - cy;
  return { x: cx + x * Math.cos(radians) - y * Math.sin(radians), y: cy + x * Math.sin(radians) + y * Math.cos(radians) };
}

function rotateImage(image: ImageDataLike, angle: number): ImageDataLike {
  const { width, height } = image;
  const data = new Uint8ClampedArray(image.data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = inverseRotation({ x, y }, angle, width, height);
      const sx = source.x;
      const sy = source.y;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      if (x0 < 0 || y0 < 0 || sx >= width || sy >= height) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const a = image.data[(y0 * width + x0) * 4 + channel] ?? 0;
        const b = image.data[(y0 * width + x1) * 4 + channel] ?? 0;
        const c = image.data[(y1 * width + x0) * 4 + channel] ?? 0;
        const d = image.data[(y1 * width + x1) * 4 + channel] ?? 0;
        data[target + channel] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      }
    }
  }
  return { data, width, height };
}

function estimateSkew(image: ImageDataLike): number {
  const step = 4;
  const sw = Math.ceil(image.width / step);
  const sh = Math.ceil(image.height / step);
  const dark = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      dark[y * sw + x] = luma(image.data, (y * step * image.width + x * step) * 4) < 180 ? 1 : 0;
    }
  }
  let bestAngle = 0;
  let bestScore = -1;
  for (let angle = -8; angle <= 8; angle += 0.5) {
    const radians = (angle * Math.PI) / 180;
    const rows = new Float64Array(sh * 2);
    for (let y = 0; y < sh; y += 1) {
      for (let x = 0; x < sw; x += 1) {
        const px = x - sw / 2;
        const py = y - sh / 2;
        const ry = Math.round(py * Math.cos(radians) + px * Math.sin(radians) + sh / 2);
        if (ry >= 0 && ry < sh * 2) rows[ry] = (rows[ry] ?? 0) + (dark[y * sw + x] ?? 0);
      }
    }
    let mean = 0;
    for (const value of rows) mean += value;
    mean /= rows.length;
    let variance = 0;
    for (const value of rows) variance += (value - mean) ** 2;
    if (variance > bestScore) { bestScore = variance; bestAngle = angle; }
  }
  return bestAngle;
}

/** Rotates the scan by the estimated opposite angle so text rows become horizontal. */
export function deskewOcrImage(image: ImageDataLike): PreprocessedImage {
  const angle = estimateSkew(image);
  if (angle === 0) return { image, mapBack: identity };
  return {
    image: rotateImage(image, -angle),
    mapBack: (point) => inverseRotation(point, -angle, image.width, image.height),
  };
}

function applyStep(current: PreprocessedImage, step: OcrPreprocessStep): PreprocessedImage {
  switch (step) {
    case 'grayscale':
      return { ...grayscaleOcrImage(current.image), mapBack: current.mapBack };
    case 'contrast':
      return { ...contrastOcrImage(current.image), mapBack: current.mapBack };
    case 'otsu':
      return { ...otsuBinarizeOcrImage(current.image), mapBack: current.mapBack };
    case 'sauvola':
      return { ...sauvolaBinarizeOcrImage(current.image), mapBack: current.mapBack };
    case 'denoise':
      return { ...denoiseOcrImage(current.image), mapBack: current.mapBack };
    case 'deskew': {
      const skewed = deskewOcrImage(current.image);
      return { image: skewed.image, mapBack: (point) => current.mapBack(skewed.mapBack(point)) };
    }
    case 'trim-border': {
      const trimmed = trimOcrBorder(current.image);
      return { image: trimmed.image, mapBack: (point) => current.mapBack(trimmed.mapBack(point)) };
    }
  }
}

export function applyOcrPreprocess(
  image: ImageDataLike,
  steps: readonly OcrPreprocessStep[],
  scale = 1,
): PreprocessedImage {
  let current = scale ? scaleOcrImage(image, scale) : { image, mapBack: identity };
  for (const step of steps) current = applyStep(current, step);
  return current;
}
