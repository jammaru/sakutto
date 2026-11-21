import { orderQuad } from './db';
import type {
  DetectionPreprocessResult,
  ImageDataLike,
  OcrPoint,
  OcrQuad,
  OcrTensor,
} from './types';

export type RgbTriple = readonly [number, number, number];

export interface NormalizationConfig {
  readonly mean: RgbTriple;
  readonly std: RgbTriple;
}

export interface DetectionPreprocessOptions extends Partial<NormalizationConfig> {
  readonly maxSide?: number;
  readonly multiple?: number;
}

export interface RecognitionPreprocessOptions extends Partial<NormalizationConfig> {
  readonly height?: number;
  readonly maxWidth?: number;
}

export interface RecognitionCrop {
  readonly image: ImageDataLike;
  readonly vertical: boolean;
}

export const PP_OCR_DET_NORMALIZATION: Readonly<NormalizationConfig> = Object.freeze({
  mean: [0.485, 0.456, 0.406] as RgbTriple,
  std: [0.229, 0.224, 0.225] as RgbTriple,
});

export const PP_OCR_REC_NORMALIZATION: Readonly<NormalizationConfig> = Object.freeze({
  mean: [0.5, 0.5, 0.5] as RgbTriple,
  std: [0.5, 0.5, 0.5] as RgbTriple,
});

export const DEFAULT_RECOGNITION_HEIGHT = 48;
export const DEFAULT_RECOGNITION_MAX_WIDTH = 320;
export const DEFAULT_DETECTION_MAX_SIDE = 960;
export const DEFAULT_DETECTION_MULTIPLE = 32;

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function validateImage(image: ImageDataLike): void {
  assertPositiveInteger(image.width, 'image.width');
  assertPositiveInteger(image.height, 'image.height');
  if (image.data.length !== image.width * image.height * 4) {
    throw new RangeError('RGBA data length does not match image dimensions');
  }
}

function validateNormalization(config: NormalizationConfig): void {
  if (config.mean.length !== 3 || config.std.length !== 3) {
    throw new RangeError('Normalization mean and std must contain three channels');
  }
  for (let channel = 0; channel < 3; channel += 1) {
    const mean = config.mean[channel];
    const std = config.std[channel];
    if (mean === undefined || !Number.isFinite(mean)) {
      throw new RangeError('Normalization mean must contain finite numbers');
    }
    if (std === undefined || !Number.isFinite(std) || std <= 0) {
      throw new RangeError('Normalization std must contain positive finite numbers');
    }
  }
}

function parseTriple(source: string, name: 'mean' | 'std'): RgbTriple {
  const match = new RegExp(`(?:^|\\n)\\s*${name}\\s*:\\s*\\[([^\\]]+)\\]`).exec(source);
  if (!match?.[1]) throw new RangeError(`NormalizeImage ${name} is missing from inference.yml`);
  const values = match[1].split(',').map((entry) => Number(entry.replace(/#.*$/, '').trim()));
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new RangeError(`NormalizeImage ${name} must contain three finite numbers`);
  }
  const triple = values as unknown as RgbTriple;
  if (name === 'std') validateNormalization({ mean: [0, 0, 0], std: triple });
  return triple;
}

/** Reads the NormalizeImage mean/std arrays from a PaddleOCR inference.yml file. */
export function parseInferenceNormalization(yaml: string): NormalizationConfig {
  const block = /NormalizeImage\s*:\s*([\s\S]*?)(?=\n\s*-\s*[A-Za-z_]|$)/.exec(yaml)?.[1];
  if (block === undefined) throw new RangeError('NormalizeImage is missing from inference.yml');
  const config = { mean: parseTriple(block, 'mean'), std: parseTriple(block, 'std') };
  validateNormalization(config);
  return config;
}

function pixel(image: ImageDataLike, x: number, y: number): RgbTriple {
  if (x < 0 || x >= image.width || y < 0 || y >= image.height) return [0, 0, 0];
  const offset = (y * image.width + x) * 4;
  return [image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0];
}

function sampleRgb(image: ImageDataLike, x: number, y: number): RgbTriple {
  const left = Math.floor(x);
  const top = Math.floor(y);
  const fx = x - left;
  const fy = y - top;
  const topLeft = pixel(image, left, top);
  const topRight = pixel(image, left + 1, top);
  const bottomLeft = pixel(image, left, top + 1);
  const bottomRight = pixel(image, left + 1, top + 1);
  return [0, 1, 2].map((channel) => {
    const topValue = (topLeft[channel] ?? 0) * (1 - fx) + (topRight[channel] ?? 0) * fx;
    const bottomValue = (bottomLeft[channel] ?? 0) * (1 - fx) + (bottomRight[channel] ?? 0) * fx;
    return topValue * (1 - fy) + bottomValue * fy;
  }) as unknown as RgbTriple;
}

function putNormalized(
  target: Float32Array,
  pixelOffset: number,
  planeSize: number,
  rgb: RgbTriple,
  normalization: NormalizationConfig,
): void {
  for (let channel = 0; channel < 3; channel += 1) {
    const mean = normalization.mean[channel];
    const std = normalization.std[channel];
    if (mean === undefined || std === undefined)
      throw new RangeError('Invalid normalization config');
    target[pixelOffset + channel * planeSize] = ((rgb[channel] ?? 0) / 255 - mean) / std;
  }
}

/** Aspect-preserving detection resize, right/bottom padding, and normalized NCHW conversion. */
export function preprocessDetection(
  image: ImageDataLike,
  options: DetectionPreprocessOptions = {},
): DetectionPreprocessResult {
  validateImage(image);
  const normalization = {
    mean: options.mean ?? PP_OCR_DET_NORMALIZATION.mean,
    std: options.std ?? PP_OCR_DET_NORMALIZATION.std,
  };
  validateNormalization(normalization);
  const maxSide = options.maxSide ?? DEFAULT_DETECTION_MAX_SIDE;
  const multiple = options.multiple ?? DEFAULT_DETECTION_MULTIPLE;
  assertPositiveInteger(maxSide, 'maxSide');
  assertPositiveInteger(multiple, 'multiple');
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const resizedWidth = Math.max(1, Math.round(image.width * scale));
  const resizedHeight = Math.max(1, Math.round(image.height * scale));
  const width = Math.ceil(resizedWidth / multiple) * multiple;
  const height = Math.ceil(resizedHeight / multiple) * multiple;
  const planeSize = width * height;
  const data = new Float32Array(planeSize * 3);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgb: RgbTriple =
        x < resizedWidth && y < resizedHeight
          ? sampleRgb(
              image,
              (x + 0.5) * (image.width / resizedWidth) - 0.5,
              (y + 0.5) * (image.height / resizedHeight) - 0.5,
            )
          : [0, 0, 0];
      putNormalized(data, y * width + x, planeSize, rgb, normalization);
    }
  }

  return {
    tensor: { data, dims: [1, 3, height, width] },
    transform: {
      originalWidth: image.width,
      originalHeight: image.height,
      scaleX: resizedWidth / image.width,
      scaleY: resizedHeight / image.height,
      offsetX: 0,
      offsetY: 0,
    },
  };
}

/** Height-48, aspect-preserving recognition resize with zero padding and normalized NCHW output. */
export function preprocessRecognition(
  image: ImageDataLike,
  options: RecognitionPreprocessOptions = {},
): OcrTensor {
  validateImage(image);
  const normalization = {
    mean: options.mean ?? PP_OCR_REC_NORMALIZATION.mean,
    std: options.std ?? PP_OCR_REC_NORMALIZATION.std,
  };
  validateNormalization(normalization);
  const height = options.height ?? DEFAULT_RECOGNITION_HEIGHT;
  const maxWidth = options.maxWidth ?? DEFAULT_RECOGNITION_MAX_WIDTH;
  assertPositiveInteger(height, 'height');
  assertPositiveInteger(maxWidth, 'maxWidth');
  const naturalWidth = Math.max(1, Math.ceil((image.width * height) / image.height));
  const width = Math.min(maxWidth, naturalWidth);
  // PaddleOCR resize_norm_img always fills the model height and left-aligns the crop. Very
  // wide lines are squeezed to maxWidth; narrower lines use their natural aspect-ratio width.
  const resizedWidth = width;
  const resizedHeight = height;
  const xOffset = 0;
  const yOffset = 0;
  const planeSize = width * height;
  const data = new Float32Array(planeSize * 3);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - xOffset;
      const sourceY = y - yOffset;
      const rgb: RgbTriple =
        sourceX >= 0 && sourceX < resizedWidth && sourceY >= 0 && sourceY < resizedHeight
          ? sampleRgb(
              image,
              (sourceX + 0.5) * (image.width / resizedWidth) - 0.5,
              (sourceY + 0.5) * (image.height / resizedHeight) - 0.5,
            )
          : [0, 0, 0];
      putNormalized(data, y * width + x, planeSize, rgb, normalization);
    }
  }
  return { data, dims: [1, 3, height, width] };
}

function distance(a: OcrPoint, b: OcrPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function quadDimensions(quad: OcrQuad): { width: number; height: number } {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  return {
    width: Math.max(distance(topLeft, topRight), distance(bottomLeft, bottomRight)),
    height: Math.max(distance(topLeft, bottomLeft), distance(topRight, bottomRight)),
  };
}

export function isVerticalQuad(quad: OcrQuad, ratio = 1.5): boolean {
  if (!Number.isFinite(ratio) || ratio <= 0)
    throw new RangeError('Vertical ratio must be positive');
  const { width, height } = quadDimensions(quad);
  return height / Math.max(width, Number.EPSILON) >= ratio;
}

/** Perspective samples an ordered quad into a rectangular RGBA image. */
export function cropRotatedQuad(image: ImageDataLike, inputQuad: OcrQuad): ImageDataLike {
  validateImage(image);
  const quad = orderQuad(inputQuad);
  const dimensions = quadDimensions(quad);
  const width = Math.max(1, Math.round(dimensions.width));
  const height = Math.max(1, Math.round(dimensions.height));
  if (
    !Number.isFinite(dimensions.width + dimensions.height) ||
    Math.min(dimensions.width, dimensions.height) <= 0
  ) {
    throw new RangeError('Cannot crop a degenerate quadrilateral');
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;

  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const topX = topLeft.x + (topRight.x - topLeft.x) * u;
      const topY = topLeft.y + (topRight.y - topLeft.y) * u;
      const bottomX = bottomLeft.x + (bottomRight.x - bottomLeft.x) * u;
      const bottomY = bottomLeft.y + (bottomRight.y - bottomLeft.y) * u;
      const sourceX = topX + (bottomX - topX) * v - 0.5;
      const sourceY = topY + (bottomY - topY) * v - 0.5;
      const left = Math.floor(sourceX);
      const top = Math.floor(sourceY);
      const fx = sourceX - left;
      const fy = sourceY - top;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const read = (px: number, py: number): number => {
          if (px < 0 || px >= image.width || py < 0 || py >= image.height) return 0;
          return image.data[(py * image.width + px) * 4 + channel] ?? 0;
        };
        const topValue = read(left, top) * (1 - fx) + read(left + 1, top) * fx;
        const bottomValue = read(left, top + 1) * (1 - fx) + read(left + 1, top + 1) * fx;
        data[offset + channel] = topValue * (1 - fy) + bottomValue * fy;
      }
    }
  }
  return { data, width, height };
}

function rotateCounterClockwise(image: ImageDataLike): ImageDataLike {
  const data = new Uint8ClampedArray(image.data.length);
  const width = image.height;
  const height = image.width;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const source = (y * image.width + x) * 4;
      const destination = ((image.width - 1 - x) * width + y) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        data[destination + channel] = image.data[source + channel] ?? 0;
      }
    }
  }
  return { data, width, height };
}

/** Crops text and rotates tall Japanese boxes counter-clockwise for the horizontal recognizer. */
export function cropForRecognition(
  image: ImageDataLike,
  quad: OcrQuad,
  verticalRatio = 1.5,
): RecognitionCrop {
  const vertical = isVerticalQuad(quad, verticalRatio);
  const crop = cropRotatedQuad(image, quad);
  return { image: vertical ? rotateCounterClockwise(crop) : crop, vertical };
}
