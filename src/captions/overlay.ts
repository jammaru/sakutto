import {
  VIDEO_CAPTION_SIZE_DEFAULT,
  VIDEO_CAPTION_SIZE_MAX,
  VIDEO_CAPTION_SIZE_MIN,
  type DisplayMode,
} from '@/shared/settings';

export interface CaptionOverlayLabels {
  label: string;
  pending: string;
  showOriginal: string;
  hideOriginal: string;
}

export interface CaptionOverlayState {
  original: string;
  translation: string | null;
  display: DisplayMode;
  pending: boolean;
}

export const CAPTION_OVERLAY_HOST = 'sakutto-captions';
export const CAPTION_ORIGINAL_TOGGLE = 'caption-original-toggle';

const TOGGLE_EVENTS = ['pointerdown', 'mousedown', 'click', 'pointerup', 'mouseup'] as const;

const STYLE = `
:host { all: initial; }
.wrap {
  box-sizing: border-box;
  pointer-events: none;
  display: grid;
  gap: 6px;
  justify-items: center;
  text-align: center;
  font: var(--sakutto-caption-size, 22px)/1.35 "YouTube Noto", "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
}
.line {
  box-sizing: border-box;
  max-width: 100%;
  padding: 0.18em 0.55em;
  border-radius: 0.28em;
  background: rgb(8 8 8 / 92%);
  color: #fff;
  text-shadow: 0 1px 2px rgb(0 0 0 / 80%);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 1em;
  font-weight: 500;
  pointer-events: none;
}
.original {
  font-size: 0.68em;
  font-weight: 400;
  color: #e8eef4;
  background: rgb(8 8 8 / 82%);
}
::slotted(.toggle) {
  pointer-events: auto;
}
`;

const TOGGLE_STYLE = [
  'all: initial',
  'pointer-events: auto',
  'box-sizing: border-box',
  'display: inline-flex',
  'align-items: center',
  'justify-content: center',
  'min-height: 32px',
  'min-width: 44px',
  'margin-top: 6px',
  'padding: 8px 14px',
  'border: 0',
  'border-radius: 999px',
  'background: rgb(15 23 32 / 82%)',
  'color: #e2e8f0',
  'font: 600 13px/1.3 "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif',
  'letter-spacing: 0',
  'white-space: nowrap',
  'cursor: pointer',
  'user-select: none',
  'z-index: 2147483647',
].join('; ');

const shadows = new WeakMap<Element, ShadowRoot>();

function attachCaptionShadow(host: HTMLElement): ShadowRoot {
  const existing = shadows.get(host);
  if (existing) return existing;
  const shadow = host.attachShadow({ mode: 'closed' });
  shadows.set(host, shadow);
  return shadow;
}

/**
 * Places the overlay just above the bottom edge of the video, centered.
 * `left` is the centre so the host can `translateX(-50%)`.
 * Width tracks the player (theater / fullscreen included); it is not capped at 720px.
 * `padding` lifts the cluster above YouTube's control bar when that height is known.
 */
export function captionOverlayBox(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  padding = 18,
): { left: number; top: number; width: number } {
  const width = Math.max(220, rect.width * 0.94);
  return {
    left: rect.left + rect.width / 2,
    top: rect.top + rect.height - padding,
    width,
  };
}

/** Match YouTube's native caption size: native computed px, else ~5% of player height. */
export function captionOverlayFontPx(
  playerHeight: number,
  nativePx?: number,
  scale = VIDEO_CAPTION_SIZE_DEFAULT,
): number {
  const base =
    nativePx !== undefined && Number.isFinite(nativePx) && nativePx >= 14
      ? Math.min(64, nativePx)
      : Math.min(56, Math.max(20, playerHeight * 0.05));
  const factor = Number.isFinite(scale)
    ? Math.min(VIDEO_CAPTION_SIZE_MAX, Math.max(VIDEO_CAPTION_SIZE_MIN, scale)) / 100
    : VIDEO_CAPTION_SIZE_DEFAULT / 100;
  return Math.round(Math.min(64, Math.max(12, base * factor)));
}

/**
 * Attach to the player (not the inner video container) so the overlay stacks above
 * `.ytp-chrome-bottom`. Fullscreen uses the fullscreen element.
 */
export function captionOverlayRoot(doc: Document, video: HTMLVideoElement): Element {
  const view = doc.defaultView;
  const fullscreen = view?.document.fullscreenElement ?? doc.fullscreenElement;
  if (fullscreen && (fullscreen === video || fullscreen.contains(video))) return fullscreen;
  const player = video.closest(
    '#movie_player, .html5-video-player, [data-testid="videoPlayer"], [data-testid="videoComponent"]',
  );
  if (player) return player;
  return video.parentElement ?? doc.documentElement;
}

export function captionChromeInset(root: ParentNode): number {
  const chrome = root.querySelector('.ytp-chrome-bottom');
  if (chrome instanceof HTMLElement) {
    const height = chrome.getBoundingClientRect().height;
    if (Number.isFinite(height) && height > 0) return Math.max(18, Math.round(height));
  }
  if (
    root instanceof Element &&
    (root.matches('[data-testid="videoPlayer"], [data-testid="videoComponent"]') ||
      root.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"]'))
  ) {
    return 52;
  }
  return 18;
}

export class CaptionOverlay {
  private readonly host: HTMLElement;
  private readonly originalLine: HTMLElement;
  private readonly translatedLine: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly captureDoc: Document;
  private labels: CaptionOverlayLabels;
  private onDisplayToggle: () => void = () => undefined;
  private captureBound = false;

  constructor(doc: Document, labels: CaptionOverlayLabels) {
    this.labels = labels;
    this.captureDoc = doc;
    this.host = doc.createElement(CAPTION_OVERLAY_HOST);
    this.host.setAttribute('translate', 'no');
    this.host.setAttribute('aria-live', 'polite');
    this.host.hidden = true;
    this.host.style.position = 'fixed';
    this.host.style.zIndex = '2147483646';
    this.host.style.pointerEvents = 'none';
    this.host.style.transform = 'translate(-50%, -100%)';

    const shadow = attachCaptionShadow(this.host);
    const style = doc.createElement('style');
    style.textContent = STYLE;
    const wrap = doc.createElement('div');
    wrap.className = 'wrap';
    this.originalLine = doc.createElement('div');
    this.originalLine.className = 'line original';
    this.translatedLine = doc.createElement('div');
    this.translatedLine.className = 'line';
    const slot = doc.createElement('slot');
    slot.name = 'toggle';
    this.toggle = doc.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = 'toggle';
    this.toggle.slot = 'toggle';
    this.toggle.setAttribute('data-sakutto', CAPTION_ORIGINAL_TOGGLE);
    this.toggle.style.cssText = TOGGLE_STYLE;
    wrap.append(this.originalLine, this.translatedLine, slot);
    shadow.append(style, wrap);
    this.host.append(this.toggle);
    this.setLabels(labels);
  }

  setOnDisplayToggle(handler: () => void): void {
    this.onDisplayToggle = handler;
  }

  setLabels(labels: CaptionOverlayLabels): void {
    this.labels = labels;
    this.host.setAttribute('aria-label', labels.label);
    this.toggle.setAttribute('aria-label', labels.showOriginal);
  }

  attach(root: Element): void {
    if (this.host.parentElement !== root) root.append(this.host);
    this.bindToggleCapture();
  }

  detach(): void {
    this.unbindToggleCapture();
    this.host.remove();
  }

  place(
    rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
    fontPx?: number,
    bottomInset = 18,
  ): void {
    const box = captionOverlayBox(rect, bottomInset);
    this.host.style.left = `${box.left}px`;
    this.host.style.top = `${box.top}px`;
    this.host.style.width = `${box.width}px`;
    const size = fontPx ?? captionOverlayFontPx(rect.height);
    this.host.style.setProperty('--sakutto-caption-size', `${size}px`);
  }

  show(state: CaptionOverlayState): void {
    const translation = state.translation?.trim() ?? '';
    const original = state.original.trim();
    if (original.length === 0 && translation.length === 0) {
      this.hide();
      return;
    }

    const bilingual = state.display === 'bilingual';
    const showTranslation = translation.length > 0;
    const showOriginal = bilingual && original.length > 0;
    this.originalLine.textContent = original;
    // Never paint "Translating…" over the video. Pending is a data flag only.
    this.translatedLine.textContent = showTranslation ? translation : original;
    this.originalLine.hidden = !showOriginal;
    this.translatedLine.hidden = !showTranslation && bilingual;
    if (!bilingual) {
      this.translatedLine.hidden = false;
      this.translatedLine.textContent = showTranslation ? translation : original;
    }
    const toggleLabel = bilingual ? this.labels.hideOriginal : this.labels.showOriginal;
    if (this.toggle.textContent !== toggleLabel) this.toggle.textContent = toggleLabel;
    if (this.toggle.getAttribute('aria-label') !== toggleLabel) {
      this.toggle.setAttribute('aria-label', toggleLabel);
    }
    const displayed = showTranslation ? translation : original;
    this.host.setAttribute('data-sakutto-caption', displayed);
    this.host.setAttribute('data-sakutto-original', original);
    this.host.setAttribute('data-sakutto-show-original', showOriginal ? '1' : '0');
    if (state.pending) this.host.setAttribute('data-sakutto-pending', '1');
    else this.host.removeAttribute('data-sakutto-pending');
    this.host.hidden = false;
  }

  hide(): void {
    this.host.hidden = true;
    this.originalLine.textContent = '';
    this.translatedLine.textContent = '';
    this.host.removeAttribute('data-sakutto-caption');
    this.host.removeAttribute('data-sakutto-original');
    this.host.removeAttribute('data-sakutto-show-original');
    this.host.removeAttribute('data-sakutto-pending');
  }

  shadow(): ShadowRoot | null {
    return shadows.get(this.host) ?? null;
  }

  private bindToggleCapture(): void {
    if (this.captureBound) return;
    this.captureBound = true;
    for (const type of TOGGLE_EVENTS) {
      this.captureDoc.addEventListener(type, this.onToggleCapture, true);
    }
  }

  private unbindToggleCapture(): void {
    if (!this.captureBound) return;
    this.captureBound = false;
    for (const type of TOGGLE_EVENTS) {
      this.captureDoc.removeEventListener(type, this.onToggleCapture, true);
    }
  }

  /**
   * One toggle per gesture. Swallow pointer/mouse down/up so YouTube cannot steal them,
   * but only `click` flips the setting. Toggling on pointerdown *and* click made a
   * normal press flip twice (hide then immediately show); a long press suppressed
   * `click` and appeared to work.
   */
  private onToggleCapture = (event: Event): void => {
    if (!this.eventHitsToggle(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.type === 'click') this.onDisplayToggle();
  };

  private eventHitsToggle(event: Event): boolean {
    if (this.host.hidden) return false;
    const path = event.composedPath();
    if (path.includes(this.toggle) || event.target === this.toggle) return true;
    if (!('clientX' in event) || !('clientY' in event)) return false;
    const { clientX, clientY } = event as PointerEvent;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
    const rect = this.toggle.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return (
      clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    );
  }
}
