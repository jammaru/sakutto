// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ImageTranslationController,
  imageTranslationSegments,
  visibleImageRect,
} from '@/dom/image-translation';
import type { OcrResult } from '@/engine/ocr/types';
import { createDefaultSettings } from '@/shared/settings';

const region = {
  text: 'Hello',
  confidence: 0.9,
  recognitionConfidence: 0.95,
  vertical: false,
  quad: [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 50, y: 12 },
    { x: 0, y: 12 },
  ],
  symbolScores: [0.95],
} as const;

const ocr: OcrResult = {
  text: 'Hello',
  regions: [region],
  lines: [{ orientation: 'horizontal', items: [region], indices: [0] }],
};

const labels = {
  heading: 'Image translation',
  pending: 'Working',
  failed: 'Failed',
  empty: 'Empty',
  close: 'Close',
  original: 'Source',
  permission: 'Permission',
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body?.replaceChildren();
});

describe('image translation helpers', () => {
  it('preserves OCR reading lines and drops empty segments', () => {
    expect(imageTranslationSegments(ocr)).toEqual([{ id: 'line-0', text: 'Hello' }]);
    expect(imageTranslationSegments({ ...ocr, text: '', regions: [], lines: [] })).toEqual([]);
  });

  it('clips capture rectangles to the visible viewport', () => {
    expect(visibleImageRect({ x: -10, y: 20, width: 100, height: 80 }, 800, 600)).toEqual({
      x: 0,
      y: 20,
      width: 90,
      height: 80,
    });
    expect(visibleImageRect({ x: -100, y: 0, width: 20, height: 20 }, 800, 600)).toBeNull();
  });
});

describe('ImageTranslationController', () => {
  it('reads image pixels, translates OCR lines, and closes the shadow panel', async () => {
    const image = document.createElement('img');
    image.src = 'https://example.test/scan.png';
    Object.defineProperties(image, {
      complete: { value: true },
      naturalWidth: { value: 100 },
      naturalHeight: { value: 60 },
    });
    document.body.append(image);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          drawImage: vi.fn(),
          getImageData: () => ({
            width: 100,
            height: 60,
            data: new Uint8ClampedArray(100 * 60 * 4).fill(255),
          }),
        }) as unknown as CanvasRenderingContext2D,
    );
    const recognize = vi.fn(async () => ocr);
    const translate = vi.fn(async function* () {
      yield { id: 'line-0', textDelta: 'こんにちは', engine: 'plamo' } as const;
    });
    const controller = new ImageTranslationController({
      labels,
      recognize,
      translate,
      loadSettings: async () => createDefaultSettings('en'),
    });

    await controller.start(image.src);

    const host = document.querySelector('[data-sakutto-image-translation]');
    expect(recognize).toHaveBeenCalledOnce();
    expect(translate).toHaveBeenCalledOnce();
    expect(host?.shadowRoot?.textContent).toContain('こんにちは');
    expect(host?.shadowRoot?.textContent).toContain('Hello');
    controller.close();
    expect(document.querySelector('[data-sakutto-image-translation]')).toBeNull();
  });
});
