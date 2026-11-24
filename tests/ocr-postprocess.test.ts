import { describe, expect, it, vi } from 'vitest';
import { decodeCtcGreedy } from '@/engine/ocr/ctc';
import { decodeDbProbabilityMap, orderQuad } from '@/engine/ocr/db';
import {
  cropForRecognition,
  cropRotatedQuad,
  isVerticalQuad,
  parseInferenceNormalization,
  preprocessDetection,
  preprocessRecognition,
} from '@/engine/ocr/image';
import { groupReadingLines, orderTextRegions } from '@/engine/ocr/order';
import { OcrPipeline, runOcrPipeline } from '@/engine/ocr/pipeline';
import type {
  CtcOutput,
  ImageDataLike,
  OcrQuad,
  OcrTensor,
  ProbabilityMap,
} from '@/engine/ocr/types';

function rgba(
  width: number,
  height: number,
  color: readonly [number, number, number, number] = [255, 255, 255, 255],
): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
  return { data, width, height };
}

function coloredImage(
  colors: readonly (readonly [number, number, number, number])[],
  width: number,
): ImageDataLike {
  const data = new Uint8ClampedArray(colors.length * 4);
  colors.forEach((color, index) => data.set(color, index * 4));
  return { data, width, height: colors.length / width };
}

function quad(x: number, y: number, width: number, height: number): OcrQuad {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function mapWithRectangles(
  width: number,
  height: number,
  rectangles: readonly { x: number; y: number; width: number; height: number; score: number }[],
): ProbabilityMap {
  const data = new Float32Array(width * height);
  for (const rectangle of rectangles) {
    for (let y = rectangle.y; y < rectangle.y + rectangle.height; y += 1) {
      for (let x = rectangle.x; x < rectangle.x + rectangle.width; x += 1) {
        data[y * width + x] = rectangle.score;
      }
    }
  }
  return { data, width, height };
}

function ctc(indices: readonly number[], classCount = 4, score = 0.9): CtcOutput {
  const data = new Float32Array(indices.length * classCount);
  data.fill(0.01);
  indices.forEach((classIndex, time) => {
    data[time * classCount + classIndex] = score;
  });
  return { data, dims: [indices.length, classCount] };
}

describe('DB probability-map decoding', () => {
  it('finds connected regions, averages confidence, and emits ordered quads', () => {
    const map = mapWithRectangles(8, 8, [{ x: 1, y: 1, width: 4, height: 3, score: 0.9 }]);
    const regions = decodeDbProbabilityMap(map, {
      unclipRatio: 0,
      minSize: 0,
      boxThreshold: 0.6,
    });

    expect(regions).toHaveLength(1);
    expect(regions[0]?.confidence).toBeCloseTo(0.9);
    expect(regions[0]?.quad).toEqual(quad(1, 1, 4, 3));
    expect(regions[0]?.vertical).toBe(false);
  });

  it('uses eight-connectivity for diagonal foreground pixels', () => {
    const data = new Float32Array(49);
    data[1 * 7 + 1] = 0.9;
    data[2 * 7 + 2] = 0.9;
    data[3 * 7 + 3] = 0.9;
    data[6 * 7 + 6] = 0.9;
    const regions = decodeDbProbabilityMap(
      { data, width: 7, height: 7 },
      { unclipRatio: 0, minSize: 0, boxThreshold: 0.6 },
    );
    expect(regions).toHaveLength(2);
  });

  it('applies threshold and connected-region confidence filtering', () => {
    const map = mapWithRectangles(14, 7, [
      { x: 0, y: 0, width: 4, height: 4, score: 0.5 },
      { x: 8, y: 0, width: 4, height: 4, score: 0.9 },
    ]);
    expect(
      decodeDbProbabilityMap(map, { threshold: 0.9, unclipRatio: 0, minSize: 0 }),
    ).toHaveLength(0);
    const filtered = decodeDbProbabilityMap(map, {
      boxThreshold: 0.6,
      unclipRatio: 0,
      minSize: 0,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.confidence).toBeCloseTo(0.9);
  });

  it('expands boxes by the DB unclip area/perimeter distance', () => {
    const map = mapWithRectangles(10, 10, [{ x: 2, y: 2, width: 4, height: 2, score: 1 }]);
    const plain = decodeDbProbabilityMap(map, { unclipRatio: 0, minSize: 0 })[0];
    const expanded = decodeDbProbabilityMap(map, { unclipRatio: 1.5, minSize: 0 })[0];
    expect(plain?.quad).toEqual(quad(2, 2, 4, 2));
    expect(expanded?.quad).toEqual(quad(1, 1, 6, 4));
  });

  it('maps padded model coordinates back to the original image', () => {
    const map = mapWithRectangles(12, 10, [{ x: 2, y: 2, width: 4, height: 3, score: 0.9 }]);
    const regions = decodeDbProbabilityMap(map, {
      unclipRatio: 0,
      minSize: 0,
      transform: {
        originalWidth: 20,
        originalHeight: 16,
        scaleX: 0.5,
        scaleY: 0.5,
        offsetX: 0,
        offsetY: 0,
      },
    });
    expect(regions[0]?.quad).toEqual(quad(4, 4, 8, 6));
  });

  it('supports direct original-size scaling and clamps unclipped coordinates', () => {
    const map = mapWithRectangles(10, 8, [{ x: 0, y: 0, width: 6, height: 5, score: 0.9 }]);
    const regions = decodeDbProbabilityMap(map, {
      unclipRatio: 2,
      minSize: 0,
      originalWidth: 20,
      originalHeight: 16,
    });
    expect(regions[0]?.quad[0]).toEqual({ x: 0, y: 0 });
  });

  it('keeps only the highest-confidence max candidates', () => {
    const map = mapWithRectangles(30, 7, [
      { x: 0, y: 0, width: 4, height: 4, score: 0.7 },
      { x: 10, y: 0, width: 4, height: 4, score: 0.9 },
      { x: 20, y: 0, width: 4, height: 4, score: 0.8 },
    ]);
    const regions = decodeDbProbabilityMap(map, {
      boxThreshold: 0.6,
      maxCandidates: 2,
      unclipRatio: 0,
      minSize: 0,
    });
    expect(regions).toHaveLength(2);
    expect(regions[0]?.confidence).toBeCloseTo(0.9);
    expect(regions[1]?.confidence).toBeCloseTo(0.8);
    expect(regions.some((region) => region.confidence < 0.75)).toBe(false);
  });

  it('filters tiny regions and identifies tall Japanese boxes', () => {
    const map = mapWithRectangles(10, 12, [{ x: 2, y: 1, width: 2, height: 8, score: 0.9 }]);
    expect(decodeDbProbabilityMap(map, { unclipRatio: 0, minSize: 3 })).toHaveLength(0);
    const vertical = decodeDbProbabilityMap(map, { unclipRatio: 0, minSize: 0 })[0];
    expect(vertical?.vertical).toBe(true);
    expect(isVerticalQuad(vertical?.quad ?? quad(0, 0, 1, 1))).toBe(true);
  });

  it('orders shuffled rectangle corners clockwise from top-left', () => {
    const points = quad(2, 3, 5, 7);
    expect(orderQuad([points[2], points[0], points[3], points[1]])).toEqual(points);
  });

  it('rejects malformed maps and options', () => {
    expect(() => decodeDbProbabilityMap({ data: [0], width: 2, height: 2 })).toThrow(/length/);
    expect(() => decodeDbProbabilityMap({ data: [Number.NaN], width: 1, height: 1 })).toThrow(
      /probability/,
    );
    expect(() =>
      decodeDbProbabilityMap({ data: [0], width: 1, height: 1 }, { threshold: -1 }),
    ).toThrow(/threshold/);
    expect(() =>
      decodeDbProbabilityMap({ data: [0], width: 1, height: 1 }, { maxCandidates: -1 }),
    ).toThrow(/maxCandidates/);
  });
});

describe('CTC greedy decoding', () => {
  it('collapses repeats but preserves symbols repeated across blanks', () => {
    const result = decodeCtcGreedy(ctc([1, 1, 1, 0, 1, 2, 2, 0], 3), ['a', 'b']);
    expect(result.text).toBe('aab');
    expect(result.symbolIndices).toEqual([1, 1, 2]);
    expect(result.symbolScores).toHaveLength(3);
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  it('handles blank-only output and chooses class zero on ties', () => {
    const blank = decodeCtcGreedy(ctc([0, 0, 0], 3), ['a', 'b']);
    expect(blank).toMatchObject({ text: '', confidence: 0, symbolScores: [], symbolIndices: [] });
    const tied = decodeCtcGreedy({ data: new Float32Array(9).fill(0.25), dims: [3, 3] }, [
      'a',
      'b',
    ]);
    expect(tied.text).toBe('');
  });

  it('supports [1, time, classes] model output and multi-character dictionary entries', () => {
    const output = ctc([1, 2], 3);
    const result = decodeCtcGreedy({ ...output, dims: [1, 2, 3] }, ['ch', 'あ']);
    expect(result.text).toBe('chあ');
  });

  it('appends ASCII space after the supplied PP-OCR dictionary when enabled', () => {
    const output = ctc([1, 3, 2], 4);
    expect(decodeCtcGreedy(output, ['あ', 'い'], { useSpaceChar: true }).text).toBe('あ い');
    expect(() => decodeCtcGreedy(output, ['あ', 'い'])).toThrow(/expected 3/);
  });

  it('rejects malformed dimensions, data, dictionaries, and class counts', () => {
    expect(() => decodeCtcGreedy({ data: [], dims: [2, 2, 3] }, ['a'])).toThrow(/shape/);
    expect(() => decodeCtcGreedy({ data: [], dims: [0, 2] }, ['a'])).toThrow(/time/);
    expect(() => decodeCtcGreedy({ data: [1], dims: [1, 2] }, ['a'])).toThrow(/length/);
    expect(() => decodeCtcGreedy(ctc([1], 3), ['a'])).toThrow(/classes/);
    expect(() => decodeCtcGreedy(ctc([1], 2), [''])).toThrow(/empty/);
    const invalid = ctc([1], 2);
    const data = Float32Array.from(invalid.data);
    data[0] = Number.NaN;
    expect(() => decodeCtcGreedy({ ...invalid, data }, ['a'])).toThrow(/probability/);
    data[0] = -0.1;
    expect(() => decodeCtcGreedy({ ...invalid, data }, ['a'])).toThrow(/probability/);
  });
});

describe('OCR image preprocessing and crops', () => {
  it('parses NormalizeImage mean and std from inference.yml', () => {
    const config = parseInferenceNormalization(`
PreProcess:
  transform_ops:
    - NormalizeImage:
        std: [0.229, 0.224, 0.225] # RGB
        mean: [0.485, 0.456, 0.406]
        order: hwc
    - ToCHWImage:
`);
    expect(config.mean).toEqual([0.485, 0.456, 0.406]);
    expect(config.std).toEqual([0.229, 0.224, 0.225]);
    expect(() => parseInferenceNormalization('PreProcess: []')).toThrow(/NormalizeImage/);
    expect(() =>
      parseInferenceNormalization(`NormalizeImage:
 mean: [0, 0]
 std: [1, 1, 1]`),
    ).toThrow(/three/);
  });

  it('creates normalized RGB-planar NCHW detection input with right/bottom padding', () => {
    const result = preprocessDetection(rgba(1, 1, [255, 128, 0, 255]), {
      mean: [0, 0, 0],
      std: [1, 1, 1],
      multiple: 4,
      maxSide: 10,
    });
    expect(result.tensor.dims).toEqual([1, 3, 4, 4]);
    expect(result.tensor.data[0]).toBeCloseTo(1);
    expect(result.tensor.data[16]).toBeCloseTo(128 / 255);
    expect(result.tensor.data[32]).toBe(0);
    expect(result.tensor.data[1]).toBe(0);
    expect(result.transform).toMatchObject({ scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 });
  });

  it('preserves detection aspect ratio and records original-coordinate scaling', () => {
    const result = preprocessDetection(rgba(100, 50), {
      mean: [0, 0, 0],
      std: [1, 1, 1],
      maxSide: 50,
      multiple: 8,
    });
    expect(result.tensor.dims).toEqual([1, 3, 32, 56]);
    expect(result.transform).toMatchObject({
      originalWidth: 100,
      originalHeight: 50,
      scaleX: 0.5,
      scaleY: 0.5,
    });
  });

  it('resizes recognition crops to height 48 while preserving aspect ratio', () => {
    const tensor = preprocessRecognition(rgba(100, 50, [255, 255, 255, 255]));
    expect(tensor.dims).toEqual([1, 3, 48, 96]);
    expect(tensor.data[0]).toBeCloseTo(1);
    expect(tensor.data[48 * 96]).toBeCloseTo(1);
  });

  it('caps very wide recognition inputs and fills the model height like PaddleOCR', () => {
    const tensor = preprocessRecognition(rgba(100, 50), { maxWidth: 50 });
    expect(tensor.dims).toEqual([1, 3, 48, 50]);
    expect(tensor.data[0]).toBeCloseTo(1);
    expect(tensor.data[24 * 50]).toBeCloseTo(1);
    expect(tensor.data[47 * 50]).toBeCloseTo(1);
  });

  it('rejects invalid RGBA input', () => {
    expect(() =>
      preprocessDetection({ data: new Uint8ClampedArray(3), width: 1, height: 1 }),
    ).toThrow(/RGBA/);
  });

  it('crops an axis-aligned quad without changing its pixels', () => {
    const colors = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 255, 255],
    ] as const;
    const source = coloredImage(colors, 2);
    const crop = cropRotatedQuad(source, quad(0, 0, 2, 2));
    expect(crop).toEqual(source);
  });

  it('perspectively samples a rotated quad', () => {
    const source = rgba(4, 4, [10, 20, 30, 255]);
    const crop = cropRotatedQuad(source, [
      { x: 1, y: 0 },
      { x: 1, y: 3 },
      { x: 4, y: 3 },
      { x: 4, y: 0 },
    ]);
    expect(crop.width).toBe(3);
    expect(crop.height).toBe(3);
    expect(Array.from(crop.data.slice(0, 4))).toEqual([10, 20, 30, 255]);
  });

  it('rotates tall boxes counter-clockwise so top-to-bottom reads left-to-right', () => {
    const red = [255, 0, 0, 255] as const;
    const green = [0, 255, 0, 255] as const;
    const blue = [0, 0, 255, 255] as const;
    const source = coloredImage([red, green, blue], 1);
    const horizontal = cropForRecognition(source, quad(0, 0, 1, 3));
    expect(horizontal.vertical).toBe(true);
    expect(horizontal.image.width).toBe(3);
    expect(horizontal.image.height).toBe(1);
    expect(Array.from(horizontal.image.data)).toEqual([...red, ...green, ...blue]);
  });
});

describe('reading order', () => {
  function region(id: string, x: number, y: number, width: number, height: number) {
    return { id, quad: quad(x, y, width, height), vertical: height >= width * 1.5 };
  }

  it('groups horizontal rows and sorts left-to-right, then top-to-bottom', () => {
    const bottom = region('bottom', 0, 40, 12, 10);
    const right = region('right', 30, 1, 12, 10);
    const left = region('left', 0, 0, 12, 10);
    const lines = groupReadingLines([bottom, right, left]);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.items.map((item) => item.id))).toEqual([
      ['left', 'right'],
      ['bottom'],
    ]);
    expect(lines[0]?.indices).toEqual([2, 1]);
    expect(orderTextRegions([bottom, right, left]).map((item) => item.id)).toEqual([
      'left',
      'right',
      'bottom',
    ]);
  });

  it('does not merge vertically separated horizontal lines', () => {
    const lines = groupReadingLines([
      region('a', 0, 0, 20, 10),
      region('b', 0, 25, 20, 10),
      region('c', 0, 50, 20, 10),
    ]);
    expect(lines).toHaveLength(3);
  });

  it('reads clear horizontal columns left-to-right before moving to the next row', () => {
    const regions = [
      region('left-1', 20, 10, 100, 10),
      region('right-1', 300, 10, 100, 10),
      region('left-2', 20, 40, 100, 10),
      region('right-2', 300, 40, 100, 10),
      region('left-3', 20, 70, 100, 10),
      region('right-3', 300, 70, 100, 10),
      region('left-4', 20, 100, 100, 10),
      region('right-4', 300, 100, 100, 10),
    ];
    expect(orderTextRegions(regions).map((item) => item.id)).toEqual([
      'left-1',
      'left-2',
      'left-3',
      'left-4',
      'right-1',
      'right-2',
      'right-3',
      'right-4',
    ]);
  });

  it('groups vertical Japanese columns right-to-left and top-to-bottom', () => {
    const left = region('left', 0, 0, 8, 30);
    const rightBottom = region('right-bottom', 30, 35, 8, 30);
    const rightTop = region('right-top', 30, 0, 8, 30);
    const lines = groupReadingLines([left, rightBottom, rightTop]);
    expect(lines.every((line) => line.orientation === 'vertical')).toBe(true);
    expect(lines.map((line) => line.items.map((item) => item.id))).toEqual([
      ['right-top', 'right-bottom'],
      ['left'],
    ]);
  });

  it('reads a horizontal heading and footer around mixed vertical columns', () => {
    const title = { id: 'title', quad: quad(180, 20, 140, 30), vertical: false };
    const right = { id: 'right', quad: quad(400, 90, 20, 300), vertical: true };
    const left = { id: 'left', quad: quad(80, 90, 20, 300), vertical: true };
    const footer = { id: 'footer', quad: quad(80, 400, 340, 20), vertical: false };
    const lines = groupReadingLines([left, footer, right, title]);
    expect(lines.map((line) => line.items.map((item) => item.id))).toEqual([
      ['title'],
      ['right'],
      ['left'],
      ['footer'],
    ]);
    expect(lines[0]?.orientation).toBe('horizontal');
    expect(lines[1]?.orientation).toBe('vertical');
  });

  it('allows an explicit orientation override', () => {
    const regions = [region('a', 0, 0, 8, 30), region('b', 30, 0, 8, 30)];
    expect(groupReadingLines(regions, { orientation: 'horizontal' })[0]?.orientation).toBe(
      'horizontal',
    );
    expect(groupReadingLines(regions, { orientation: 'vertical' })).toHaveLength(2);
  });
});

describe('OCR pipeline', () => {
  const detectionOptions = { unclipRatio: 0, minSize: 0, boxThreshold: 0.6 } as const;

  it('runs injected det/rec sessions and assembles ordered text', async () => {
    const probabilityMap = mapWithRectangles(32, 32, [
      { x: 2, y: 2, width: 9, height: 5, score: 0.95 },
      { x: 15, y: 2, width: 9, height: 5, score: 0.9 },
      { x: 2, y: 15, width: 9, height: 5, score: 0.85 },
    ]);
    const outputs = [ctc([1]), ctc([2]), ctc([3])];
    let detectionDims: OcrTensor['dims'] | undefined;
    let recognitionHeight: number | undefined;
    const detect = vi.fn((input: OcrTensor) => {
      detectionDims = input.dims;
      return probabilityMap;
    });
    const recognize = vi.fn((input: OcrTensor) => {
      recognitionHeight = input.dims[2];
      return outputs.shift() ?? ctc([0]);
    });
    const result = await runOcrPipeline(rgba(32, 32), {
      runner: { detect, recognize },
      dictionary: ['A', 'B', 'C'],
      detection: detectionOptions,
    });

    expect(detect).toHaveBeenCalledOnce();
    expect(detectionDims).toEqual([1, 3, 32, 32]);
    expect(recognize).toHaveBeenCalledTimes(3);
    expect(recognitionHeight).toBe(48);
    expect(result.text).toBe('A B\nC');
    expect(result.regions.map((region) => region.text)).toEqual(['A', 'B', 'C']);
    expect(result.lines).toHaveLength(2);
    expect(result.regions[0]?.recognitionConfidence).toBeCloseTo(0.9, 5);
  });

  it('rotates tall recognition crops and orders vertical columns right-to-left', async () => {
    const probabilityMap = mapWithRectangles(32, 32, [
      { x: 2, y: 2, width: 5, height: 14, score: 0.95 },
      { x: 20, y: 2, width: 5, height: 14, score: 0.9 },
    ]);
    const recognize = vi
      .fn()
      .mockReturnValueOnce(ctc([1], 3))
      .mockReturnValueOnce(ctc([2], 3));
    const pipeline = new OcrPipeline({
      runner: { detect: () => probabilityMap, recognize },
      dictionary: ['左', '右'],
      detection: detectionOptions,
    });
    const result = await pipeline.run(rgba(32, 32));

    expect(result.text).toBe('右\n左');
    expect(result.regions.every((region) => region.vertical)).toBe(true);
    for (const call of recognize.mock.calls) {
      const tensor = call[0] as { dims: readonly number[] };
      expect(tensor.dims[3]).toBeGreaterThan(48);
    }
  });

  it('returns an empty result without invoking recognition for an empty map', async () => {
    const recognize = vi.fn();
    const result = await runOcrPipeline(rgba(8, 8), {
      runner: { detect: () => ({ data: new Float32Array(64), width: 8, height: 8 }), recognize },
      dictionary: ['A'],
    });
    expect(result).toEqual({ regions: [], lines: [], text: '' });
    expect(recognize).not.toHaveBeenCalled();
  });

  it('honors cancellation before inference', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before detection');
    controller.abort(reason);
    const detect = vi.fn();
    await expect(
      runOcrPipeline(
        rgba(8, 8),
        { runner: { detect, recognize: vi.fn() }, dictionary: ['A'] },
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(detect).not.toHaveBeenCalled();
  });

  it('checks cancellation between recognition items and forwards the signal', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled after first item');
    const probabilityMap = mapWithRectangles(32, 16, [
      { x: 2, y: 2, width: 8, height: 5, score: 0.95 },
      { x: 15, y: 2, width: 8, height: 5, score: 0.9 },
    ]);
    const recognize = vi.fn((_input: unknown, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(reason);
      return ctc([1], 2);
    });
    await expect(
      runOcrPipeline(
        rgba(32, 16),
        {
          runner: { detect: () => probabilityMap, recognize },
          dictionary: ['A'],
          detection: detectionOptions,
        },
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(recognize).toHaveBeenCalledOnce();
  });

  it('yields a macrotask before every text-box recognition', async () => {
    const probabilityMap = mapWithRectangles(32, 16, [
      { x: 2, y: 2, width: 8, height: 5, score: 0.95 },
      { x: 15, y: 2, width: 8, height: 5, score: 0.9 },
      { x: 2, y: 10, width: 8, height: 5, score: 0.85 },
    ]);
    const order: string[] = [];
    const yieldBetweenRuns = vi.fn(async () => {
      order.push('yield');
    });
    const detect = vi.fn(() => {
      order.push('detect');
      return probabilityMap;
    });
    const recognize = vi.fn(() => {
      order.push('recognize');
      return ctc([1], 2);
    });
    await runOcrPipeline(rgba(32, 16), {
      runner: { detect, recognize },
      dictionary: ['A'],
      detection: detectionOptions,
      yieldBetweenRuns,
    });

    expect(order).toEqual([
      'detect',
      'yield',
      'recognize',
      'yield',
      'recognize',
      'yield',
      'recognize',
    ]);
    expect(yieldBetweenRuns).toHaveBeenCalledTimes(3);
  });

  it('lets queued host tasks run before the next recognition with the default yield', async () => {
    const probabilityMap = mapWithRectangles(32, 16, [
      { x: 2, y: 2, width: 8, height: 5, score: 0.95 },
      { x: 15, y: 2, width: 8, height: 5, score: 0.9 },
    ]);
    let served = false;
    setTimeout(() => {
      served = true;
    }, 0);
    let firstRecognition = true;
    const servedBeforeLaterRecognition: boolean[] = [];
    const recognize = vi.fn(() => {
      if (firstRecognition) firstRecognition = false;
      else servedBeforeLaterRecognition.push(served);
      return ctc([1], 2);
    });
    await runOcrPipeline(rgba(32, 16), {
      runner: { detect: () => probabilityMap, recognize },
      dictionary: ['A'],
      detection: detectionOptions,
    });
    expect(servedBeforeLaterRecognition).toEqual([true]);
  });
});
