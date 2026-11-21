import { browser } from 'wxt/browser';
import { encodeOcrImage } from '@/engine/ocr/codec';
import type { OcrResult, ImageDataLike } from '@/engine/ocr/types';
import { abortError } from '@/engine/errors';
import type { TranslationChunk, TranslateOptions, TranslateSegment } from '@/engine/types';
import type { OcrImagePayload } from '@/engine/offscreen/protocol';
import type { OcrTier } from '@/engine/ocr/catalog';
import { requestOcrCancel, requestOcrRecognize } from '@/shared/messages';
import { loadSettings } from '@/shared/storage';
import type { Settings } from '@/shared/settings';
import { translateViaBackground } from '@/shared/translation-client';
import type { ImageCaptureRect, ImageCaptureRequest } from '@/shared/image';

const MAX_IMAGE_SIDE = 2048;

export interface ImageTranslationLabels {
  heading: string;
  pending: string;
  failed: string;
  empty: string;
  close: string;
  original: string;
  permission: string;
}

interface ImageTranslationOptions {
  labels: ImageTranslationLabels;
  loadSettings?: () => Promise<Settings>;
  recognize?: (payload: OcrImagePayload) => Promise<OcrResult | null>;
  translate?: (
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ) => AsyncIterable<TranslationChunk>;
}

export function imageTranslationSegments(result: OcrResult): TranslateSegment[] {
  const segments =
    result.lines.length > 0
      ? result.lines.map((line, index) => ({
          id: 'line-' + String(index),
          text: line.items
            .map((region) => region.text)
            .filter((text) => text.length > 0)
            .join(line.orientation === 'vertical' ? '' : ' '),
        }))
      : result.text.split('\n').map((text, index) => ({ id: 'line-' + String(index), text }));
  return segments.filter((segment) => segment.text.trim().length > 0);
}

export function visibleImageRect(
  rect: Pick<ImageCaptureRect, 'x' | 'y' | 'width' | 'height'>,
  viewportWidth: number,
  viewportHeight: number,
): ImageCaptureRect | null {
  const left = Math.max(0, Math.min(viewportWidth, rect.x));
  const top = Math.max(0, Math.min(viewportHeight, rect.y));
  const right = Math.max(0, Math.min(viewportWidth, rect.x + rect.width));
  const bottom = Math.max(0, Math.min(viewportHeight, rect.y + rect.height));
  return right - left >= 2 && bottom - top >= 2
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

function imageElement(sourceUrl: string): HTMLImageElement | null {
  for (const image of document.querySelectorAll('img')) {
    if (image.currentSrc === sourceUrl || image.src === sourceUrl) return image;
  }
  return null;
}

async function waitForImage(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0) return;
  await image.decode();
}

function canvasPixels(
  source: CanvasImageSource,
  width: number,
  height: number,
  destination?: HTMLCanvasElement,
): ImageDataLike {
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height, 1));
  const canvas = destination ?? document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas is unavailable');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

async function corsPixels(sourceUrl: string): Promise<ImageDataLike> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = sourceUrl;
  await waitForImage(image);
  return canvasPixels(image, image.naturalWidth, image.naturalHeight);
}

async function capturedPixels(
  dataUrl: string,
  rect: ImageCaptureRect | null,
): Promise<ImageDataLike> {
  const screenshot = new Image();
  screenshot.src = dataUrl;
  await waitForImage(screenshot);
  if (!rect) return canvasPixels(screenshot, screenshot.naturalWidth, screenshot.naturalHeight);
  const scaleX = screenshot.naturalWidth / Math.max(1, window.innerWidth);
  const scaleY = screenshot.naturalHeight / Math.max(1, window.innerHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width * scaleX));
  canvas.height = Math.max(1, Math.round(rect.height * scaleY));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas is unavailable');
  context.drawImage(
    screenshot,
    Math.round(rect.x * scaleX),
    Math.round(rect.y * scaleY),
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function panelHost(): { host: HTMLElement; shadow: ShadowRoot } {
  const host = document.createElement('div');
  host.dataset.sakuttoImageTranslation = '';
  host.style.cssText =
    'position:fixed;z-index:2147483647;right:16px;bottom:16px;width:min(420px,calc(100vw - 32px));';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = [
    ':host { all: initial; }',
    '.card { box-sizing:border-box; max-height:70vh; overflow:auto; padding:16px; border:1px solid #d8dee7;',
    'border-radius:12px; background:#fff; color:#182230; box-shadow:0 12px 36px rgb(15 23 32 / 24%);',
    'font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }',
    'header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; }',
    'strong { font-size:15px; }',
    'button { border:0; border-radius:6px; background:#eef1f5; color:#182230; padding:5px 10px; cursor:pointer; }',
    'button:focus-visible { outline:2px solid #3157c8; outline-offset:2px; }',
    '.translation { white-space:pre-wrap; overflow-wrap:anywhere; }',
    '.error { color:#a12828; }',
    'details { margin-top:12px; color:#536173; }',
    'summary { cursor:pointer; }',
    '.source { margin-top:6px; white-space:pre-wrap; overflow-wrap:anywhere; }',
  ].join('\n');
  const card = document.createElement('section');
  card.className = 'card';
  card.setAttribute('aria-live', 'polite');
  shadow.append(style, card);
  return { host, shadow };
}

/** One image at a time: direct/CORS pixels, activeTab capture fallback, OCR, then translation. */
export class ImageTranslationController {
  private host: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private controller: AbortController | null = null;
  private tier: OcrTier | null = null;
  private generation = 0;

  constructor(private readonly options: ImageTranslationOptions) {}

  close(): void {
    this.generation += 1;
    this.controller?.abort();
    if (this.tier) void requestOcrCancel(this.tier);
    this.tier = null;
    this.controller = null;
    this.host?.remove();
    this.host = null;
    this.card = null;
  }

  async start(sourceUrl: string): Promise<void> {
    this.close();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const { host, shadow } = panelHost();
    this.host = host;
    const card = shadow.querySelector<HTMLElement>('.card');
    if (!card) return;
    this.card = card;
    document.documentElement.append(host);
    this.paintPending();

    try {
      const settings = await (this.options.loadSettings ?? loadSettings)();
      this.tier = settings.selectedOcrTier;
      const pixels = await this.readPixels(sourceUrl);
      this.throwIfStale(generation, controller.signal);
      const recognize =
        this.options.recognize ??
        ((payload: OcrImagePayload) => requestOcrRecognize(settings.selectedOcrTier, payload));
      const payload = encodeOcrImage(pixels);
      const result = await recognize(payload);
      this.throwIfStale(generation, controller.signal);
      if (!result) throw new Error('OCR failed');
      const segments = imageTranslationSegments(result);
      if (segments.length === 0) {
        this.paintText(this.options.labels.empty, false, result.text);
        return;
      }

      const translations = new Map<string, string>();
      const translate = this.options.translate ?? translateViaBackground;
      for await (const chunk of translate(segments, {
        tgt: settings.targetLanguage,
        form: settings.form,
        glossary: settings.glossary,
        priority: 0,
        signal: controller.signal,
      })) {
        this.throwIfStale(generation, controller.signal);
        const previous = translations.get(chunk.id) ?? '';
        if (chunk.textDelta !== undefined) {
          translations.set(
            chunk.id,
            chunk.restart === true ? chunk.textDelta : previous + chunk.textDelta,
          );
        }
        if (chunk.final !== undefined) translations.set(chunk.id, chunk.final);
      }
      const text = segments
        .map((segment) => translations.get(segment.id) ?? '')
        .join('\n')
        .trim();
      if (!text) throw new Error('Translation failed');
      this.paintText(text, false, result.text);
    } catch {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.paintText(this.options.labels.failed, true);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private throwIfStale(generation: number, signal: AbortSignal): void {
    if (generation !== this.generation || signal.aborted) throw abortError();
  }

  private async readPixels(sourceUrl: string): Promise<ImageDataLike> {
    const image = imageElement(sourceUrl);
    if (image) {
      try {
        await waitForImage(image);
        return canvasPixels(image, image.naturalWidth, image.naturalHeight);
      } catch {
        // A cross-origin image without CORS taints the canvas; try an anonymous CORS read next.
      }
    }
    try {
      return await corsPixels(sourceUrl);
    } catch {
      // Fall through to the visible-tab bitmap granted by the image context-menu click.
    }

    const bounds = image?.getBoundingClientRect();
    const rect = bounds ? visibleImageRect(bounds, window.innerWidth, window.innerHeight) : null;
    const response: unknown = await browser.runtime.sendMessage({
      type: 'image:capture',
      rect,
    } satisfies ImageCaptureRequest);
    if (typeof response !== 'string' || !response.startsWith('data:image/')) {
      throw new Error(this.options.labels.permission);
    }
    return capturedPixels(response, rect);
  }

  private paintPending(): void {
    if (!this.card) return;
    this.card.replaceChildren();
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = this.options.labels.heading;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', this.options.labels.close);
    close.addEventListener('click', () => this.close());
    header.append(title, close);
    const pending = document.createElement('div');
    pending.textContent = this.options.labels.pending;
    this.card.append(header, pending);
  }

  private paintText(text: string, error: boolean, source?: string): void {
    if (!this.card) return;
    const header = this.card.querySelector('header');
    this.card.replaceChildren();
    if (header) this.card.append(header);
    else this.paintPending();
    const output = document.createElement('div');
    output.className = error ? 'translation error' : 'translation';
    output.textContent = text;
    this.card?.append(output);
    if (!source) return;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = this.options.labels.original;
    const original = document.createElement('div');
    original.className = 'source';
    original.textContent = source;
    details.append(summary, original);
    this.card?.append(details);
  }
}
