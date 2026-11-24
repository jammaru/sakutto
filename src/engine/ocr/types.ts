export interface OcrPoint {
  x: number;
  y: number;
}

/** Top-left, top-right, bottom-right, bottom-left. */
export type OcrQuad = readonly [OcrPoint, OcrPoint, OcrPoint, OcrPoint];

export interface ProbabilityMap {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

/** The subset of ImageData used by OCR, also usable without DOM canvas APIs. */
export interface ImageDataLike {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface OcrTensor {
  readonly data: Float32Array;
  readonly dims: readonly [1, 3, number, number];
}

/** Maps original image coordinates to model input coordinates. */
export interface ImageCoordinateTransform {
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface DetectionPreprocessResult {
  readonly tensor: OcrTensor;
  readonly transform: ImageCoordinateTransform;
}

export interface DetectedRegion {
  readonly quad: OcrQuad;
  readonly confidence: number;
  readonly vertical: boolean;
}

export interface CtcOutput {
  readonly data: ArrayLike<number>;
  /** [time, classes], or [1, time, classes] for a single-batch model output. */
  readonly dims: readonly number[];
}

export interface CtcDecodeResult {
  readonly text: string;
  /** Mean confidence of emitted, non-blank symbols; zero for an empty result. */
  readonly confidence: number;
  readonly symbolScores: readonly number[];
  readonly symbolIndices: readonly number[];
}

export interface OcrRegion extends DetectedRegion {
  readonly text: string;
  readonly recognitionConfidence: number;
  readonly symbolScores: readonly number[];
}

export type TextOrientation = 'horizontal' | 'vertical';

export interface ReadingLine<T> {
  readonly orientation: TextOrientation;
  readonly items: readonly T[];
  readonly indices: readonly number[];
}

export interface OcrResult {
  readonly regions: readonly OcrRegion[];
  readonly lines: readonly ReadingLine<OcrRegion>[];
  readonly text: string;
}

export type OcrInference<T> = (input: OcrTensor, signal?: AbortSignal) => T | Promise<T>;

/** Model execution is injected so this module has no ONNX Runtime dependency. */
export interface OcrRunner {
  readonly detect: OcrInference<ProbabilityMap>;
  readonly recognize: OcrInference<CtcOutput>;
}
