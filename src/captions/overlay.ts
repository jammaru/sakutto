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
/** Hide the on-player control after this idle window, like native player chrome. */
export const CAPTION_TOGGLE_HIDE_MS = 2_000;

const TOGGLE_EVENTS = ['pointerdown', 'mousedown', 'click', 'pointerup', 'mouseup'] as const;
const HOVER_EVENTS = ['pointermove', 'pointerdown', 'mousemove'] as const;

const STYLE = `
:host { all: initial; overflow: visible; }
:host([hidden]) { display: none !important; visibility: hidden !important; }
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
.line[hidden],
.line:empty {
  display: none !important;
  padding: 0 !important;
  background: transparent !important;
}
.original {
  font-size: 0.68em;
  font-weight: 400;
  color: #e8eef4;
  background: rgb(8 8 8 / 82%);
}
`;

const TOGGLE_STYLE = [
  'all: initial',
  'pointer-events: auto',
  'box-sizing: border-box',
  'position: absolute',
  'right: 8px',
  'left: auto',
  'top: auto',
  'display: inline-flex',
  'align-items: center',
  'justify-content: center',
  'min-height: 22px',
  'min-width: 0',
  'margin: 0',
  'padding: 4px 8px',
  'border: 0',
  'border-radius: 999px',
  'background: rgb(15 23 32 / 78%)',
  'color: #e2e8f0',
  'font: 600 11px/1.2 "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif',
  'letter-spacing: 0',
  'white-space: nowrap',
  'cursor: pointer',
  'user-select: none',
  'z-index: 2147483647',
  'transform: none',
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

/** Absolute placement inside the player; grows up from `bottom` so overflow:hidden cannot clip it. */
export const X_CAPTION_CHROME_FALLBACK_PX = 88;
/** Only count chrome in this band from the bottom; mid-player play/mute buttons are not chrome. */
export const X_CAPTION_CHROME_BAND = 0.22;

export function captionOverlayPlacement(
  rect: Pick<DOMRect, 'width'>,
  padding = 18,
): { width: number; bottom: number } {
  return {
    width: Math.max(220, rect.width * 0.94),
    bottom: Math.max(0, padding),
  };
}

/**
 * YouTube-normal size at the default 80% scale. Used as the auto/base floor, not as a
 * clamp on an explicitly smaller slider setting.
 */
export const CAPTION_FONT_MIN_PX = 22;
export const CAPTION_FONT_MAX_PX = 64;
/** Player/video boxes below this are treated as unset (0, collapsed, mid-transition). */
export const CAPTION_LAYOUT_MIN_PX = 160;
/** Unscaled auto size so default 80% stays YouTube-normal (~22px). */
const CAPTION_FONT_BASE_MIN_PX = 28;
/** Typical watch-page height so the settings preview matches a real player. */
export const CAPTION_PREVIEW_PLAYER_PX = 540;

/** Match YouTube's native caption size: ~5.5% of a settled player, never a 0×0 box. */
export function captionOverlayFontPx(
  playerHeight: number,
  nativePx?: number,
  scale = VIDEO_CAPTION_SIZE_DEFAULT,
): number {
  const factor = Number.isFinite(scale)
    ? Math.min(VIDEO_CAPTION_SIZE_MAX, Math.max(VIDEO_CAPTION_SIZE_MIN, scale)) / 100
    : VIDEO_CAPTION_SIZE_DEFAULT / 100;
  const height = Number.isFinite(playerHeight) ? playerHeight : 0;
  // Tiny/collapsed rects keep a YouTube-normal *base* so theater transitions cannot
  // shrink type to 0. The user's scale is applied after that, without a 22px clamp.
  const fromPlayer =
    height >= CAPTION_LAYOUT_MIN_PX
      ? Math.min(CAPTION_FONT_MAX_PX, Math.max(CAPTION_FONT_BASE_MIN_PX, height * 0.055))
      : CAPTION_FONT_BASE_MIN_PX;
  const nativeOk =
    nativePx !== undefined &&
    Number.isFinite(nativePx) &&
    nativePx >= CAPTION_FONT_MIN_PX &&
    nativePx <= CAPTION_FONT_MAX_PX;
  const base = nativeOk ? Math.max(nativePx, fromPlayer) : fromPlayer;
  return Math.round(Math.min(CAPTION_FONT_MAX_PX, base * factor));
}

export type CaptionLayoutRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

/**
 * Prefer a laid-out player/video box. A 0×0 or collapsed rect (theater/miniplayer
 * transition) must not shrink type: reuse the last good box instead.
 */
export function pickCaptionLayoutRect(
  video: CaptionLayoutRect,
  player: CaptionLayoutRect | null | undefined,
  previous?: CaptionLayoutRect | null,
): CaptionLayoutRect {
  const width = Math.max(video.width, player?.width ?? 0);
  const height = Math.max(video.height, player?.height ?? 0);
  const origin =
    video.width >= CAPTION_LAYOUT_MIN_PX && video.height >= CAPTION_LAYOUT_MIN_PX
      ? video
      : (player ?? video);
  if (width >= CAPTION_LAYOUT_MIN_PX && height >= CAPTION_LAYOUT_MIN_PX) {
    return { left: origin.left, top: origin.top, width, height };
  }
  if (
    previous &&
    previous.width >= CAPTION_LAYOUT_MIN_PX &&
    previous.height >= CAPTION_LAYOUT_MIN_PX
  ) {
    return previous;
  }
  return { left: origin.left, top: origin.top, width, height };
}

const X_PLAYER_ROOT_SELECTOR = '[data-testid="videoPlayer"], [data-testid="videoComponent"]';

/**
 * Attach to the player (not the inner video container) so the overlay stacks above
 * `.ytp-chrome-bottom`. Fullscreen uses the fullscreen element.
 * Prefer the outer X `videoPlayer` over an overflow-hidden inner wrapper.
 */
export function captionOverlayRoot(doc: Document, video: HTMLVideoElement): Element {
  const view = doc.defaultView;
  const fullscreen = view?.document.fullscreenElement ?? doc.fullscreenElement;
  if (fullscreen && (fullscreen === video || fullscreen.contains(video))) {
    const nested = video.closest(X_PLAYER_ROOT_SELECTOR);
    if (nested && fullscreen.contains(nested)) return nested;
    return fullscreen;
  }
  const player = video.closest(`#movie_player, .html5-video-player, ${X_PLAYER_ROOT_SELECTOR}`);
  if (player) {
    const outer = player.closest(X_PLAYER_ROOT_SELECTOR);
    return outer ?? player;
  }
  const modal = video.closest('[role="dialog"], [aria-modal="true"]');
  if (modal) {
    const nested = modal.querySelector(X_PLAYER_ROOT_SELECTOR);
    if (nested) return nested;
    return modal;
  }
  return video.parentElement ?? doc.documentElement;
}

/** Make the player a containing block so absolute overlay coords stay inside it. */
export function prepareCaptionOverlayRoot(root: Element): void {
  if (!(root instanceof HTMLElement)) return;
  const view = root.ownerDocument.defaultView;
  const position = view?.getComputedStyle(root).position ?? root.style.position;
  if (!position || position === 'static') root.style.position = 'relative';
}

export function captionChromeInset(root: ParentNode): number {
  const chrome = root.querySelector('.ytp-chrome-bottom');
  if (chrome instanceof HTMLElement) {
    const height = chrome.getBoundingClientRect().height;
    if (Number.isFinite(height) && height > 0) return Math.max(18, Math.round(height));
  }
  if (isXPlayerRoot(root)) {
    return measureXChromeInset(root) ?? X_CAPTION_CHROME_FALLBACK_PX;
  }
  return 18;
}

function isXPlayerRoot(root: ParentNode): boolean {
  return (
    root instanceof Element &&
    (root.matches(X_PLAYER_ROOT_SELECTOR) || Boolean(root.closest(X_PLAYER_ROOT_SELECTOR)))
  );
}

function measureXChromeInset(root: ParentNode): number | null {
  if (!(root instanceof Element)) return null;
  const playerRect = root.getBoundingClientRect();
  if (playerRect.height <= 0) return null;
  const band = Math.min(playerRect.height * X_CAPTION_CHROME_BAND, 96);
  let inset = 0;
  for (const node of root.querySelectorAll(
    'button, [role="button"], [role="slider"], [role="progressbar"], input[type="range"]',
  )) {
    if (node.closest(CAPTION_OVERLAY_HOST)) continue;
    if (node.closest(`[data-sakutto="${CAPTION_ORIGINAL_TOGGLE}"]`)) continue;
    const rect = node.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) continue;
    const fromBottom = playerRect.bottom - rect.top;
    if (fromBottom > 12 && fromBottom <= band + 12) {
      inset = Math.max(inset, fromBottom);
    }
  }
  return inset > 0 ? Math.max(X_CAPTION_CHROME_FALLBACK_PX, Math.round(inset + 10)) : null;
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
  private playerRoot: Element | null = null;
  private toggleEnabled = true;
  private overlayActive = false;
  private controlsVisible = false;
  private hideToggleTimer: number | null = null;
  private lastBottomInset = 18;
  private toggleLabel = '';

  constructor(doc: Document, labels: CaptionOverlayLabels) {
    this.labels = labels;
    this.captureDoc = doc;
    this.host = doc.createElement(CAPTION_OVERLAY_HOST);
    this.host.setAttribute('translate', 'no');
    this.host.setAttribute('aria-live', 'polite');
    this.host.hidden = true;
    this.host.style.position = 'absolute';
    this.host.style.zIndex = '2147483646';
    this.host.style.pointerEvents = 'none';
    this.host.style.overflow = 'visible';
    this.host.style.transform = 'translateX(-50%)';

    const shadow = attachCaptionShadow(this.host);
    const style = doc.createElement('style');
    style.textContent = STYLE;
    const wrap = doc.createElement('div');
    wrap.className = 'wrap';
    this.originalLine = doc.createElement('div');
    this.originalLine.className = 'line original';
    this.originalLine.hidden = true;
    this.translatedLine = doc.createElement('div');
    this.translatedLine.className = 'line';
    this.translatedLine.hidden = true;
    wrap.append(this.originalLine, this.translatedLine);
    shadow.append(style, wrap);
    this.toggle = doc.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = 'toggle';
    this.toggle.setAttribute('data-sakutto', CAPTION_ORIGINAL_TOGGLE);
    this.toggle.style.cssText = TOGGLE_STYLE;
    this.toggle.hidden = true;
    this.toggle.style.display = 'none';
    this.setLabels(labels);
  }

  setOnDisplayToggle(handler: () => void): void {
    this.onDisplayToggle = handler;
  }

  setToggleEnabled(enabled: boolean): void {
    this.toggleEnabled = enabled;
    this.syncToggle();
  }

  setLabels(labels: CaptionOverlayLabels): void {
    this.labels = labels;
    this.host.setAttribute('aria-label', labels.label);
    this.toggle.setAttribute('aria-label', labels.showOriginal);
  }

  attach(root: Element): void {
    prepareCaptionOverlayRoot(root);
    if (this.host.parentElement !== root) root.append(this.host);
    if (this.toggle.parentElement !== root) root.append(this.toggle);
    this.bindPlayerHover(root);
    this.bindToggleCapture();
  }

  detach(): void {
    this.unbindToggleCapture();
    this.unbindPlayerHover();
    this.clearHideToggleTimer();
    this.host.remove();
    this.toggle.remove();
  }

  place(
    rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
    fontPx?: number,
    bottomInset = 18,
  ): void {
    const box = captionOverlayPlacement(rect, bottomInset);
    this.lastBottomInset = box.bottom;
    this.host.style.position = 'absolute';
    this.host.style.left = '50%';
    this.host.style.right = 'auto';
    this.host.style.top = 'auto';
    this.host.style.bottom = `${box.bottom}px`;
    this.host.style.width = `${box.width}px`;
    this.host.style.transform = 'translateX(-50%)';
    this.host.style.overflow = 'visible';
    const size = fontPx ?? captionOverlayFontPx(rect.height);
    this.host.style.setProperty('--sakutto-caption-size', `${size}px`);
    this.toggle.style.position = 'absolute';
    this.toggle.style.right = '8px';
    this.toggle.style.left = 'auto';
    this.toggle.style.top = 'auto';
    this.toggle.style.bottom = `${Math.max(8, box.bottom)}px`;
    this.toggle.style.transform = 'none';
  }

  show(state: CaptionOverlayState): void {
    const translation = state.translation?.trim() ?? '';
    const original = state.original.trim();
    // Native captions stay until a translation exists. Never paint empty black boxes.
    if (translation.length === 0) {
      this.hide();
      return;
    }

    const bilingual = state.display === 'bilingual';
    const showOriginal = bilingual && original.length > 0;
    this.originalLine.textContent = showOriginal ? original : '';
    this.translatedLine.textContent = translation;
    this.originalLine.hidden = !showOriginal;
    this.translatedLine.hidden = false;
    this.toggleLabel = bilingual ? this.labels.hideOriginal : this.labels.showOriginal;
    if (this.toggle.getAttribute('aria-label') !== this.toggleLabel) {
      this.toggle.setAttribute('aria-label', this.toggleLabel);
    }
    this.host.setAttribute('data-sakutto-caption', translation);
    this.host.setAttribute('data-sakutto-original', original);
    this.host.setAttribute('data-sakutto-show-original', showOriginal ? '1' : '0');
    if (state.pending) this.host.setAttribute('data-sakutto-pending', '1');
    else this.host.removeAttribute('data-sakutto-pending');
    this.overlayActive = true;
    this.host.hidden = false;
    this.syncToggle();
  }

  hide(): void {
    this.overlayActive = false;
    this.host.hidden = true;
    this.originalLine.textContent = '';
    this.translatedLine.textContent = '';
    this.originalLine.hidden = true;
    this.translatedLine.hidden = true;
    this.host.removeAttribute('data-sakutto-caption');
    this.host.removeAttribute('data-sakutto-original');
    this.host.removeAttribute('data-sakutto-show-original');
    this.host.removeAttribute('data-sakutto-pending');
    this.syncToggle();
  }

  shadow(): ShadowRoot | null {
    return shadows.get(this.host) ?? null;
  }

  private bindPlayerHover(root: Element): void {
    if (this.playerRoot === root) return;
    this.unbindPlayerHover();
    this.playerRoot = root;
    for (const type of HOVER_EVENTS) {
      root.addEventListener(type, this.onPlayerPointer, true);
    }
    root.addEventListener('pointerleave', this.onPlayerLeave, true);
    try {
      if (root instanceof Element && root.matches(':hover')) this.revealToggle();
    } catch {
      // :hover is not always queryable.
    }
  }

  private unbindPlayerHover(): void {
    const root = this.playerRoot;
    if (!root) return;
    for (const type of HOVER_EVENTS) {
      root.removeEventListener(type, this.onPlayerPointer, true);
    }
    root.removeEventListener('pointerleave', this.onPlayerLeave, true);
    this.playerRoot = null;
  }

  private readonly onPlayerPointer = (): void => {
    this.revealToggle();
  };

  private readonly onPlayerLeave = (event: Event): void => {
    const next = 'relatedTarget' in event ? (event as PointerEvent).relatedTarget : null;
    if (next instanceof Node && this.playerRoot?.contains(next)) return;
    if (next === this.toggle || (next instanceof Node && this.toggle.contains(next))) return;
    this.controlsVisible = false;
    this.syncToggle();
  };

  private revealToggle(): void {
    this.controlsVisible = true;
    this.syncToggle();
    this.scheduleHideToggle();
  }

  private scheduleHideToggle(): void {
    this.clearHideToggleTimer();
    const view = this.captureDoc.defaultView;
    this.hideToggleTimer =
      view?.setTimeout(() => {
        this.hideToggleTimer = null;
        this.controlsVisible = false;
        this.syncToggle();
      }, CAPTION_TOGGLE_HIDE_MS) ?? null;
  }

  private clearHideToggleTimer(): void {
    if (this.hideToggleTimer === null) return;
    this.captureDoc.defaultView?.clearTimeout(this.hideToggleTimer);
    this.hideToggleTimer = null;
  }

  private syncToggle(): void {
    const show = this.overlayActive && this.toggleEnabled && this.controlsVisible;
    this.toggle.hidden = !show;
    this.toggle.style.display = show ? 'inline-flex' : 'none';
    this.toggle.style.pointerEvents = show ? 'auto' : 'none';
    this.toggle.setAttribute('aria-hidden', show ? 'false' : 'true');
    this.toggle.style.bottom = `${Math.max(8, this.lastBottomInset)}px`;
    if (show && this.toggleLabel.length > 0 && this.toggle.textContent !== this.toggleLabel) {
      this.toggle.textContent = this.toggleLabel;
    }
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
    if (this.toggle.hidden || this.host.hidden) return false;
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
