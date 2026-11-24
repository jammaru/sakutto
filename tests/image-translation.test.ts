// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ImageTranslationController,
  anchoredPopupBox,
  capturedPixels,
  findTargetImage,
  imageTranslationSegments,
  topLevelImageCaptureGeometry,
  visibleImageRect,
} from '@/dom/image-translation';
import { uiShadow } from '@/dom/overlay';
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
  close: 'Close image translation',
  original: 'Recognized text',
  permission: 'Permission',
  copy: 'Copy the translation',
  copied: 'Copied',
  copyFailed: 'Could not copy',
  resize: 'Resize',
};

function settings(overrides: Record<string, unknown> = {}) {
  return { ...createDefaultSettings('en'), ...overrides };
}

function image() {
  const element = document.createElement('img');
  element.src = 'https://example.test/scan.png';
  Object.defineProperties(element, {
    complete: { value: true },
    naturalWidth: { value: 100 },
    naturalHeight: { value: 60 },
  });
  document.body.append(element);
  return element;
}

function stubCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return {
      drawImage: vi.fn(),
      getImageData: () => ({
        width: this.width,
        height: this.height,
        data: new Uint8ClampedArray(this.width * this.height * 4).fill(255),
      }),
    } as unknown as CanvasRenderingContext2D;
  });
}

async function translatedController(options: { onWidthChange?: (width: number) => void } = {}) {
  const recognize = vi.fn(async () => ocr);
  const translate = vi.fn(async function* () {
    yield { id: 'line-0', textDelta: 'こんにちは', engine: 'plamo' } as const;
  });
  const controller = new ImageTranslationController({
    labels,
    recognize,
    translate,
    loadSettings: async () => settings(),
    ...options,
  });
  await controller.start('https://example.test/scan.png');
  const host = document.querySelector<HTMLElement>('[data-sakutto-image-translation]');
  // Closed like the selection bubble: the page's own shadowRoot is null and only the
  // content script can reach the panel through uiShadow().
  expect(host?.shadowRoot).toBeNull();
  const shadow = uiShadow(host);
  return { controller, host, shadow, recognize, translate };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body?.replaceChildren();
  document.documentElement
    .querySelectorAll('[data-sakutto-image-translation]')
    .forEach((node) => node.remove());
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

  it('offsets a subframe crop into top-level screenshot coordinates', () => {
    const top = { innerWidth: 1000, innerHeight: 800 } as unknown as Window;
    Object.defineProperty(top, 'top', { value: top });
    const child = {
      top,
      parent: top,
      frameElement: { getBoundingClientRect: () => ({ x: 120, y: 80 }) },
    } as unknown as Window;

    expect(topLevelImageCaptureGeometry({ x: 10, y: 20, width: 100, height: 50 }, child)).toEqual({
      rect: { x: 130, y: 100, width: 100, height: 50 },
      viewportWidth: 1000,
      viewportHeight: 800,
    });
  });

  it('downscales a DPR-3 screenshot crop before producing OCR pixels', async () => {
    class FakeScreenshot {
      complete = true;
      naturalWidth = 5760;
      naturalHeight = 3240;
      src = '';
      async decode(): Promise<void> {}
    }
    vi.stubGlobal('Image', FakeScreenshot);
    stubCanvas();
    const pixels = await capturedPixels('data:image/png;base64,cG5n', {
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });
    expect(pixels.width).toBe(2048);
    expect(pixels.height).toBe(1152);
    expect(pixels.width * pixels.height).toBeLessThanOrEqual(16_777_216);
    await expect(
      capturedPixels('data:image/png;base64,cG5n', {
        rect: null,
        viewportWidth: 1920,
        viewportHeight: 1080,
      }),
    ).rejects.toThrow('no visible capture rectangle');
  });
});

describe('image popup placement', () => {
  it('sits just below its anchor and clamps to the viewport edges', () => {
    expect(
      anchoredPopupBox(
        { left: 120, right: 220, top: 100, bottom: 180 },
        { width: 300, height: 150 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ left: 120, top: 188 });
    expect(
      anchoredPopupBox(
        { left: 700, right: 790, top: 100, bottom: 150 },
        { width: 300, height: 100 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ left: 492, top: 158 });
  });

  it('flips above an anchor near the bottom and stays inside a short viewport', () => {
    expect(
      anchoredPopupBox(
        { left: 40, right: 140, top: 500, bottom: 560 },
        { width: 200, height: 120 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ left: 40, top: 372 });
    expect(
      anchoredPopupBox(
        { left: 40, right: 140, top: 10, bottom: 80 },
        { width: 400, height: 700 },
        { width: 800, height: 400 },
      ),
    ).toEqual({ left: 40, top: 8 });
  });

  it('anchors below the chosen image at start and repositions on scroll', async () => {
    const target = image();
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 120,
      left: 100,
      right: 240,
      top: 120,
      bottom: 180,
      width: 140,
      height: 60,
      toJSON: () => ({}),
    } as DOMRect);
    expect(findTargetImage(target.src)).toBe(target);
    stubCanvas();
    const recognize = vi.fn(async () => ocr);
    const translate = vi.fn(async function* () {
      yield { id: 'line-0', final: 'translated', engine: 'plamo' } as const;
    });
    const controller = new ImageTranslationController({
      labels,
      recognize,
      translate,
      loadSettings: async () => settings(),
    });
    await controller.start(target.src, { left: 100, right: 240, top: 120, bottom: 180 });
    const host = document.querySelector<HTMLElement>('[data-sakutto-image-translation]');
    expect(host?.style.top).toBe('188px');
    expect(host?.style.left).toBe('100px');
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 400,
      left: 100,
      right: 240,
      top: 400,
      bottom: 460,
      width: 140,
      height: 60,
      toJSON: () => ({}),
    } as DOMRect);
    window.dispatchEvent(new Event('scroll'));
    // With an explicit anchor the popup follows the original rect; page-side callers
    // pass the live rect for the in-page flow, which is exercised by the e2e test.
    expect(host?.style.top).toBe('188px');
    controller.close();
  });

  it('hides with display:none when the image scrolls away and re-anchors when it returns', async () => {
    const target = image();
    stubCanvas();
    const rectAt = (top: number): DOMRect =>
      ({
        x: 100,
        y: top,
        left: 100,
        right: 240,
        top,
        bottom: top + 60,
        width: 140,
        height: 60,
        toJSON: () => ({}),
      }) as DOMRect;
    const bounds = vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rectAt(120));
    const controller = new ImageTranslationController({
      labels,
      recognize: vi.fn(async () => ocr),
      translate: vi.fn(async function* () {
        yield { id: 'line-0', final: 'translated', engine: 'plamo' } as const;
      }),
      loadSettings: async () => settings(),
    });
    await controller.start(target.src);
    const host = document.querySelector<HTMLElement>('[data-sakutto-image-translation]');
    const currentAnchor = () =>
      (controller as unknown as { currentAnchor(): { top: number } | null }).currentAnchor();

    expect(host?.hidden).toBe(false);
    expect(host?.style.display).toBe('block');
    expect(host?.style.top).toBe('188px');
    expect(currentAnchor()).toMatchObject({ top: 120 });

    bounds.mockReturnValue(rectAt(window.innerHeight + 500));
    window.dispatchEvent(new Event('scroll'));
    expect(currentAnchor()).toBeNull();
    expect(host?.hidden).toBe(true);
    expect(host?.style.display).toBe('none');

    bounds.mockReturnValue(rectAt(300));
    window.dispatchEvent(new Event('scroll'));
    expect(host?.hidden).toBe(false);
    expect(host?.style.display).toBe('block');
    expect(currentAnchor()).toMatchObject({ top: 300 });
    expect(host?.style.top).toBe('368px');
    controller.close();
  });
});

describe('ImageTranslationController bubble', () => {
  it('reads image pixels, translates OCR lines, and exposes copy/close/original', async () => {
    image();
    stubCanvas();
    const { controller, host, shadow, recognize, translate } = await translatedController();
    expect(recognize).toHaveBeenCalledOnce();
    expect(translate).toHaveBeenCalledOnce();
    expect(shadow?.querySelector('.body')?.textContent).toContain('こんにちは');
    const details = shadow?.querySelector('details');
    expect(details?.hidden).toBe(false);
    expect(details?.querySelector('.source')?.textContent).toBe('Hello');
    expect(details?.querySelector('summary')?.textContent).toBe(labels.original);
    const copy = shadow?.querySelector<HTMLButtonElement>('button.copy');
    expect(copy?.getAttribute('aria-label')).toBe(labels.copy);
    expect(copy?.disabled).toBe(false);
    expect(shadow?.querySelectorAll('.resize-handle').length).toBe(2);
    controller.close();
    expect(document.querySelector('[data-sakutto-image-translation]')).toBeNull();
    expect(host?.isConnected).toBe(false);
  });

  it('copies the translated text and shows brief feedback', async () => {
    image();
    stubCanvas();
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
    });
    const { controller, shadow } = await translatedController();
    const copy = shadow?.querySelector<HTMLButtonElement>('button.copy');
    copy?.click();
    await new Promise((done) => setTimeout(done, 0));
    expect(copied).toBe('こんにちは');
    expect(shadow?.querySelector('.copy-note')?.textContent).toBe(labels.copied);
    expect(copy?.dataset.state).toBe('copied');
    controller.close();
  });

  it('does not paint copy feedback after the panel closes mid-copy', async () => {
    image();
    stubCanvas();
    let releaseCopy!: () => void;
    const clipboardGate = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text;
          await clipboardGate;
        },
      },
    });
    const { controller, shadow } = await translatedController();
    const copy = shadow?.querySelector<HTMLButtonElement>('button.copy');
    copy?.click();
    await new Promise((done) => setTimeout(done, 0));
    expect(copied).toBe('こんにちは');

    controller.close();
    releaseCopy();
    await new Promise((done) => setTimeout(done, 0));
    expect(shadow?.querySelector('.copy-note')?.textContent).toBe('');
    expect(copy?.dataset.state).toBeUndefined();
  });

  it('reports an error final as failed instead of painting the OCR source', async () => {
    image();
    stubCanvas();
    const translate = vi.fn(async function* () {
      // Engines send the source text as the final of a failed line. It must never be
      // presented as if the image had been translated.
      yield { id: 'line-0', final: 'Hello', error: true, engine: 'plamo' } as const;
    });
    const controller = new ImageTranslationController({
      labels,
      recognize: vi.fn(async () => ocr),
      translate,
      loadSettings: async () => settings(),
    });
    await controller.start('https://example.test/scan.png');

    const host = document.querySelector<HTMLElement>('[data-sakutto-image-translation]');
    const shadow = uiShadow(host);
    const body = shadow?.querySelector<HTMLElement>('.body');
    expect(body?.textContent).toBe(labels.failed);
    expect(body?.classList.contains('error')).toBe(true);
    expect(shadow?.querySelector<HTMLButtonElement>('button.copy')?.disabled).toBe(true);
    controller.close();
  });

  it('applies a saved width, persists a drag, and resets on double-click', async () => {
    image();
    stubCanvas();
    const onWidthChange = vi.fn();
    const recognize = vi.fn(async () => ocr);
    const translate = vi.fn(async function* () {
      yield { id: 'line-0', final: 'translated', engine: 'plamo' } as const;
    });
    const controller = new ImageTranslationController({
      labels,
      recognize,
      translate,
      onWidthChange,
      loadSettings: async () => settings({ imagePopupWidth: 20 }),
    });
    await controller.start('https://example.test/scan.png');
    const host = document.querySelector<HTMLElement>('[data-sakutto-image-translation]');
    expect(host?.shadowRoot).toBeNull();
    const shadow = uiShadow(host);
    const card = shadow?.querySelector<HTMLElement>('.card');
    expect(card?.style.width).toBe('20em');
    const handle = shadow?.querySelector<HTMLElement>('.resize-handle.right');
    const pointer = (type: string, x: number) =>
      new MouseEvent(type, { bubbles: true, clientX: x }) as unknown as PointerEvent;
    handle?.dispatchEvent(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointermove', 160));
    document.dispatchEvent(pointer('pointerup', 160));
    expect(onWidthChange).toHaveBeenCalledOnce();
    expect(onWidthChange.mock.calls[0]?.[0]).toBeGreaterThan(20);
    expect(card?.style.width).toMatch(/em$/u);
    handle?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onWidthChange).toHaveBeenLastCalledWith(0);
    expect(card?.style.width).toBe('');
    controller.close();
  });
});
