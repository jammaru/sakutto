import { browser } from 'wxt/browser';
import { copyTextToClipboard } from '@/shared/clipboard-copy';
import { encodeOcrImage } from '@/engine/ocr/codec';
import type { OcrResult, ImageDataLike } from '@/engine/ocr/types';
import { abortError } from '@/engine/errors';
import type { TranslationChunk, TranslateOptions, TranslateSegment } from '@/engine/types';
import {
  MAX_OCR_PIXELS,
  ocrRecognitionTimeoutMs,
  type OcrImagePayload,
} from '@/engine/offscreen/protocol';
import { requestOcrRecognizeDetailed } from '@/shared/messages';
import { loadSettings, saveSettings } from '@/shared/storage';
import {
  normalizeTranslationPopupWidth,
  TRANSLATION_POPUP_WIDTH_AUTO,
  TRANSLATION_POPUP_WIDTH_MIN_EM,
  type Settings,
} from '@/shared/settings';
import { translateViaBackground } from '@/shared/translation-client';
import type { ImageCaptureRect, ImageCaptureRequest } from '@/shared/image';
import { BUBBLE_STYLE, appendCopyIcons } from './overlay';

const MAX_IMAGE_SIDE = 2048;
const POPUP_MARGIN_PX = 8;
const POPUP_GAP_PX = 8;
const FALLBACK_CARD_WIDTH_PX = 280;
const FALLBACK_CARD_HEIGHT_PX = 120;

class ImageCapturePermissionError extends Error {}
class OcrModelMissingError extends Error {}

interface ImageCaptureGeometry {
  rect: ImageCaptureRect | null;
  viewportWidth: number;
  viewportHeight: number;
}

export interface ImageTranslationLabels {
  heading: string;
  pending: string;
  failed: string;
  empty: string;
  close: string;
  original: string;
  permission: string;
  /** Copy control label, shared with the selection popup's wording. */
  copy: string;
  copied: string;
  copyFailed: string;
  resize: string;
  /** Optional actionable message when OCR models have not been downloaded. */
  ocrMissing?: string;
}

interface ImageTranslationOptions {
  labels: ImageTranslationLabels;
  loadSettings?: () => Promise<Settings>;
  recognize?: (payload: OcrImagePayload) => Promise<OcrResult | null>;
  translate?: (
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ) => AsyncIterable<TranslationChunk>;
  /** Persists a drag/keyboard width change; defaults to Settings storage. */
  onWidthChange?: (widthEm: number) => void;
}

type Box = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

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

/** Convert frame-local crop coordinates to the top-level visible-tab screenshot. */
export function topLevelImageCaptureGeometry(
  rect: ImageCaptureRect,
  sourceWindow: Window = window,
): ImageCaptureGeometry | null {
  let x = rect.x;
  let y = rect.y;
  let current = sourceWindow;
  const seen = new Set<Window>();

  while (current !== current.top) {
    if (seen.has(current)) return null;
    seen.add(current);
    const frame = current.frameElement;
    // Cross-origin frames cannot expose frameElement. Failing the fallback is safer than
    // cropping an unrelated part of the top-level tab with frame-local coordinates.
    if (!frame) return null;
    const bounds = frame.getBoundingClientRect();
    x += bounds.x;
    y += bounds.y;
    current = current.parent;
  }

  const viewportWidth = current.innerWidth;
  const viewportHeight = current.innerHeight;
  return {
    rect: visibleImageRect({ ...rect, x, y }, viewportWidth, viewportHeight),
    viewportWidth,
    viewportHeight,
  };
}

function normalizedUrl(value: string): string {
  try {
    return new URL(value, document.baseURI).href;
  } catch {
    return value;
  }
}

/** Locate the right-clicked image so the popup can sit directly under it. */
export function findTargetImage(sourceUrl: string): HTMLImageElement | null {
  const wanted = normalizedUrl(sourceUrl);
  let first: HTMLImageElement | null = null;
  for (const image of document.querySelectorAll('img')) {
    const matches = [image.currentSrc, image.src].some(
      (candidate) =>
        candidate.length > 0 && (candidate === sourceUrl || normalizedUrl(candidate) === wanted),
    );
    if (!matches) continue;
    first ??= image;
    const rect = image.getBoundingClientRect();
    const view = image.ownerDocument.defaultView;
    if (
      rect.width >= 2 &&
      rect.height >= 2 &&
      rect.bottom > 0 &&
      rect.top < (view?.innerHeight ?? 600) &&
      rect.right > 0 &&
      rect.left < (view?.innerWidth ?? 800)
    ) {
      return image;
    }
  }
  return first;
}

/** The anchor we can actually see; an image scrolled fully out of view is not a target. */
export function imageAnchorRect(image: HTMLImageElement | null): DOMRect | null {
  if (!image) return null;
  const rect = image.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  const view = image.ownerDocument.defaultView;
  if (rect.bottom <= 0 || rect.top >= (view?.innerHeight ?? 600)) return null;
  return rect;
}

/**
 * Position the popup just below its anchor, flipping above only when the lower edge
 * would leave the viewport. Both axes are clamped to the margin; a card taller than the
 * viewport stays at the top margin and scrolls inside its capped text area.
 */
export function anchoredPopupBox(
  anchor: Pick<Box, 'left' | 'top' | 'right' | 'bottom'>,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = POPUP_MARGIN_PX,
  gap = POPUP_GAP_PX,
): { left: number; top: number } {
  const width = Math.max(1, Math.min(card.width, viewport.width - margin * 2));
  const height = Math.max(1, Math.min(card.height, viewport.height - margin * 2));
  const maxLeft = Math.max(margin, viewport.width - width - margin);
  const left = Math.max(margin, Math.min(maxLeft, anchor.left));
  const below = anchor.bottom + gap;
  let top = below;
  if (top + height > viewport.height - margin) {
    const above = anchor.top - height - gap;
    top = above >= margin ? above : Math.max(margin, viewport.height - height - margin);
  }
  return { left, top };
}

async function waitForImage(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0) return;
  await image.decode();
}

function canvasPixels(
  source: CanvasImageSource,
  width: number,
  height: number,
  sourceRect?: ImageCaptureRect,
): ImageDataLike {
  const scale = Math.min(
    1,
    MAX_IMAGE_SIDE / Math.max(width, height, 1),
    Math.sqrt(MAX_OCR_PIXELS / Math.max(1, width * height)),
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas is unavailable');
  if (sourceRect) {
    context.drawImage(
      source,
      sourceRect.x,
      sourceRect.y,
      sourceRect.width,
      sourceRect.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  } else {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

async function corsPixels(sourceUrl: string): Promise<ImageDataLike> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = sourceUrl;
  await waitForImage(image);
  return canvasPixels(image, image.naturalWidth, image.naturalHeight);
}

export async function capturedPixels(
  dataUrl: string,
  geometry: ImageCaptureGeometry,
): Promise<ImageDataLike> {
  const screenshot = new Image();
  screenshot.src = dataUrl;
  await waitForImage(screenshot);
  const { rect } = geometry;
  if (!rect)
    throw new ImageCapturePermissionError('Selected image has no visible capture rectangle');
  const scaleX = screenshot.naturalWidth / Math.max(1, geometry.viewportWidth);
  const scaleY = screenshot.naturalHeight / Math.max(1, geometry.viewportHeight);
  const width = Math.max(1, Math.round(rect.width * scaleX));
  const height = Math.max(1, Math.round(rect.height * scaleY));
  return canvasPixels(screenshot, width, height, {
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width,
    height,
  });
}

const IMAGE_BUBBLE_STYLE =
  BUBBLE_STYLE +
  [
    '.card.image { overscroll-behavior: contain; }',
    '.card.image .body.error { color: #a12828; }',
    '.card.image details { margin-top: 0.5em; color: #5b6675; }',
    '.card.image summary { cursor: pointer; }',
    '.card.image .source { margin-top: 0.4em; white-space: pre-wrap; overflow-wrap: anywhere; }',
    '.card.image .copy-note[hidden] { display: none; }',
    '@media (prefers-color-scheme: dark) {',
    '  .card.image details { color: #b7c2cf; }',
    '  .card.image .body.error { color: #fca5a5; }',
    '}',
  ].join('\n');

interface PanelParts {
  host: HTMLElement;
  card: HTMLElement;
  body: HTMLElement;
  details: HTMLDetailsElement;
  source: HTMLElement;
  copy: HTMLButtonElement;
  copyNote: HTMLElement;
  resizeLeft: HTMLButtonElement;
  resizeRight: HTMLButtonElement;
}

interface ResizeState {
  edge: 'left' | 'right';
  pointerId: number;
  startX: number;
  startWidthEm: number;
  fontSize: number;
  changed: boolean;
}

/** One image at a time: direct/CORS pixels, activeTab capture fallback, OCR, then translation. */
export class ImageTranslationController {
  private host: HTMLElement | null = null;
  private parts: PanelParts | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private anchorElement: HTMLImageElement | null = null;
  private anchorRect: Pick<Box, 'left' | 'top' | 'right' | 'bottom'> | null = null;
  private width = TRANSLATION_POPUP_WIDTH_AUTO;
  private copyText = '';
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private resize: ResizeState | null = null;

  constructor(private readonly options: ImageTranslationOptions) {}

  close(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.stopViewportListening();
    this.endResize();
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.copyTimer = null;
    this.host?.remove();
    this.host = null;
    this.parts = null;
    this.anchorElement = null;
    this.anchorRect = null;
    this.copyText = '';
  }

  async start(
    sourceUrl: string,
    anchor?: Pick<Box, 'left' | 'top' | 'right' | 'bottom'> | null,
  ): Promise<void> {
    this.close();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.anchorElement = anchor ? null : findTargetImage(sourceUrl);
    this.anchorRect = anchor ?? imageAnchorRect(this.anchorElement) ?? this.fallbackAnchor();
    const { host, parts } = this.buildPanel();
    this.host = host;
    this.parts = parts;
    document.documentElement.append(host);
    this.paintPending();
    this.startViewportListening();
    this.reposition();

    try {
      const settings = await (this.options.loadSettings ?? loadSettings)();
      if (generation !== this.generation) return;
      this.applyWidth(settings.imagePopupWidth);
      const pixels = await this.readPixels(sourceUrl);
      this.throwIfStale(generation, controller.signal);
      const recognize =
        this.options.recognize ??
        (async (payload: OcrImagePayload) => {
          const outcome = await requestOcrRecognizeDetailed(
            settings.selectedOcrTier,
            payload,
            controller.signal,
          );
          if (outcome.error === 'model-missing') throw new OcrModelMissingError();
          return outcome.result;
        });
      const payload = encodeOcrImage(pixels);
      // A silent recognizer must never leave the panel at "translating" forever.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(new Error('OCR timed out'));
          },
          ocrRecognitionTimeoutMs(settings.selectedOcrTier) + 2_000,
        );
      });
      let result: OcrResult | null;
      try {
        result = await Promise.race([recognize(payload), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
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
    } catch (error) {
      if (generation !== this.generation) return;
      if (controller.signal.aborted) {
        this.paintText(this.options.labels.failed, true);
        return;
      }
      this.paintText(
        error instanceof ImageCapturePermissionError
          ? this.options.labels.permission
          : error instanceof OcrModelMissingError && this.options.labels.ocrMissing
            ? this.options.labels.ocrMissing
            : this.options.labels.failed,
        true,
      );
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private throwIfStale(generation: number, signal: AbortSignal): void {
    if (generation !== this.generation || signal.aborted) throw abortError();
  }

  private fallbackAnchor(): Pick<Box, 'left' | 'top' | 'right' | 'bottom'> {
    const view = document.defaultView;
    const width = Math.min(320, Math.max(64, (view?.innerWidth ?? 800) / 3));
    const left = Math.max(POPUP_MARGIN_PX, ((view?.innerWidth ?? 800) - width) / 2);
    return { left, right: left + width, top: 16, bottom: 16 };
  }

  private currentAnchor(): Pick<Box, 'left' | 'top' | 'right' | 'bottom'> | null {
    if (!this.anchorElement) return this.anchorRect;
    const rect = imageAnchorRect(this.anchorElement);
    if (rect) this.anchorRect = rect;
    return this.anchorRect;
  }

  private readonly onViewportChange = (): void => this.reposition();

  private startViewportListening(): void {
    window.addEventListener('scroll', this.onViewportChange, { passive: true, capture: true });
    window.addEventListener('resize', this.onViewportChange, { passive: true });
  }

  private stopViewportListening(): void {
    window.removeEventListener('scroll', this.onViewportChange, true);
    window.removeEventListener('resize', this.onViewportChange);
  }

  private reposition(): void {
    if (!this.host || !this.parts) return;
    const anchor = this.currentAnchor();
    const view = this.host.ownerDocument.defaultView;
    const viewport = { width: view?.innerWidth ?? 800, height: view?.innerHeight ?? 600 };
    if (!anchor) {
      this.host.hidden = true;
      return;
    }
    const offscreen =
      anchor.bottom <= 0 ||
      anchor.top >= viewport.height ||
      anchor.right <= 0 ||
      anchor.left >= viewport.width;
    this.host.hidden = offscreen;
    const box = anchoredPopupBox(
      anchor,
      {
        width: this.parts.card.offsetWidth || FALLBACK_CARD_WIDTH_PX,
        height: this.parts.card.offsetHeight || FALLBACK_CARD_HEIGHT_PX,
      },
      viewport,
    );
    this.host.style.left = String(Math.round(box.left)) + 'px';
    this.host.style.top = String(Math.round(box.top)) + 'px';
    if (this.width > 0) {
      const rightAnchored = anchor.right > viewport.width * 0.5 || box.left < anchor.left;
      this.parts.resizeLeft.hidden = !rightAnchored;
      this.parts.resizeLeft.tabIndex = rightAnchored ? 0 : -1;
    }
  }

  private applyWidth(widthEm: number): void {
    const next = normalizeTranslationPopupWidth(widthEm);
    this.width = next;
    if (!this.parts) return;
    if (next === TRANSLATION_POPUP_WIDTH_AUTO) {
      this.parts.card.style.removeProperty('width');
      this.parts.card.style.removeProperty('max-width');
      delete this.parts.card.dataset.resized;
      this.parts.resizeLeft.hidden = true;
    } else {
      this.parts.card.style.width = String(next) + 'em';
      this.parts.card.style.maxWidth = 'calc(100vw - 16px)';
      this.parts.card.dataset.resized = '1';
    }
    this.parts.resizeRight.hidden = false;
    this.reposition();
  }

  private commitWidth(): void {
    (this.options.onWidthChange ?? ((width) => void saveSettings({ imagePopupWidth: width })))(
      this.width,
    );
  }

  private readonly onResizeMove = (event: PointerEvent): void => {
    const state = this.resize;
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();
    const view = this.host?.ownerDocument.defaultView;
    const maximum = Math.max(
      TRANSLATION_POPUP_WIDTH_MIN_EM,
      ((view?.innerWidth ?? 800) - 16) / state.fontSize,
    );
    const deltaEm = (event.clientX - state.startX) / state.fontSize;
    const raw = state.startWidthEm + (state.edge === 'right' ? deltaEm : -deltaEm);
    this.applyWidth(Math.min(maximum, Math.max(TRANSLATION_POPUP_WIDTH_MIN_EM, raw)));
    state.changed = true;
  };

  private readonly onResizeEnd = (event: PointerEvent): void => {
    const state = this.resize;
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();
    this.endResize();
    if (state.changed) this.commitWidth();
  };

  private endResize(): void {
    const doc = this.host?.ownerDocument;
    this.resize = null;
    if (!doc) return;
    doc.removeEventListener('pointermove', this.onResizeMove, true);
    doc.removeEventListener('pointerup', this.onResizeEnd, true);
    doc.removeEventListener('pointercancel', this.onResizeEnd, true);
  }

  private startResize(event: PointerEvent, edge: 'left' | 'right'): void {
    if (event.button !== 0 || !this.parts || !this.host) return;
    event.preventDefault();
    event.stopPropagation();
    const view = this.host.ownerDocument.defaultView;
    const fontSize =
      Number.parseFloat(view?.getComputedStyle(this.parts.card).fontSize ?? '') ||
      Number.parseFloat(this.parts.card.style.fontSize) ||
      12;
    this.resize = {
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidthEm:
        this.width > 0
          ? this.width
          : Math.max(
              TRANSLATION_POPUP_WIDTH_MIN_EM,
              (this.parts.card.offsetWidth || FALLBACK_CARD_WIDTH_PX) / fontSize,
            ),
      fontSize,
      changed: false,
    };
    const capture = event.currentTarget;
    try {
      (capture as Element | null)?.setPointerCapture?.(event.pointerId);
    } catch {
      // happy-dom and some hosts have no capture; document listeners still resize.
    }
    const doc = this.host.ownerDocument;
    doc.addEventListener('pointermove', this.onResizeMove, true);
    doc.addEventListener('pointerup', this.onResizeEnd, true);
    doc.addEventListener('pointercancel', this.onResizeEnd, true);
  }

  private resizeWithKey(event: KeyboardEvent, edge: 'left' | 'right'): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const view = this.host?.ownerDocument.defaultView;
    const card = this.parts?.card;
    const fontSize = (card && Number.parseFloat(view?.getComputedStyle(card).fontSize ?? '')) || 12;
    const step = event.shiftKey ? 2 : 1;
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const current =
      this.width > 0
        ? this.width
        : Math.max(
            TRANSLATION_POPUP_WIDTH_MIN_EM,
            (this.parts?.card.offsetWidth ?? FALLBACK_CARD_WIDTH_PX) / fontSize,
          );
    const maximum = Math.max(
      TRANSLATION_POPUP_WIDTH_MIN_EM,
      ((view?.innerWidth ?? 800) - 16) / fontSize,
    );
    const next = Math.min(
      maximum,
      Math.max(
        TRANSLATION_POPUP_WIDTH_MIN_EM,
        current + direction * (edge === 'right' ? step : -step),
      ),
    );
    if (Math.abs(next - current) < 0.01) return;
    this.applyWidth(next);
    this.commitWidth();
  }

  private buildPanel(): { host: HTMLElement; parts: PanelParts } {
    const doc = document;
    const host = doc.createElement('div');
    host.dataset.sakuttoImageTranslation = '';
    host.setAttribute('translate', 'no');
    host.style.position = 'fixed';
    host.style.zIndex = '2147483646';
    // Keep the image popup's root open, as before this change: the file:// fallback page's
    // existing test and assistive tooling can reach the translated text through it.
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = IMAGE_BUBBLE_STYLE;

    const card = doc.createElement('div');
    card.className = 'card selection image';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', this.options.labels.heading);
    card.setAttribute('aria-live', 'polite');
    const kicker = doc.createElement('p');
    kicker.className = 'kicker';
    kicker.textContent = this.options.labels.heading;
    const body = doc.createElement('p');
    body.className = 'body translation';
    body.setAttribute('aria-live', 'polite');
    const details = doc.createElement('details');
    details.hidden = true;
    const summary = doc.createElement('summary');
    summary.textContent = this.options.labels.original;
    const source = doc.createElement('div');
    source.className = 'source';
    details.append(summary, source);
    const copyNote = doc.createElement('p');
    copyNote.className = 'note copy-note';
    copyNote.setAttribute('role', 'status');
    copyNote.setAttribute('aria-live', 'polite');
    copyNote.hidden = true;

    const copy = doc.createElement('button');
    copy.type = 'button';
    copy.className = 'copy';
    copy.disabled = true;
    copy.title = this.options.labels.copy;
    copy.setAttribute('aria-label', this.options.labels.copy);
    appendCopyIcons(doc, copy);
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.copyTranslatedText();
    });
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = this.options.labels.close;
    close.setAttribute('aria-label', this.options.labels.close);
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    });
    const controls = doc.createElement('div');
    controls.className = 'controls';
    controls.append(copy, close);

    const makeHandle = (edge: 'left' | 'right'): HTMLButtonElement => {
      const handle = doc.createElement('button');
      handle.type = 'button';
      handle.className = 'resize-handle ' + edge;
      handle.hidden = edge === 'left';
      handle.tabIndex = edge === 'left' ? -1 : 0;
      handle.title = this.options.labels.resize;
      handle.setAttribute('aria-label', this.options.labels.resize);
      handle.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight');
      handle.addEventListener('pointerdown', (event) => this.startResize(event, edge));
      handle.addEventListener('keydown', (event) => this.resizeWithKey(event, edge));
      handle.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.applyWidth(TRANSLATION_POPUP_WIDTH_AUTO);
        this.commitWidth();
      });
      return handle;
    };
    const resizeLeft = makeHandle('left');
    const resizeRight = makeHandle('right');
    card.append(kicker, body, details, copyNote, controls, resizeLeft, resizeRight);
    shadow.append(style, card);
    return {
      host,
      parts: { host, card, body, details, source, copy, copyNote, resizeLeft, resizeRight },
    };
  }

  private resetCopyFeedback(): void {
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.copyTimer = null;
    const parts = this.parts;
    if (!parts) return;
    parts.copyNote.hidden = true;
    parts.copyNote.textContent = '';
    delete parts.copy.dataset.state;
    parts.copy.setAttribute('aria-label', this.options.labels.copy);
    parts.copy.title = this.options.labels.copy;
  }

  private async copyTranslatedText(): Promise<void> {
    const parts = this.parts;
    const text = this.copyText;
    if (!text || !parts) return;
    const view = this.host?.ownerDocument.defaultView;
    const ok = await copyTextToClipboard(text, view?.navigator.clipboard ?? null, document);
    // The panel can be closed (or replaced by a newer image) while the clipboard promise is
    // pending. Do not paint feedback into detached controls or start a new timer for them.
    if (this.parts !== parts) return;
    const message = ok ? this.options.labels.copied : this.options.labels.copyFailed;
    parts.copyNote.textContent = message;
    parts.copyNote.hidden = false;
    if (ok) parts.copy.dataset.state = 'copied';
    else delete parts.copy.dataset.state;
    parts.copy.setAttribute('aria-label', message);
    parts.copy.title = message;
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.resetCopyFeedback(), 2600);
  }

  private paintPending(): void {
    const parts = this.parts;
    if (!parts) return;
    this.copyText = '';
    parts.card.setAttribute('aria-busy', 'true');
    parts.body.className = 'body translation';
    parts.body.textContent = this.options.labels.pending;
    parts.details.hidden = true;
    parts.copy.disabled = true;
    this.resetCopyFeedback();
  }

  private paintText(text: string, error: boolean, source?: string): void {
    const parts = this.parts;
    if (!parts) return;
    this.copyText = error ? '' : text;
    parts.card.setAttribute('aria-busy', 'false');
    parts.body.className = error ? 'body translation error' : 'body translation';
    parts.body.textContent = text;
    parts.copy.disabled = error || text.trim().length === 0;
    parts.details.hidden = !source;
    if (source) parts.source.textContent = source;
    this.resetCopyFeedback();
    this.reposition();
  }

  private async readPixels(sourceUrl: string): Promise<ImageDataLike> {
    const image = findTargetImage(sourceUrl);
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
    if (!bounds) throw new ImageCapturePermissionError();
    const geometry = topLevelImageCaptureGeometry(bounds);
    if (!geometry?.rect) throw new ImageCapturePermissionError();
    const response: unknown = await browser.runtime.sendMessage({
      type: 'image:capture',
      rect: geometry.rect,
    } satisfies ImageCaptureRequest);
    if (typeof response !== 'string' || !response.startsWith('data:image/')) {
      throw new ImageCapturePermissionError();
    }
    return capturedPixels(response, geometry);
  }
}
