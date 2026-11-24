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

export type OcrPhase =
  | 'preprocess-detection'
  | 'detect'
  | 'decode-boxes'
  | 'recognize'
  | 'decode-text'
  | 'reading-order';

export interface OcrPipelineConfig {
  readonly runner: OcrRunner;
  /** PP-OCR dictionary order; class 1 is dictionary[0], and class 0 is reserved for blank. */
  readonly dictionary: readonly string[];
  readonly useSpaceChar?: boolean;
  readonly detection?: Omit<DbDecodeOptions, 'transform' | 'originalWidth' | 'originalHeight'>;
  readonly detectionPreprocess?: DetectionPreprocessOptions;
  readonly recognitionPreprocess?: RecognitionPreprocessOptions;
  readonly readingOrder?: ReadingOrderOptions;
  /**
   * Awaited between ONNX runs. ORT runs WASM on the offscreen document's main thread
   * (`proxy: false`), so a macrotask boundary — not just a microtask await — is what
   * lets that thread answer status/ping port messages while a page is being read.
   * Injectable so tests can observe it without depending on timer scheduling.
   */
  readonly yieldBetweenRuns?: () => Promise<void>;
  /** Optional telemetry: phase durations in milliseconds. Default is a no-op. */
  readonly onPhase?: (phase: OcrPhase, ms: number) => void;
  /** Optional progressive UX hook: number of text boxes recognised so far. */
  readonly onRegions?: (count: number) => void;
}

export function throwIfOcrAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('OCR operation was aborted');
  error.name = 'AbortError';
  throw error;
}

/** A macrotask boundary; microtask awaits alone do not let extension port messages through. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Pure orchestration around injected detection and recognition sessions. */
export class OcrPipeline {
  readonly #config: OcrPipelineConfig;

  constructor(config: OcrPipelineConfig) {
    this.#config = config;
  }

  async run(image: ImageDataLike, signal?: AbortSignal): Promise<OcrResult> {
    throwIfOcrAborted(signal);
    const yieldBetweenRuns = this.#config.yieldBetweenRuns ?? yieldToEventLoop;
    const phaseStart = performance.now();
    const mark = (phase: OcrPhase, since: number = phaseStart): void => {
      this.#config.onPhase?.(phase, performance.now() - since);
    };
    const detectionInput = preprocessDetection(
      image,
      this.#config.detectionPreprocess ?? PP_OCR_DET_NORMALIZATION,
    );
    mark('preprocess-detection');
    throwIfOcrAborted(signal);
    const detectStart = performance.now();
    const probabilityMap = await this.#config.runner.detect(detectionInput.tensor, signal);
    mark('detect', detectStart);
    throwIfOcrAborted(signal);
    const boxesStart = performance.now();
    const detections = decodeDbProbabilityMap(probabilityMap, {
      ...this.#config.detection,
      transform: detectionInput.transform,
    });
    mark('decode-boxes', boxesStart);
    const recognizeStart = performance.now();

    const regions = [];
    for (const detection of detections) {
      // One WASM call is short, but a scan has tens of boxes. Yield before each one so the
      // host can drain queued port messages (status, inspect, ping) between recognitions
      // instead of appearing dead and being torn down mid-page.
      await yieldBetweenRuns();
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
      this.#config.onRegions?.(regions.length);
    }
    mark('recognize', recognizeStart);
    const decodeStart = performance.now();

    throwIfOcrAborted(signal);
    mark('decode-text', decodeStart);
    const orderStart = performance.now();
    const lines = groupReadingLines(regions, this.#config.readingOrder);
    mark('reading-order', orderStart);
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
