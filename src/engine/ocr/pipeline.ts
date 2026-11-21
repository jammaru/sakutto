import { decodeCtcGreedy } from './ctc';
import { decodeDbProbabilityMap, type DbDecodeOptions } from './db';
import {
  cropForRecognition,
  PP_OCR_DET_NORMALIZATION,
  PP_OCR_REC_NORMALIZATION,
  preprocessDetection,
  preprocessRecognition,
  type DetectionPreprocessOptions,
  type RecognitionPreprocessOptions,
} from './image';
import { groupReadingLines, type ReadingOrderOptions } from './order';
import type { ImageDataLike, OcrResult, OcrRunner } from './types';

export interface OcrPipelineConfig {
  readonly runner: OcrRunner;
  /** PP-OCR dictionary order; class 1 is dictionary[0], and class 0 is reserved for blank. */
  readonly dictionary: readonly string[];
  readonly useSpaceChar?: boolean;
  readonly detection?: Omit<DbDecodeOptions, 'transform' | 'originalWidth' | 'originalHeight'>;
  readonly detectionPreprocess?: DetectionPreprocessOptions;
  readonly recognitionPreprocess?: RecognitionPreprocessOptions;
  readonly readingOrder?: ReadingOrderOptions;
}

export function throwIfOcrAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('OCR operation was aborted');
  error.name = 'AbortError';
  throw error;
}

/** Pure orchestration around injected detection and recognition sessions. */
export class OcrPipeline {
  readonly #config: OcrPipelineConfig;

  constructor(config: OcrPipelineConfig) {
    this.#config = config;
  }

  async run(image: ImageDataLike, signal?: AbortSignal): Promise<OcrResult> {
    throwIfOcrAborted(signal);
    const detectionInput = preprocessDetection(
      image,
      this.#config.detectionPreprocess ?? PP_OCR_DET_NORMALIZATION,
    );
    throwIfOcrAborted(signal);
    const probabilityMap = await this.#config.runner.detect(detectionInput.tensor, signal);
    throwIfOcrAborted(signal);
    const detections = decodeDbProbabilityMap(probabilityMap, {
      ...this.#config.detection,
      transform: detectionInput.transform,
    });

    const regions = [];
    for (const detection of detections) {
      throwIfOcrAborted(signal);
      const crop = cropForRecognition(image, detection.quad, this.#config.detection?.verticalRatio);
      const recognitionInput = preprocessRecognition(
        crop.image,
        this.#config.recognitionPreprocess ?? PP_OCR_REC_NORMALIZATION,
      );
      throwIfOcrAborted(signal);
      const output = await this.#config.runner.recognize(recognitionInput, signal);
      throwIfOcrAborted(signal);
      const decoded = decodeCtcGreedy(output, this.#config.dictionary, {
        useSpaceChar: this.#config.useSpaceChar ?? false,
      });
      regions.push({
        ...detection,
        vertical: crop.vertical,
        text: decoded.text,
        recognitionConfidence: decoded.confidence,
        symbolScores: decoded.symbolScores,
      });
    }

    throwIfOcrAborted(signal);
    const lines = groupReadingLines(regions, this.#config.readingOrder);
    const lineTexts = lines.map((line) => {
      const separator = line.orientation === 'horizontal' ? ' ' : '';
      return line.items
        .map((region) => region.text)
        .filter((text) => text.length > 0)
        .join(separator);
    });
    return {
      regions: lines.flatMap((line) => line.items),
      lines,
      text: lineTexts.filter((text) => text.length > 0).join('\n'),
    };
  }
}

export function runOcrPipeline(
  image: ImageDataLike,
  config: OcrPipelineConfig,
  signal?: AbortSignal,
): Promise<OcrResult> {
  return new OcrPipeline(config).run(image, signal);
}
