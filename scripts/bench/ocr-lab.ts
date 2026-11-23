/**
 * OCR experiment lab.
 *
 * Runs a matrix of render scales, image preprocessing, DB detection, recognition shapes,
 * tiling, confidence-driven re-recognition and model pairings over committed fixtures with
 * ground truth. Every experiment reports CER/WER, reading order, block geometry and ms/page.
 *
 *   pnpm bench:ocr:lab --label baseline
 *   pnpm bench:ocr:lab --pairing tiny_det+small_rec --experiments scale200,otsu
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  characterErrorRate,
  blockIoU,
  columnOrderAccuracy,
  detectionRecallProxy,
  lineOrderAccuracy,
  wordErrorRate,
} from './ocr-metrics.ts';
import { FIXTURE_DIRECTORY, OCR_FIXTURES } from './ocr-fixtures.ts';
import { loadPairing, readRgbaFixture, type LoadedPairing, type Pairing } from './ocr-engine.ts';
import {
  applyOcrPreprocess,
  scaleOcrImage,
  type OcrPreprocessStep,
} from '../../src/engine/ocr/preprocess.ts';
import { OcrPipeline } from '../../src/engine/ocr/pipeline.ts';
import { decodeDbProbabilityMap } from '../../src/engine/ocr/db.ts';
import { decodeCtcGreedy } from '../../src/engine/ocr/ctc.ts';
import {
  cropForRecognition,
  preprocessDetection,
  preprocessRecognition,
  type DetectionPreprocessOptions,
} from '../../src/engine/ocr/image.ts';
import { groupReadingLines } from '../../src/engine/ocr/order.ts';
import type { ImageDataLike, OcrQuad, OcrRegion, OcrResult } from '../../src/engine/ocr/types.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, 'bench/results/ocr-lab');

/**
 * Fixed detection resolution for the lab. Every approach must be measured at this resolution
 * unless it explicitly declares a different `detectionMaxSide`, so preprocessing gains are not
 * confounded with a different detection downscale.
 */
export const DEFAULT_DETECTION_MAX_SIDE = 960;

export interface Experiment {
  readonly id: string;
  readonly category: string;
  readonly scale?: number;
  readonly steps?: readonly OcrPreprocessStep[];
  readonly detectionMaxSide?: number;
  readonly detection?: Record<string, number>;
  readonly recognition?: { height: number; maxWidth: number };
  readonly tiling?: { tile: number; overlap: number };
  readonly rerecognition?: { threshold: number; scale: number };
  readonly adaptiveThreshold?: number;
}

export const EXPERIMENTS: readonly Experiment[] = [
  {
    id: 'baseline',
    category: 'baseline',
    detectionMaxSide: DEFAULT_DETECTION_MAX_SIDE,
  },
  {
    id: 'dpi150',
    category: 'render',
    // The committed raster fixtures are 200 DPI; a true 150 DPI downscale is 960 * 0.75.
    scale: 0.75,
    detectionMaxSide: 720,
  },
  { id: 'dpi200', category: 'render', scale: 4 / 3, detectionMaxSide: 1280 },
  { id: 'dpi300', category: 'render', scale: 2, detectionMaxSide: 1920 },
  { id: 'gray', category: 'preprocess', steps: ['grayscale'] },
  { id: 'contrast', category: 'preprocess', steps: ['contrast'] },
  { id: 'gray+contrast', category: 'preprocess', steps: ['grayscale', 'contrast'] },
  { id: 'otsu', category: 'preprocess', steps: ['otsu'] },
  { id: 'sauvola', category: 'preprocess', steps: ['sauvola'] },
  { id: 'denoise', category: 'preprocess', steps: ['denoise'] },
  { id: 'deskew', category: 'preprocess', steps: ['deskew'] },
  { id: 'trim', category: 'preprocess', steps: ['trim-border'] },
  {
    id: 'gray+contrast+deskew',
    category: 'preprocess',
    steps: ['grayscale', 'contrast', 'deskew'],
  },
  { id: 'otsu+trim', category: 'preprocess', steps: ['otsu', 'trim-border'] },
  { id: 'sauvola+trim', category: 'preprocess', steps: ['sauvola', 'trim-border'] },
  { id: 'det-threshold-0.3', category: 'detection', detection: { threshold: 0.3 } },
  { id: 'det-threshold-0.1', category: 'detection', detection: { threshold: 0.1 } },
  { id: 'box-0.35', category: 'detection', detection: { boxThreshold: 0.35 } },
  { id: 'box-0.55', category: 'detection', detection: { boxThreshold: 0.55 } },
  { id: 'unclip-1.1', category: 'detection', detection: { unclipRatio: 1.1 } },
  { id: 'unclip-1.8', category: 'detection', detection: { unclipRatio: 1.8 } },
  { id: 'tiling-512-64', category: 'tiling', tiling: { tile: 512, overlap: 64 } },
  { id: 'rerun-0.5', category: 'confidence', rerecognition: { threshold: 0.5, scale: 1.5 } },
  { id: 'rerun-0.7', category: 'confidence', rerecognition: { threshold: 0.7, scale: 1.5 } },
  { id: 'adaptive-14', category: 'adaptive', adaptiveThreshold: 14 },
  { id: 'adaptive-18', category: 'adaptive', adaptiveThreshold: 18 },
  {
    id: 'best-combo',
    category: 'combined',
    scale: 4 / 3,
    steps: ['grayscale', 'contrast'],
    detectionMaxSide: 1280,
    recognition: { height: 48, maxWidth: 4096 },
  },
];

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined
    ? (process.argv[index + 1] ?? fallback)
    : fallback;
}
// The label is only a report filename; keep it inside the results directory.
const label = option('--label', 'run')
  .replace(/[^A-Za-z0-9._-]/gu, '_')
  .replace(/^\.\.+/u, '_');
const pairing = option('--pairing', 'tiny_det+small_rec') as Pairing;
const caseFilter = option('--cases', '').split(',').filter(Boolean);
const experimentFilter = option('--experiments', '').split(',').filter(Boolean);

const safe = (value: number): number => (Number.isFinite(value) ? value : 0);

function mapQuad(
  quad: OcrQuad,
  map: (point: { x: number; y: number }) => { x: number; y: number },
): OcrQuad {
  return quad.map(map) as unknown as OcrQuad;
}

function resultFromRegions(regions: readonly OcrRegion[]): OcrResult {
  const lines = groupReadingLines(regions);
  const text = lines
    .map((line) =>
      line.items.map((region) => region.text).join(line.orientation === 'horizontal' ? ' ' : ''),
    )
    .filter((value) => value.length > 0)
    .join('\n');
  return { regions: lines.flatMap((line) => line.items), lines, text };
}

function dedupeRegions(regions: readonly OcrRegion[]): OcrRegion[] {
  const kept: OcrRegion[] = [];
  for (const region of [...regions].sort(
    (a, b) => b.recognitionConfidence - a.recognitionConfidence,
  )) {
    const box = (quad: OcrQuad) => ({
      left: Math.min(...quad.map((point) => point.x)),
      right: Math.max(...quad.map((point) => point.x)),
      top: Math.min(...quad.map((point) => point.y)),
      bottom: Math.max(...quad.map((point) => point.y)),
    });
    const candidate = box(region.quad);
    const duplicate = kept.some((other) => {
      if (other.text !== region.text) return false;
      const target = box(other.quad);
      return (
        Math.abs((candidate.left + candidate.right) / 2 - (target.left + target.right) / 2) < 12 &&
        Math.abs((candidate.top + candidate.bottom) / 2 - (target.top + target.bottom) / 2) < 10
      );
    });
    if (!duplicate) kept.push(region);
  }
  return kept;
}

async function runTiled(
  loaded: LoadedPairing,
  image: ImageDataLike,
  experiment: Experiment,
): Promise<OcrResult> {
  const { tile, overlap } = experiment.tiling ?? { tile: 512, overlap: 64 };
  const regions: OcrRegion[] = [];
  for (let top = 0; top < image.height; top += tile - overlap) {
    for (let left = 0; left < image.width; left += tile - overlap) {
      const width = Math.min(tile, image.width - left);
      const height = Math.min(tile, image.height - top);
      if (width <= 8 || height <= 8) continue;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const source = ((top + y) * image.width + left + x) * 4;
          const target = (y * width + x) * 4;
          for (let channel = 0; channel < 4; channel += 1)
            data[target + channel] = image.data[source + channel] ?? 0;
        }
      }
      const partial = await loaded.pipeline.run({ data, width, height });
      for (const region of partial.regions) {
        regions.push({
          ...region,
          quad: mapQuad(region.quad, (point) => ({ x: point.x + left, y: point.y + top })),
        });
      }
    }
  }
  return resultFromRegions(dedupeRegions(regions));
}

export function detectionPreprocessFor(experiment: Experiment): DetectionPreprocessOptions {
  return { maxSide: experiment.detectionMaxSide ?? DEFAULT_DETECTION_MAX_SIDE, multiple: 32 };
}

async function runWithRerecognition(
  loaded: LoadedPairing,
  image: ImageDataLike,
  experiment: Experiment,
): Promise<OcrResult> {
  const { threshold, scale } = experiment.rerecognition ?? { threshold: 0.5, scale: 1.5 };
  const detectionInput = preprocessDetection(image, detectionPreprocessFor(experiment));
  const probabilityMap = await loaded.runner.detect(detectionInput.tensor);
  const detections = decodeDbProbabilityMap(
    {
      data: probabilityMap.data,
      height: probabilityMap.height,
      width: probabilityMap.width,
    },
    { ...loaded.detection, ...experiment.detection, transform: detectionInput.transform },
  );
  const regions: OcrRegion[] = [];
  for (const detection of detections) {
    const crop = cropForRecognition(image, detection.quad, loaded.detection.verticalRatio);
    const recognizeCrop = async (
      source: ImageDataLike,
    ): Promise<ReturnType<typeof decodeCtcGreedy>> => {
      const input = preprocessRecognition(
        source,
        experiment.recognition ?? { height: 48, maxWidth: 4096 },
      );
      return decodeCtcGreedy(await loaded.runner.recognize(input), loaded.dictionary, {
        useSpaceChar: true,
      });
    };
    let decoded = await recognizeCrop(crop.image);
    if (decoded.confidence < threshold || decoded.text.length < 3) {
      const enlarged = scaleOcrImage(crop.image, scale).image;
      const retry = await recognizeCrop(enlarged);
      if (retry.confidence > decoded.confidence || retry.text.length > decoded.text.length)
        decoded = retry;
    }
    regions.push({
      ...detection,
      vertical: crop.vertical,
      text: decoded.text,
      recognitionConfidence: decoded.confidence,
      symbolScores: decoded.symbolScores,
    });
  }
  return resultFromRegions(regions);
}

export function makePipeline(loaded: LoadedPairing, experiment: Experiment): LoadedPairing {
  // Never reuse loaded.pipeline: the pairing loads at the shipped 1600px default, while every
  // lab row must run at the fixed 960px baseline unless it explicitly varies detection size.
  return {
    ...loaded,
    pipeline: new OcrPipeline({
      runner: loaded.runner,
      dictionary: loaded.dictionary,
      useSpaceChar: true,
      detection: { ...loaded.detection, ...experiment.detection },
      detectionPreprocess: detectionPreprocessFor(experiment),
      recognitionPreprocess: experiment.recognition ?? { height: 48, maxWidth: 4096 },
    }),
  };
}

interface Summary {
  cer: number;
  wer: number;
  recall: number;
  order: number;
  column: number;
  blockIoU: number;
  ms: number;
  /** Cases that threw during the experiment; they are excluded from the timing mean. */
  failures: number;
}

interface CaseResult {
  fixture: string;
  cer: number;
  wer: number;
  recall: number;
  order: number;
  column: number;
  blockIoU: number;
  ms: number;
  lines: number;
  /** Failed cases keep accuracy zeros but must not contribute a fake 0 ms timing. */
  failed?: boolean;
}

async function main(): Promise<void> {
  const selectedExperiments = EXPERIMENTS.filter(
    (experiment) => experimentFilter.length === 0 || experimentFilter.includes(experiment.id),
  );
  const selectedFixtures = OCR_FIXTURES.filter(
    (fixture) => caseFilter.length === 0 || caseFilter.includes(fixture.id),
  );
  const loaded = await loadPairing(pairing);
  const images = new Map<string, ImageDataLike>();
  for (const fixture of selectedFixtures) {
    images.set(
      fixture.id,
      await readRgbaFixture(FIXTURE_DIRECTORY, fixture.id, fixture.width, fixture.height),
    );
  }
  const results: { experiment: string; category: string; cases: CaseResult[]; summary: Summary }[] =
    [];
  const warmImage = [...images.values()][0];
  try {
    // ONNX sessions and kernels are lazy: the first inference pays the warm-up cost. Run one
    // unreported inference on the loaded pairing before timing any experiment so the baseline
    // row is not biased by being first.
    if (warmImage && selectedExperiments.length > 0) {
      const warm = makePipeline(loaded, selectedExperiments[0] ?? EXPERIMENTS[0]!);
      await warm.pipeline.run(warmImage);
    }
    for (const experiment of selectedExperiments) {
      const variant = makePipeline(loaded, experiment);
      const cases: CaseResult[] = [];
      for (const fixture of selectedFixtures) {
        const source = images.get(fixture.id);
        if (!source) continue;
        try {
          const availableHeight = (quad: OcrQuad): number =>
            Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
          const medianHeight =
            fixture.lines.map((line) => availableHeight(line.quad)).sort((a, b) => a - b)[
              Math.floor(fixture.lines.length / 2)
            ] ?? 20;
          const scale =
            experiment.adaptiveThreshold !== undefined
              ? Math.max(1, Math.min(2, experiment.adaptiveThreshold / Math.max(1, medianHeight)))
              : (experiment.scale ?? 1);
          const preprocessed = applyOcrPreprocess(source, experiment.steps ?? [], scale);
          const started = performance.now();
          let result: OcrResult;
          if (experiment.tiling) result = await runTiled(variant, preprocessed.image, experiment);
          else if (experiment.rerecognition)
            result = await runWithRerecognition(variant, preprocessed.image, experiment);
          else result = await variant.pipeline.run(preprocessed.image);
          const ms = performance.now() - started;
          const mapped = result.regions.map((region) => ({
            ...region,
            quad: mapQuad(region.quad, preprocessed.mapBack),
          }));
          const mappedResult = resultFromRegions(dedupeRegions(mapped));
          const expectedText = fixture.lines.map((line) => line.text);
          const hypothesisText = mappedResult.lines.map((line) =>
            line.items
              .map((region) => region.text)
              .join(line.orientation === 'horizontal' ? ' ' : ''),
          );
          cases.push({
            fixture: fixture.id,
            cer: characterErrorRate(expectedText.join('\n'), mappedResult.text).rate,
            wer: wordErrorRate(expectedText.join('\n'), mappedResult.text).rate,
            recall: detectionRecallProxy(
              fixture.lines.map((line) => line.quad),
              mapped.map((region) => region.quad),
            ).recall,
            order: lineOrderAccuracy(expectedText, hypothesisText).accuracy,
            column: columnOrderAccuracy(
              fixture.lines.map((line) => line.quad),
              mapped.map((region) => region.quad),
              fixture.width,
            ),
            blockIoU: safe(
              blockIoU(
                fixture.lines.map((line) => line.quad),
                mapped.map((region) => region.quad),
              ),
            ),
            ms,
            lines: mappedResult.lines.length,
          });
        } catch (error) {
          cases.push({
            fixture: fixture.id,
            failed: true,
            cer: 1,
            wer: 1,
            recall: 0,
            order: 0,
            column: 0,
            blockIoU: 0,
            ms: 0,
            lines: 0,
          });
          console.error(
            'failed ' + experiment.id + ' on ' + fixture.id + ': ' + String(error).slice(0, 120),
          );
        }
      }
      const total = (key: 'cer' | 'wer') =>
        cases.reduce((sum, item) => sum + item[key], 0) / Math.max(1, cases.length);
      const mean = (key: 'recall' | 'order' | 'column' | 'blockIoU' | 'ms') => {
        const values = key === 'ms' ? cases.filter((item) => item.failed !== true) : cases;
        return values.reduce((sum, item) => sum + item[key], 0) / Math.max(1, values.length);
      };
      const failures = cases.filter((item) => item.failed === true).length;
      const summary = {
        cer: total('cer'),
        wer: total('wer'),
        recall: mean('recall'),
        order: mean('order'),
        column: mean('column'),
        blockIoU: mean('blockIoU'),
        ms: mean('ms'),
        failures,
      };
      results.push({ experiment: experiment.id, category: experiment.category, cases, summary });
      console.log(
        experiment.id.padEnd(22) +
          ' CER ' +
          (summary.cer * 100).toFixed(1).padStart(5) +
          '%' +
          ' WER ' +
          (summary.wer * 100).toFixed(1).padStart(5) +
          '%' +
          ' order ' +
          (summary.order * 100).toFixed(0).padStart(3) +
          '%' +
          ' col ' +
          (summary.column * 100).toFixed(0).padStart(3) +
          '%' +
          ' IoU ' +
          summary.blockIoU.toFixed(2) +
          ' ' +
          summary.ms.toFixed(0).padStart(5) +
          ' ms/page',
      );
    }
  } finally {
    await loaded.release();
  }
  const header =
    '| approach | CER | WER | line order | column order | block IoU | ms/page | notes |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |';
  const markdown =
    [
      '# OCR experiment lab — ' + label,
      '',
      'Pairing: ' + pairing + '. ' + selectedFixtures.map((fixture) => fixture.id).join(', ') + '.',
      'One unreported warm-up inference is run before timing; ms/page excludes it.',
      '',
      header,
      ...results.map((entry) => {
        const experiment = EXPERIMENTS.find((item) => item.id === entry.experiment);
        return (
          '| ' +
          entry.experiment +
          ' | ' +
          (entry.summary.cer * 100).toFixed(2) +
          '% | ' +
          (entry.summary.wer * 100).toFixed(1) +
          '% | ' +
          (entry.summary.order * 100).toFixed(1) +
          '% | ' +
          (entry.summary.column * 100).toFixed(1) +
          '% | ' +
          entry.summary.blockIoU.toFixed(2) +
          ' | ' +
          entry.summary.ms.toFixed(0) +
          ' | ' +
          entry.category +
          (experiment?.steps?.length ? ' ' + experiment.steps.join('+') : '') +
          ' |'
        );
      }),
    ].join('\n') + '\n';
  await mkdir(OUT, { recursive: true });
  await writeFile(
    join(OUT, label + '.json'),
    JSON.stringify({ label, pairing, warmups: warmImage ? 1 : 0, results }, null, 2) + '\n',
  );
  await writeFile(join(OUT, label + '.md'), markdown);
  console.log('\nwrote ' + join(OUT, label + '.md'));
}
const invokedAsScript =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript)
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
