import type { DisplayMode } from '@/shared/settings';

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
  background: rgb(8 8 8 / 80%);
  color: #fff;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 1em;
  font-weight: 500;
}
.original {
  font-size: 0.68em;
  font-weight: 400;
  color: #e8eef4;
  background: rgb(8 8 8 / 62%);
}
.toggle {
  pointer-events: auto;
  margin-top: 2px;
  padding: 2px 8px;
  border: 0;
  border-radius: 999px;
  background: rgb(15 23 32 / 72%);
  color: #e2e8f0;
  font: 11px/1.3 "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  cursor: pointer;
}
.toggle:focus-visible { outline: 2px solid #67e8f9; outline-offset: 2px; }
`;

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
export function captionOverlayFontPx(playerHeight: number, nativePx?: number): number {
  if (nativePx !== undefined && Number.isFinite(nativePx) && nativePx >= 14) {
    return Math.round(Math.min(64, nativePx));
  }
  return Math.round(Math.min(56, Math.max(20, playerHeight * 0.05)));
}

export function captionOverlayRoot(doc: Document, video: HTMLVideoElement): Element {
  const view = doc.defaultView;
  const fullscreen = view?.document.fullscreenElement ?? doc.fullscreenElement;
  if (fullscreen && (fullscreen === video || fullscreen.contains(video))) return fullscreen;
  return video.parentElement ?? doc.documentElement;
}

export class CaptionOverlay {
  private readonly host: HTMLElement;
  private readonly originalLine: HTMLElement;
  private readonly translatedLine: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private labels: CaptionOverlayLabels;
  private onDisplayToggle: () => void = () => undefined;

  constructor(doc: Document, labels: CaptionOverlayLabels) {
    this.labels = labels;
    this.host = doc.createElement(CAPTION_OVERLAY_HOST);
    this.host.setAttribute('translate', 'no');
    this.host.setAttribute('aria-live', 'polite');
    this.host.hidden = true;
    this.host.style.position = 'fixed';
    this.host.style.zIndex = '2147483645';
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
    this.toggle = doc.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = 'toggle';
    this.toggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onDisplayToggle();
    });
    wrap.append(this.originalLine, this.translatedLine, this.toggle);
    shadow.append(style, wrap);
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
    if (this.host.parentElement === root) return;
    root.append(this.host);
  }

  detach(): void {
    this.host.remove();
  }

  place(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, fontPx?: number): void {
    const box = captionOverlayBox(rect);
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
    this.originalLine.textContent = original;
    // Never paint "Translating…" over the video. Pending is a data flag only.
    this.translatedLine.textContent = showTranslation ? translation : original;
    this.originalLine.hidden = !(bilingual && original.length > 0);
    this.translatedLine.hidden = !showTranslation && bilingual;
    if (!bilingual) {
      this.translatedLine.hidden = false;
      this.translatedLine.textContent = showTranslation ? translation : original;
    }
    this.toggle.textContent = bilingual ? this.labels.hideOriginal : this.labels.showOriginal;
    this.toggle.setAttribute(
      'aria-label',
      bilingual ? this.labels.hideOriginal : this.labels.showOriginal,
    );
    const displayed = showTranslation ? translation : original;
    this.host.setAttribute('data-sakutto-caption', displayed);
    this.host.setAttribute('data-sakutto-original', original);
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
    this.host.removeAttribute('data-sakutto-pending');
  }

  shadow(): ShadowRoot | null {
    return shadows.get(this.host) ?? null;
  }
}
