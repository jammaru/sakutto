import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRgbaFixture } from '../scripts/bench/ocr-engine.ts';
import {
  FIXTURE_DIRECTORY,
  FIXTURE_MANIFEST,
  OCR_FIXTURES,
  type BenchQuad,
} from '../scripts/bench/ocr-fixtures.ts';
import {
  characterErrorRate,
  detectionRecallProxy,
  intersectionOverUnion,
  levenshtein,
  normalizeOcrText,
  practicality,
  wordErrorRate,
  lineOrderAccuracy,
  columnOrderAccuracy,
  blockIoU,
} from '../scripts/bench/ocr-metrics.ts';
import { scaleOcrImage, otsuBinarizeOcrImage, contrastOcrImage } from '../src/engine/ocr/preprocess.ts';

const quad = (x: number, y: number, width: number, height: number): BenchQuad => [
  { x, y },
  { x: x + width, y },
  { x: x + width, y: y + height },
  { x, y: y + height },
];

describe('OCR benchmark generated fixtures', () => {
  it('covers all eight requested cases with deterministic CC0 ground truth', async () => {
    expect(OCR_FIXTURES.map((fixture) => fixture.id)).toEqual([
      'en-scan',
      'ja-horizontal',
      'ja-vertical',
      'slides',
      'low-res-skew',
      'two-column',
      'mixed-ja-en',
      'small-text',
    ]);
    const manifest = JSON.parse(await readFile(FIXTURE_MANIFEST, 'utf8')) as {
      license: string;
      attribution: string;
      fixtures: { id: string; groundTruth: string }[];
    };
    expect(manifest.license).toBe('CC0-1.0');
    expect(manifest.attribution).toContain('Generated');
    expect(manifest.fixtures).toHaveLength(8);
    for (const fixture of OCR_FIXTURES) {
      expect(fixture.lines.length).toBeGreaterThanOrEqual(5);
      expect(new Set(fixture.lines.map((line) => line.text)).size).toBe(fixture.lines.length);
      expect(manifest.fixtures.find((item) => item.id === fixture.id)?.groundTruth).toBe(
        fixture.lines.map((line) => line.text).join('\n'),
      );
      expect(await readFile(join(FIXTURE_DIRECTORY, fixture.id + '.svg'), 'utf8')).toBe(
        fixture.svg,
      );
      const rgba = await readRgbaFixture(
        FIXTURE_DIRECTORY,
        fixture.id,
        fixture.width,
        fixture.height,
      );
      expect(rgba.data.length).toBe(fixture.width * fixture.height * 4);
      const png = await readFile(join(FIXTURE_DIRECTORY, fixture.id + '.png'));
      expect(png.subarray(1, 4).toString()).toBe('PNG');
    }
    expect(OCR_FIXTURES.find((fixture) => fixture.id === 'ja-vertical')?.orientation).toBe(
      'vertical',
    );
    expect(
      OCR_FIXTURES.find((fixture) => fixture.id === 'low-res-skew')?.lines[0]?.quad[0]?.x,
    ).not.toBe(120);
  });
});

describe('OCR benchmark metrics', () => {
  it('computes edit distance, Unicode CER, and whitespace WER', () => {
    expect(levenshtein(Array.from('kitten'), Array.from('sitting'))).toBe(3);
    expect(normalizeOcrText('  A\n\tB  ')).toBe('A B');
    expect(characterErrorRate('ab cd', 'ab xd')).toEqual({
      distance: 1,
      referenceUnits: 5,
      rate: 0.2,
    });
    expect(characterErrorRate('翻訳', '翻').rate).toBe(0.5);
    expect(wordErrorRate('one two three', 'one two')).toEqual({
      distance: 1,
      referenceUnits: 3,
      rate: 1 / 3,
    });
    expect(characterErrorRate('', '').rate).toBe(0);
  });
  it('uses deterministic one-to-one IoU matching for the recall proxy', () => {
    const a = quad(0, 0, 10, 10);
    expect(intersectionOverUnion(a, a)).toBe(1);
    expect(intersectionOverUnion(a, quad(20, 20, 5, 5))).toBe(0);
    const recall = detectionRecallProxy([a, quad(30, 0, 10, 10)], [a]);
    expect(recall).toEqual({ matched: 1, reference: 2, recall: 0.5, threshold: 0.3 });
    expect(detectionRecallProxy([a], [quad(1, 0, 10, 10)]).matched).toBe(1);
  });
  it('labels per-case practicality with documented thresholds', () => {
    expect(practicality(0.15, 0.8)).toBe('practical');
    expect(practicality(0.4, 0.5)).toBe('marginal');
    expect(practicality(0.41, 1)).toBe('not practical');
    expect(practicality(0.1, 0.49)).toBe('not practical');
  });
});


describe('OCR preprocessing and layout metrics', () => {
  const tiny = {
    data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 20, 20, 20, 255, 240, 240, 240, 255]),
    width: 2,
    height: 2,
  };
  it('scales an image and maps quads back to source coordinates', () => {
    const scaled = scaleOcrImage(tiny, 2);
    expect(scaled.image.width).toBe(4);
    expect(scaled.image.height).toBe(4);
    expect(scaled.mapBack({ x: 3, y: 5 })).toEqual({ x: 1.5, y: 2.5 });
  });
  it('normalizes contrast and binarizes without changing geometry', () => {
    for (const processed of [contrastOcrImage(tiny), otsuBinarizeOcrImage(tiny)]) {
      expect(processed.image.width).toBe(2);
      expect(processed.mapBack({ x: 1, y: 1 })).toEqual({ x: 1, y: 1 });
      expect(processed.image.data[0]).toBe(processed.image.data[1]);
    }
  });
  it('scores reading order, column order and block geometry', () => {
    expect(lineOrderAccuracy(['a b', 'c d'], ['a b', 'c d']).accuracy).toBe(1);
    expect(lineOrderAccuracy(['a b', 'c d'], ['c d', 'a b']).accuracy).toBe(0);
    expect(columnOrderAccuracy([quad(0, 0, 10, 10), quad(50, 0, 10, 10)], [quad(0, 0, 10, 10), quad(50, 0, 10, 10)], 100)).toBe(1);
    expect(blockIoU([quad(0, 0, 10, 10)], [quad(0, 0, 10, 10)])).toBe(1);
  });
});
describe('optional real tiny-model OCR smoke', () => {
  it.runIf(process.env.OCR_BENCH_SMOKE === '1')(
    'runs official tiny_det + small_rec on generated EN scan',
    async () => {
      const { loadPairing, readRgbaFixture, runTimed } =
        await import('../scripts/bench/ocr-engine.ts');
      const fixture = OCR_FIXTURES[0];
      if (!fixture) throw new Error('Missing EN fixture');
      const loaded = await loadPairing('tiny_det+small_rec');
      try {
        const image = await readRgbaFixture(
          FIXTURE_DIRECTORY,
          fixture.id,
          fixture.width,
          fixture.height,
        );
        const { result } = await runTimed(loaded.pipeline, image);
        expect(result.regions.length).toBeGreaterThanOrEqual(6);
        expect(result.text).toContain('LOCAL TRANSLATION NOTES');
        expect(result.text).toContain('private tool');
        expect(
          characterErrorRate(fixture.lines.map((line) => line.text).join('\n'), result.text).rate,
        ).toBeLessThan(0.1);
      } finally {
        await loaded.release();
      }
    },
    30_000,
  );
});
