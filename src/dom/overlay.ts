import type { EngineKind } from '@/engine/types';
import { copyTextToClipboard } from '@/shared/clipboard-copy';
import {
  normalizeTranslationPopupSize,
  normalizeTranslationPopupWidth,
  TRANSLATION_POPUP_SIZE_DEFAULT,
  TRANSLATION_POPUP_WIDTH_MIN_EM,
} from '@/shared/settings';
import { LINE_TAG } from './render';

/** Custom property carrying the popup text scale on each popup host. */
export const POPUP_TEXT_SCALE_VAR = '--sakutto-popup-scale';

export function popupTextScaleFactor(percent: number): number {
  return normalizeTranslationPopupSize(percent) / 100;
}

/**
 * `:host { all: initial }` in shadow styles resets inherited custom properties, so the
 * scale is written on the host and mirrored on the card inside the shadow root.
 */
export function applyPopupTextScale(host: HTMLElement, percent: number): void {
  const scale = String(popupTextScaleFactor(percent));
  host.style.setProperty(POPUP_TEXT_SCALE_VAR, scale);
  const card = uiShadow(host)?.querySelector('.card');
  if (card instanceof HTMLElement) {
    card.style.setProperty(POPUP_TEXT_SCALE_VAR, scale);
  }
}

/**
 * Writes translated text without ever parsing it as HTML. Every line-break mode now
 * produces real newline characters in the string (`blank` puts `\n\n` in the data), so
 * the plain `textContent` path carries exactly what copy and selection hand over.
 */
export function setPlainTextContent(element: HTMLElement, text: string): void {
  element.textContent = text;
}

/*
 * The selection popup scrolls its translation inside the card instead of growing to
 * the paragraph's full height. The cap sits on the translated-text area alone, so the
 * kicker, the engine note, and the copy/close row stay on screen while the text moves.
 * 40vh keeps roughly half the viewport free; the floor keeps a very short viewport
 * readable and the ceiling keeps a very tall one from growing without bound. The cap
 * is a ceiling, never a floor: a short translation still shrinks to its content.
 */
export const SELECTION_BODY_CAP_MIN_PX = 140;
export const SELECTION_BODY_CAP_MAX_PX = 420;
export const SELECTION_BODY_CAP_VH = 40;
/** `max-height` value of the selection popup's translated-text area. */
export const SELECTION_BODY_MAX_HEIGHT = `clamp(${SELECTION_BODY_CAP_MIN_PX}px, ${SELECTION_BODY_CAP_VH}vh, ${SELECTION_BODY_CAP_MAX_PX}px)`;

/** The cap as plain pixels for a viewport height. Pure, so tests can pin the arithmetic. */
export function selectionBodyCapPx(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return SELECTION_BODY_CAP_MIN_PX;
  return Math.min(
    SELECTION_BODY_CAP_MAX_PX,
    Math.max(SELECTION_BODY_CAP_MIN_PX, (viewportHeight * SELECTION_BODY_CAP_VH) / 100),
  );
}

/** A scroller within this many pixels of its end counts as pinned to the bottom. */
export const SELECTION_SCROLL_PIN_PX = 2;

/** The box-model inputs the selection scroll offset is decided from. */
export interface SelectionScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * True when the new translation text continues the previous one — a streaming append,
 * not a restart that rewrote the popup from scratch.
 */
export function selectionTextExtends(previous: string, next: string): boolean {
  return previous.length > 0 && next.length > previous.length && next.startsWith(previous);
}

/**
 * Scroll offset the selection popup's translated-text area takes after its text was
 * replaced by a streaming paint.
 *
 * A newly opened popup and the first real text after the pending placeholder start at
 * the top. A streaming append keeps the reader where they were: already at the bottom
 * (or still short of the cap, which reads as the bottom), the text stays pinned to the
 * new end; scrolled up, the reader's offset survives, clamped so it cannot sit past
 * the new end. Any other replacement keeps the old offset under the same clamp.
 */
export function nextSelectionScrollOffset(reading: {
  opening: boolean;
  wasPending: boolean;
  extendsPrevious: boolean;
  before: SelectionScrollBox;
  after: SelectionScrollBox;
}): number {
  if (reading.opening || reading.wasPending) return 0;
  const maxAfter = Math.max(0, reading.after.scrollHeight - reading.after.clientHeight);
  if (reading.extendsPrevious) {
    const distance =
      reading.before.scrollHeight - reading.before.scrollTop - reading.before.clientHeight;
    if (distance <= SELECTION_SCROLL_PIN_PX) return maxAfter;
  }
  return Math.min(Math.max(reading.before.scrollTop, 0), maxAfter);
}

/** Metrics for tests; needs a laid-out card in a browser or happy-dom. */
export function popupCardMetrics(host: Element | null | undefined): {
  fontSizePx: number;
  widthPx: number;
  maxWidthPx: number;
} | null {
  const card = uiShadow(host)?.querySelector('.card');
  if (!(card instanceof HTMLElement)) return null;
  const view = card.ownerDocument.defaultView;
  if (!view) return null;
  const hostScale =
    host instanceof HTMLElement
      ? Number.parseFloat(host.style.getPropertyValue(POPUP_TEXT_SCALE_VAR))
      : Number.NaN;
  const cardScale = Number.parseFloat(card.style.getPropertyValue(POPUP_TEXT_SCALE_VAR));
  const scale = Number.isFinite(cardScale) ? cardScale : Number.isFinite(hostScale) ? hostScale : 1;
  const fontSizePx = 12 * scale;
  const maxWidthPx = 30 * fontSizePx;
  const style = view.getComputedStyle(card);
  const widthPx = Math.max(card.offsetWidth, card.scrollWidth);
  const parsedMax = Number.parseFloat(style.maxWidth);
  return {
    fontSizePx,
    widthPx,
    maxWidthPx: Number.isFinite(parsedMax) ? parsedMax : maxWidthPx,
  };
}

export interface OverlayLabels {
  original: string;
  chromeNote: string;
  machine: string;
  selectionPending: string;
  selectionFailed: string;
  selectionTitle: string;
  selectionIcon: string;
  /** Accessible label for the drag handle on the selection popup. */
  selectionResize: string;
  /** Accessible label and tooltip for the copy control on the selection popup. */
  selectionCopy: string;
  /** Brief confirmation shown after the translated selection was copied. */
  selectionCopied: string;
  /** Shown when copying the translated selection failed. */
  selectionCopyFailed: string;
  close: string;
  bilingualOn: string;
  replaceOn: string;
  barLabel: string;
  barProgress: (done: number, total: number) => string;
  barRate: (tokens: string, segments: string) => string;
  barDone: string;
  /** Shown when some source prose had no translatable segment. */
  barPartial: (blocks: number) => string;
  barOriginal: string;
  barAlways: string;
  barAlwaysOn: string;
  /** Shown when a local-server request fails; original page text stays. */
  engineFailed?: string;
  /** Shown when the active model was deleted while the page was translating. */
  modelMissing?: string;
  /** Shown when the shared folder grant is missing; points at the popup restore button. */
  folderPermission?: string;
  /** One-click grant control label (iframe page uses its own copy). */
  folderEnableTitle?: string;
}

/**
 * Replace mode rewrites the block's own text nodes, so the translation inherits the
 * page's own color and weight. Nothing here may lower contrast: an opacity on the
 * block would fade the page's text as well, and a `color-mix` on the translated run
 * would paint it a lighter gray than the original.
 *
 * Bilingual mode adds a second line under the original. It keeps the host color and
 * is only slightly smaller, so it reads as body copy instead of a caption.
 */
const PAGE_STYLE = `
${LINE_TAG} {
  display: block;
  margin: 0.2em 0 0.35em;
  color: inherit;
  font: inherit;
  line-height: 1.55;
}
/*
 * Older builds painted a "quick translation" badge next to Chrome drafts. Nothing renders
 * that badge any more, so there is no rule for it: translated text is never captioned.
 */
/*
 * [data-sakutto-pending="1"] has no rule on purpose. It used to fade the whole block to
 * 58% and shimmer down to 32%, so every block that PLaMo had not finished — and, because
 * the attribute could outlive a retried block, some that it had — read as pale gray
 * instead of Japanese. Progress is already shown by the status bar and by text that fills
 * in. It must not paint opacity 1 either: that would override a host that dims its own
 * text (disabled rows, carousel slides at opacity 0) and make content the page meant to
 * hide appear as soon as a block starts streaming.
 */
sakutto-status {
  position: fixed;
  z-index: 2147483646;
  left: 16px;
  bottom: 16px;
  box-sizing: border-box;
  max-width: min(30em, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  padding: 0.667em 1em;
  border-radius: 0.833em;
  border: 1px solid #d5dde6;
  background: #ffffff;
  color: #18202d;
  font-family: "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  font-size: calc(12px * var(${POPUP_TEXT_SCALE_VAR}, 1));
  line-height: 1.45;
  box-shadow: 0 8px 24px rgb(15 23 32 / 16%);
  overflow-wrap: anywhere;
}
@media (prefers-color-scheme: dark) {
  sakutto-status {
    border-color: #2d3947;
    background: #151b23;
    color: #edf1f6;
  }
}
`;

const BUBBLE_STYLE = `
:host {
  display: block;
  font: initial;
  color: initial;
}
.card {
  position: relative;
  box-sizing: border-box;
  width: max-content;
  max-width: min(30em, calc(100vw - 16px));
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 0.667em 0.833em;
  border-radius: 0.833em;
  border: 1px solid #d5dde6;
  background: #ffffff;
  color: #18202d;
  font-family: "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  font-size: calc(12px * var(${POPUP_TEXT_SCALE_VAR}, 1));
  line-height: 1.45;
  box-shadow: 0 8px 24px rgb(15 23 32 / 16%);
}
.kicker {
  margin: 0 0 0.333em;
  color: #5b6675;
  font-size: 0.833em;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.body {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/*
 * A touch pan that starts on the kicker, the engine note, the controls, or the card
 * padding is not a wheel event, so the wheel listener never runs for it. The card is
 * a scroll container — even when its content fits — and containment on it ends such a
 * gesture here instead of letting it chain to the document. The hover tooltip keeps
 * the default: its host ignores pointer events, so no pan can start inside it.
 */
.card.selection {
  overscroll-behavior: contain;
}
/*
 * Only the selection popup caps its translated text: its card carries the selection
 * class, while the hover tooltip keeps scrolling as one whole card. The cap is a
 * max-height, so a short translation still shrinks to its own height, and the
 * overscroll containment keeps touch gestures from chaining to the page.
 */
.card.selection .body {
  max-height: ${SELECTION_BODY_MAX_HEIGHT};
  overflow-y: auto;
  overscroll-behavior: contain;
}
.note {
  margin: 0.5em 0 0;
  color: #5b6675;
  font-size: 0.833em;
}
button {
  box-sizing: border-box;
  margin-top: 0.667em;
  padding: 0.333em 0.667em;
  border: 0;
  border-radius: 0.5em;
  background: #0e7490;
  color: #ffffff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
button:focus-visible { outline: 2px solid #0e7490; outline-offset: 2px; }
button:disabled { opacity: 0.6; cursor: default; }
/*
 * The copy control and the close control are the pair of this row. It stretches both to
 * the taller box, so the icon-only copy control renders at exactly the close control's
 * height whatever the locale spells on it, instead of following only its own icon box.
 * Everything else about the pair comes from the shared button rule above.
 */
.controls {
  display: flex;
  align-items: stretch;
}
.copy {
  display: inline-flex;
  align-items: center;
  margin-right: 0.5em;
  padding-inline: 0.5em;
}
.copy svg { display: block; width: 1.25em; height: 1.25em; }
.copy .icon-check { display: none; }
.copy[data-state='copied'] .icon-copy { display: none; }
.copy[data-state='copied'] .icon-check { display: block; }
.copy-note[hidden] { display: none; }
.resize-handle {
  position: absolute;
  z-index: 2;
  top: 50%;
  width: 10px;
  height: 2.8em;
  margin: 0;
  padding: 0;
  transform: translateY(-50%);
  border: 0;
  border-radius: 999px;
  background: transparent;
  cursor: ew-resize;
  touch-action: none;
  user-select: none;
}
.resize-handle::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 2px;
  height: 62%;
  transform: translate(-50%, -50%);
  border-radius: 999px;
  background: rgb(91 102 117 / 42%);
}
.resize-handle.right { right: 0; }
.resize-handle.left { left: 0; }
.resize-handle:hover::after,
.resize-handle:focus-visible::after { background: #0e7490; }
.resize-handle:focus-visible { outline: 2px solid #0e7490; outline-offset: -2px; }
.resize-handle[hidden] { display: none; }
@media (prefers-color-scheme: dark) {
  .card {
    border-color: #2d3947;
    background: #151b23;
    color: #edf1f6;
    box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
  }
  .kicker, .note { color: #b7c2cf; }
  button { background: #67e8f9; color: #062a33; }
  .resize-handle::after { background: rgb(183 194 207 / 42%); }
  .resize-handle:hover::after,
  .resize-handle:focus-visible::after { background: #67e8f9; }
}
@media (prefers-reduced-motion: reduce) {
  .card { transition: none; }
}
`;

const ICON_STYLE = `
:host { all: initial; }
button {
  box-sizing: border-box;
  display: block;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid rgb(255 255 255 / 88%);
  border-radius: 7px;
  background: #101828;
  box-shadow: 0 2px 8px rgb(15 23 32 / 28%);
  overflow: hidden;
  cursor: pointer;
  user-select: none;
}
button:hover,
button:focus-visible {
  border-color: #67e8f9;
}
button:focus-visible { outline: 2px solid #0e7490; outline-offset: 2px; }
svg { display: block; width: 26px; height: 26px; }
@media (prefers-reduced-motion: reduce) {
  button { transition: none; }
}
`;

/** Square control drawn beside a selection. Matches the shadow-DOM button. */
export const SELECTION_ICON_PX = 26;

/**
 * Puts the selection icon just outside the selection so the highlight stays readable.
 * The first choice is the end of the last line. A tight edge moves it below, then above.
 */
export function selectionIconBox(
  anchor: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>,
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const size = SELECTION_ICON_PX;
  const gap = 6;
  const margin = 8;
  const width = Math.max(viewport.width, size + margin * 2);
  const height = Math.max(viewport.height, size + margin * 2);
  const overlaps = (left: number, top: number): boolean =>
    left < anchor.right &&
    left + size > anchor.left &&
    top < anchor.bottom &&
    top + size > anchor.top;

  let left = anchor.right + gap;
  let top = anchor.top + (anchor.height - size) / 2;

  if (left + size > width - margin || overlaps(left, top)) {
    left = anchor.right - size;
    top = anchor.bottom + gap;
  }
  if (top + size > height - margin) {
    const above = anchor.top - size - gap;
    top = above >= margin ? above : anchor.bottom + gap;
  }

  left = Math.min(Math.max(left, margin), width - size - margin);
  top = Math.min(Math.max(top, margin), height - size - margin);

  if (overlaps(left, top)) {
    const below = anchor.bottom + gap;
    const above = anchor.top - size - gap;
    if (below + size <= height - margin) top = below;
    else if (above >= margin) top = above;
    left = Math.min(Math.max(anchor.left, margin), width - size - margin);
    top = Math.min(Math.max(top, margin), height - size - margin);
  }

  return { left, top };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Folded-strip mark. Same polygons as scripts/icon.svg. */
const SELECTION_ICON_POLYGONS: readonly (readonly [string, string])[] = [
  ['87.52,33.76 40.48,33.76 40.48,47.2 87.52,47.2', '#7dd3fc'],
  ['87.52,47.2 104.32,40.48 87.52,33.76', '#7dd3fc'],
  ['35.73,45.23 59.25,68.75 68.75,59.25 45.23,35.73', '#7dd3fc'],
  ['40.48,40.48 40.48,33.76 35.73,45.23', '#7dd3fc'],
  ['40.48,40.48 40.48,47.2 45.23,35.73', '#7dd3fc'],
  ['59.25,68.75 82.77,92.27 92.27,82.77 68.75,59.25', '#f8fafc'],
  ['87.52,80.8 40.48,80.8 40.48,94.24 87.52,94.24', '#f8fafc'],
  ['40.48,80.8 23.68,87.52 40.48,94.24', '#f8fafc'],
  ['87.52,87.52 82.77,92.27 87.52,80.8', '#f8fafc'],
  ['87.52,87.52 92.27,82.77 87.52,94.24', '#f8fafc'],
];

const uiShadows = new WeakMap<Element, ShadowRoot>();

/**
 * Shadow root of this extension's own UI.
 *
 * The root is closed. A page script can see the host element, and an open root would let
 * that script read it, rewrite the label, or click it. The content script keeps the root
 * here; the page's `shadowRoot` is null.
 */
export function uiShadow(host: Element | null | undefined): ShadowRoot | null {
  if (!host) return null;
  return uiShadows.get(host) ?? null;
}

function attachUiShadow(host: HTMLElement): ShadowRoot {
  const shadow = host.attachShadow({ mode: 'closed' });
  uiShadows.set(host, shadow);
  return shadow;
}

/**
 * The copy control's two glyphs: overlapping sheets for "copy", a tick for the brief
 * confirmation. Built with DOM constructors like the selection icon, so a page that
 * requires Trusted Types still gets the whole control.
 */
function appendCopyIcons(doc: Document, button: HTMLButtonElement): void {
  const sheets = doc.createElementNS(SVG_NS, 'svg');
  sheets.classList.add('icon-copy');
  sheets.setAttribute('viewBox', '0 0 16 16');
  sheets.setAttribute('aria-hidden', 'true');
  const back = doc.createElementNS(SVG_NS, 'path');
  back.setAttribute('d', 'M11 3.5H5.75A2.25 2.25 0 0 0 3.5 5.75v5.25');
  back.setAttribute('fill', 'none');
  back.setAttribute('stroke', 'currentColor');
  back.setAttribute('stroke-width', '1.6');
  back.setAttribute('stroke-linecap', 'round');
  sheets.append(back);
  const front = doc.createElementNS(SVG_NS, 'rect');
  front.setAttribute('x', '5.25');
  front.setAttribute('y', '5.25');
  front.setAttribute('width', '7.5');
  front.setAttribute('height', '7.5');
  front.setAttribute('rx', '1.6');
  front.setAttribute('fill', 'none');
  front.setAttribute('stroke', 'currentColor');
  front.setAttribute('stroke-width', '1.6');
  sheets.append(front);

  const tick = doc.createElementNS(SVG_NS, 'svg');
  tick.classList.add('icon-check');
  tick.setAttribute('viewBox', '0 0 16 16');
  tick.setAttribute('aria-hidden', 'true');
  const mark = doc.createElementNS(SVG_NS, 'path');
  mark.setAttribute('d', 'M4.5 8.5 6.75 10.75 11.5 5.25');
  mark.setAttribute('fill', 'none');
  mark.setAttribute('stroke', 'currentColor');
  mark.setAttribute('stroke-width', '1.8');
  mark.setAttribute('stroke-linecap', 'round');
  mark.setAttribute('stroke-linejoin', 'round');
  tick.append(mark);

  button.append(sheets, tick);
}

/**
 * Drawn with DOM constructors. `innerHTML` and `DOMParser.parseFromString` are
 * TrustedHTML sinks, so either one throws on pages that require Trusted Types
 * and the content script never attaches.
 */
function appendSelectionIcon(doc: Document, button: HTMLButtonElement): void {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 128 128');
  svg.setAttribute('aria-hidden', 'true');
  const rect = doc.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('width', '128');
  rect.setAttribute('height', '128');
  rect.setAttribute('fill', '#101828');
  svg.append(rect);
  for (const [points, fill] of SELECTION_ICON_POLYGONS) {
    const polygon = doc.createElementNS(SVG_NS, 'polygon');
    polygon.setAttribute('points', points);
    polygon.setAttribute('fill', fill);
    svg.append(polygon);
  }
  button.append(svg);
}

const BAR_STYLE = `
.bar {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 40px;
  padding: 0 12px;
  border-bottom: 1px solid #d5dde6;
  background: #ffffff;
  color: #18202d;
  font: 13px/1.4 "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  box-shadow: 0 1px 0 rgb(15 23 32 / 8%);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
button {
  border: 1px solid #c5d0dc;
  border-radius: 999px;
  background: #f7f9fb;
  color: inherit;
  font: inherit;
  padding: 2px 10px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.7;
  cursor: default;
}
@media (prefers-color-scheme: dark) {
  .bar {
    border-bottom-color: #2d3947;
    background: #151b23;
    color: #edf1f6;
  }
  button {
    border-color: #3c4b5e;
    background: #1d2631;
  }
}
`;

export class PageOverlay {
  private readonly style: HTMLStyleElement;
  private readonly tipHost: HTMLElement;
  private readonly popHost: HTMLElement;
  private readonly iconHost: HTMLElement;
  private readonly iconButton: HTMLButtonElement;
  private readonly tipBody: HTMLElement;
  private readonly tipNote: HTMLElement;
  private readonly tipKicker: HTMLElement;
  private readonly popBody: HTMLElement;
  private readonly popNote: HTMLElement;
  private readonly popKicker: HTMLElement;
  private readonly popCard: HTMLElement;
  private readonly popButton: HTMLButtonElement;
  private readonly popResizeLeft: HTMLButtonElement | null;
  private readonly popResizeRight: HTMLButtonElement | null;
  private readonly popCopy: HTMLButtonElement;
  private readonly popCopyNote: HTMLElement;
  private readonly status: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly barText: HTMLElement;
  private readonly barOriginal: HTMLButtonElement;
  private readonly barAlways: HTMLButtonElement;
  private readonly folderEnableHost: HTMLElement;
  private readonly folderEnableShadow: ShadowRoot;
  private readonly folderEnableHint: HTMLElement;
  private readonly folderEnableButton: HTMLButtonElement;
  private onFolderEnable: (() => void) | undefined;
  private labels: OverlayLabels;
  private returnFocus: HTMLElement | null = null;
  private onClose: (() => void) | null = null;
  private onSelectionIcon: (() => void) | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPopRect: DOMRect | null = null;
  private lastTipRect: DOMRect | null = null;
  /** The plain-text translation the copy control would copy, kept current by showSelection. */
  private selectionCopyText = '';
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private popupWidth = 0;
  private onPopupWidth: (widthEm: number) => void = () => undefined;
  private resizing: {
    edge: 'left' | 'right';
    pointerId: number;
    startX: number;
    startWidth: number;
    fontSize: number;
    capture: Element | null;
    changed: boolean;
  } | null = null;
  /**
   * A wheel or trackpad gesture over the popup never reaches the page. The card is no
   * longer the scroller, so a gesture over the header or the controls would otherwise
   * fall through to the document behind, and a text area already at its scroll edge
   * would chain there too. preventDefault closes every one of those paths, and the
   * capped text area itself scrolls while it still can. The width-resize drag, text
   * selection inside the translation, and the copy/close controls ride on pointer and
   * click events, which a canceled wheel never touches.
   */
  private readonly onPopWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const body = this.popBody;
    const max = Math.max(0, body.scrollHeight - body.clientHeight);
    if (max <= 0) return;
    const delta =
      event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? Math.sign(event.deltaY) * body.clientHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaY;
    if (delta === 0) return;
    body.scrollTop = Math.min(max, Math.max(0, body.scrollTop + delta));
  };
  private readonly onResizeMove = (event: PointerEvent): void => {
    const state = this.resizing;
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();
    const view = this.doc.defaultView;
    const minimum = TRANSLATION_POPUP_WIDTH_MIN_EM * state.fontSize;
    const maximum = Math.max(minimum, (view?.innerWidth ?? 800) - 16);
    const delta = event.clientX - state.startX;
    const raw = state.edge === 'right' ? state.startWidth + delta : state.startWidth - delta;
    const next = Math.min(maximum, Math.max(minimum, raw));
    this.applyPopupWidth(next / state.fontSize);
    state.changed = true;
    if (!this.popHost.hidden && this.lastPopRect) {
      this.place(this.popHost, this.lastPopRect, true);
    }
  };
  private readonly onResizeEnd = (event: PointerEvent): void => {
    const state = this.resizing;
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();
    this.stopResize(state.pointerId, state.capture);
    if (!state.changed) return;
    if (!this.popHost.hidden && this.lastPopRect) {
      this.place(this.popHost, this.lastPopRect, true);
    }
    this.onPopupWidth(this.popupWidth);
  };

  constructor(
    private readonly doc: Document,
    labels: OverlayLabels,
  ) {
    this.labels = labels;
    this.style = doc.createElement('style');
    this.style.id = 'sakutto-style';
    this.style.textContent = PAGE_STYLE;
    (doc.head ?? doc.documentElement).append(this.style);

    this.tipHost = doc.createElement('sakutto-tip');
    this.popHost = doc.createElement('sakutto-pop');
    this.iconHost = doc.createElement('sakutto-select');
    for (const host of [this.tipHost, this.popHost, this.iconHost]) {
      host.setAttribute('translate', 'no');
      host.style.position = 'fixed';
      host.style.zIndex = '2147483646';
      host.hidden = true;
      host.style.display = 'none';
      doc.documentElement.append(host);
    }
    this.tipHost.style.pointerEvents = 'none';
    this.iconHost.style.width = `${String(SELECTION_ICON_PX)}px`;
    this.iconHost.style.height = `${String(SELECTION_ICON_PX)}px`;
    this.iconButton = this.mountSelectionIcon(this.iconHost);

    const tip = this.mountBubble(this.tipHost, false);
    const pop = this.mountBubble(this.popHost, true);
    this.tipBody = tip.body;
    this.tipNote = tip.note;
    this.tipKicker = tip.kicker;
    this.popBody = pop.body;
    this.popNote = pop.note;
    this.popKicker = pop.kicker;
    this.popCard = pop.card;
    this.popButton = pop.button;
    this.popResizeLeft = pop.resizeLeft;
    this.popResizeRight = pop.resizeRight;
    this.popCopy = pop.copy;
    this.popCopyNote = pop.copyNote;
    // Non-passive on purpose: the handler has to cancel the gesture before the browser
    // scrolls anything behind the popup.
    this.popHost.addEventListener('wheel', this.onPopWheel, { passive: false });
    this.status = doc.createElement('sakutto-status');
    this.status.setAttribute('translate', 'no');
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;
    doc.documentElement.append(this.status);

    this.folderEnableHost = doc.createElement('sakutto-folder-enable');
    this.folderEnableHost.setAttribute('translate', 'no');
    this.folderEnableHost.hidden = true;
    this.folderEnableHost.style.display = 'none';
    this.folderEnableHost.style.position = 'fixed';
    this.folderEnableHost.style.zIndex = '2147483646';
    this.folderEnableHost.style.left = '16px';
    this.folderEnableHost.style.right = '16px';
    this.folderEnableHost.style.bottom = '16px';
    this.folderEnableHost.style.maxWidth = '320px';
    this.folderEnableHost.style.minWidth = '280px';
    this.folderEnableHost.style.minHeight = '64px';
    this.folderEnableHost.style.margin = '0 auto';
    this.folderEnableHost.style.border = '1px solid rgb(15 23 32 / 12%)';
    this.folderEnableHost.style.borderRadius = '10px';
    this.folderEnableHost.style.boxShadow = '0 8px 24px rgb(15 23 32 / 18%)';
    this.folderEnableHost.style.background = '#ffffff';
    this.folderEnableHost.style.opacity = '1';
    doc.documentElement.append(this.folderEnableHost);
    this.folderEnableShadow = attachUiShadow(this.folderEnableHost);
    const folderStyle = doc.createElement('style');
    folderStyle.textContent = `
      .panel { display: grid; gap: 8px; padding: 10px 12px; color: #101828; font: 12px/1.4 system-ui, sans-serif; }
      .hint { margin: 0; }
      .button { padding: 8px 10px; border: 0; border-radius: 8px; background: #0e7490; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    `;
    const panel = doc.createElement('div');
    panel.className = 'panel';
    this.folderEnableHint = doc.createElement('p');
    this.folderEnableHint.className = 'hint';
    this.folderEnableHint.textContent = this.labels.folderPermission ?? '';
    this.folderEnableButton = doc.createElement('button');
    this.folderEnableButton.type = 'button';
    this.folderEnableButton.className = 'button';
    this.folderEnableButton.textContent = this.labels.folderEnableTitle ?? '';
    this.folderEnableButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.isTrusted) return;
      this.onFolderEnable?.();
    });
    panel.append(this.folderEnableHint, this.folderEnableButton);
    this.folderEnableShadow.append(folderStyle, panel);

    this.bar = doc.createElement('sakutto-bar');
    this.bar.setAttribute('translate', 'no');
    this.bar.setAttribute('role', 'region');
    this.bar.setAttribute('aria-label', labels.barLabel);
    this.bar.hidden = true;
    this.bar.style.display = 'none';
    this.bar.style.position = 'fixed';
    this.bar.style.zIndex = '2147483646';
    this.bar.style.top = '0';
    this.bar.style.left = '0';
    this.bar.style.right = '0';
    this.bar.style.height = '40px';
    const shadow = attachUiShadow(this.bar);
    const style = doc.createElement('style');
    style.textContent = BAR_STYLE;
    const row = doc.createElement('div');
    row.className = 'bar';
    this.barText = doc.createElement('span');
    const actions = doc.createElement('span');
    actions.className = 'actions';
    this.barOriginal = doc.createElement('button');
    this.barOriginal.type = 'button';
    this.barOriginal.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onOriginal();
    });
    this.barAlways = doc.createElement('button');
    this.barAlways.type = 'button';
    this.barAlways.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onAlways();
    });
    actions.append(this.barOriginal, this.barAlways);
    row.append(this.barText, actions);
    shadow.append(style, row);
    doc.documentElement.append(this.bar);
    this.setPopupTextScale(TRANSLATION_POPUP_SIZE_DEFAULT);
    this.setPopupWidth(0);
  }

  private onOriginal: () => void = () => undefined;
  private onAlways: () => void = () => undefined;
  private pagePadding: string | null = null;

  private pageShift = 0;

  private reservePage(active: boolean): void {
    const root = this.doc.documentElement;
    const view = this.doc.defaultView;
    if (active) {
      if (this.pagePadding !== null) return;
      this.pagePadding = root.style.paddingTop;
      const before = readPadding(root);
      root.style.paddingTop = paddingWithBar(before);
      this.pageShift = Math.max(0, readPadding(root) - before);
      if (view && view.scrollY > 0 && this.pageShift > 0) view.scrollBy?.(0, this.pageShift);
      return;
    }
    if (this.pagePadding === null) return;
    const shift = this.pageShift;
    root.style.paddingTop = this.pagePadding;
    this.pagePadding = null;
    this.pageShift = 0;
    if (view && shift > 0 && view.scrollY > 0) view.scrollBy?.(0, -shift);
  }

  setBarActions(actions: { onOriginal: () => void; onAlways: () => void }): void {
    this.onOriginal = actions.onOriginal;
    this.onAlways = actions.onAlways;
  }

  setOnClose(handler: () => void): void {
    this.onClose = handler;
  }

  setOnSelectionIcon(handler: () => void): void {
    this.onSelectionIcon = handler;
  }

  setOnPopupWidth(handler: (widthEm: number) => void): void {
    this.onPopupWidth = handler;
  }

  setLabels(labels: OverlayLabels): void {
    this.labels = labels;
    this.folderEnableHint.textContent = labels.folderPermission ?? '';
    this.folderEnableButton.textContent = labels.folderEnableTitle ?? '';
    this.tipKicker.textContent = labels.original;
    this.popKicker.textContent = labels.selectionTitle;
    this.popCard.setAttribute('aria-label', labels.selectionTitle);
    this.popButton.textContent = labels.close;
    this.resetCopyFeedback();
    this.iconButton.setAttribute('aria-label', labels.selectionIcon);
    this.iconButton.title = labels.selectionIcon;
    for (const handle of [this.popResizeLeft, this.popResizeRight]) {
      handle?.setAttribute('aria-label', labels.selectionResize);
      if (handle) handle.title = labels.selectionResize;
    }
    this.bar.setAttribute('aria-label', labels.barLabel);
  }

  /** Restore a stored width, in em at 100% text scale. `0` keeps the auto width. */
  setPopupWidth(widthEm: number): void {
    this.applyPopupWidth(widthEm);
    if (!this.popHost.hidden && this.lastPopRect) {
      this.place(this.popHost, this.lastPopRect, true);
    }
  }

  /** Resize the hover, selection, and status text. Style-only, safe to call on any change. */
  setPopupTextScale(percent: number): void {
    for (const host of [this.tipHost, this.popHost, this.status]) {
      applyPopupTextScale(host, percent);
    }
    if (!this.tipHost.hidden && this.lastTipRect) {
      this.place(this.tipHost, this.lastTipRect, false);
    }
    if (!this.popHost.hidden && this.lastPopRect) {
      this.place(this.popHost, this.lastPopRect, true);
    }
  }

  showBar(state: { text: string; original: string; always: string; alwaysEnabled: boolean }): void {
    this.barText.textContent = state.text;
    this.barOriginal.textContent = state.original;
    this.barAlways.textContent = state.always;
    this.barAlways.disabled = !state.alwaysEnabled;
    this.bar.hidden = false;
    this.bar.style.display = 'block';
    this.reservePage(true);
  }

  hideBar(): void {
    this.bar.hidden = true;
    this.bar.style.display = 'none';
    this.reservePage(false);
  }

  showOriginal(
    anchor: Element,
    original: string,
    engine: EngineKind | null,
    point?: { x: number; y: number },
  ): void {
    this.tipBody.textContent = original;
    this.tipNote.textContent = engine === 'chrome' ? this.labels.chromeNote : this.labels.machine;
    const rect = point ? new DOMRect(point.x, point.y, 0, 0) : anchor.getBoundingClientRect();
    this.place(this.tipHost, rect, false);
  }

  showStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = false;
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.status.hidden = true;
      this.statusTimer = null;
    }, 2600);
  }

  /** Shows the in-page grant hint; the button opens the popup or a grant window. */
  showFolderEnable(onEnable?: () => void): void {
    this.onFolderEnable = onEnable;
    this.folderEnableHost.hidden = false;
    this.folderEnableHost.style.display = 'block';
    this.hideBar();
  }

  hideFolderEnable(): void {
    this.onFolderEnable = undefined;
    this.folderEnableHost.hidden = true;
    this.folderEnableHost.style.display = 'none';
  }

  folderEnableVisible(): boolean {
    return !this.folderEnableHost.hidden;
  }

  hideOriginal(): void {
    this.tipHost.hidden = true;
    this.tipHost.style.display = 'none';
  }

  showSelection(
    anchor: DOMRect,
    text: string,
    engine: EngineKind | null,
    pending: boolean,
    lang?: string,
    failed = false,
  ): void {
    // `hidden` also accepts the "until-found" keyword, so compare rather than rely on
    // the value already being a plain boolean.
    const opening = this.popHost.hidden === true;
    const body = this.popBody;
    const previous = body.textContent ?? '';
    const wasPending = previous === this.labels.selectionPending;
    // Read the scroll state before the text moves: the pin has to know where the reader
    // was while the old text was still laid out.
    const before = {
      scrollTop: body.scrollTop,
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
    };
    const extendsPrevious = selectionTextExtends(previous, pending ? '' : text);
    this.popHost.setAttribute('aria-busy', pending ? 'true' : 'false');
    if (pending) {
      body.textContent = this.labels.selectionPending;
      body.scrollTop = 0;
    } else {
      setPlainTextContent(body, text);
      // Re-read after the new text is in place, so the offset clamps against the new end.
      body.scrollTop = nextSelectionScrollOffset({
        opening,
        wasPending,
        extendsPrevious,
        before,
        after: {
          scrollTop: body.scrollTop,
          scrollHeight: body.scrollHeight,
          clientHeight: body.clientHeight,
        },
      });
    }
    this.updateCopyState(text, pending, failed);
    this.popBody.lang = lang ?? '';
    this.popNote.textContent = pending
      ? ''
      : engine === 'chrome'
        ? this.labels.chromeNote
        : this.labels.machine;
    this.place(this.popHost, anchor, true);
    if (!opening) return;
    const active = this.doc.activeElement;
    this.returnFocus = active instanceof HTMLElement ? active : null;
    this.popButton.focus();
  }

  hideSelection(): void {
    if (this.popHost.hidden && this.popHost.style.display === 'none') return;
    this.selectionCopyText = '';
    this.popCopy.disabled = true;
    this.resetCopyFeedback();
    this.popHost.hidden = true;
    this.popHost.style.display = 'none';
    const back = this.returnFocus;
    this.returnFocus = null;
    back?.focus();
  }

  /**
   * Keeps the copy control in step with the popup text. A pending or failed popup offers
   * nothing to copy; a streaming popup offers the part that has already arrived, so the
   * reader does not have to wait for the whole translation to finish.
   */
  private updateCopyState(text: string, pending: boolean, failed: boolean): void {
    const copyable = !pending && !failed && text.trim().length > 0;
    const next = copyable ? text : '';
    if (next !== this.selectionCopyText) this.resetCopyFeedback();
    this.selectionCopyText = next;
    this.popCopy.disabled = !copyable;
  }

  /** Copies the exact plain text the popup shows, then reports the outcome. */
  private async copySelectionText(): Promise<void> {
    const text = this.selectionCopyText;
    if (!text) return;
    const view = this.doc.defaultView;
    const ok = await copyTextToClipboard(text, view?.navigator.clipboard ?? null, this.doc);
    this.showCopyFeedback(ok);
  }

  private showCopyFeedback(copied: boolean): void {
    const message = copied ? this.labels.selectionCopied : this.labels.selectionCopyFailed;
    this.popCopyNote.textContent = message;
    this.popCopyNote.hidden = false;
    if (copied) this.popCopy.dataset.state = 'copied';
    else delete this.popCopy.dataset.state;
    this.popCopy.setAttribute('aria-label', message);
    this.popCopy.title = message;
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => {
      this.copyTimer = null;
      this.resetCopyFeedback();
    }, 2600);
  }

  private resetCopyFeedback(): void {
    if (this.copyTimer !== null) {
      clearTimeout(this.copyTimer);
      this.copyTimer = null;
    }
    this.popCopyNote.hidden = true;
    this.popCopyNote.textContent = '';
    delete this.popCopy.dataset.state;
    this.popCopy.setAttribute('aria-label', this.labels.selectionCopy);
    this.popCopy.title = this.labels.selectionCopy;
  }

  showSelectionIcon(anchor: DOMRect): void {
    this.iconButton.setAttribute('aria-label', this.labels.selectionIcon);
    this.iconButton.title = this.labels.selectionIcon;
    this.placeIcon(anchor);
  }

  moveSelectionIcon(anchor: DOMRect): void {
    if (!this.selectionIconVisible()) return;
    this.placeIcon(anchor);
  }

  hideSelectionIcon(): void {
    this.iconHost.hidden = true;
    this.iconHost.style.display = 'none';
  }

  selectionIconVisible(): boolean {
    return !this.iconHost.hidden && this.iconHost.style.display !== 'none';
  }

  moveSelection(anchor: DOMRect): void {
    if (this.popHost.hidden) return;
    this.place(this.popHost, anchor, true);
  }

  contains(node: Node): boolean {
    return (
      this.tipHost.contains(node) ||
      this.popHost.contains(node) ||
      this.iconHost.contains(node) ||
      this.bar === node ||
      this.bar.contains(node) ||
      uiShadow(this.tipHost)?.contains(node) === true ||
      uiShadow(this.popHost)?.contains(node) === true ||
      uiShadow(this.iconHost)?.contains(node) === true ||
      uiShadow(this.bar)?.contains(node) === true
    );
  }

  destroy(): void {
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    if (this.resizing) this.stopResize(this.resizing.pointerId, this.resizing.capture);
    this.style.remove();
    this.tipHost.remove();
    this.popHost.remove();
    this.iconHost.remove();
    this.status.remove();
    this.reservePage(false);
    this.bar.remove();
  }

  private mountSelectionIcon(host: HTMLElement): HTMLButtonElement {
    const shadow = attachUiShadow(host);
    const style = this.doc.createElement('style');
    style.textContent = ICON_STYLE;
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-label', this.labels.selectionIcon);
    button.title = this.labels.selectionIcon;
    appendSelectionIcon(this.doc, button);
    const keepSelection = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    button.addEventListener('pointerdown', keepSelection);
    button.addEventListener('mousedown', keepSelection);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onSelectionIcon?.();
    });
    shadow.append(style, button);
    return button;
  }

  private placeIcon(anchor: DOMRect): void {
    const view = this.doc.defaultView;
    const box = selectionIconBox(anchor, {
      width: view?.innerWidth ?? 800,
      height: view?.innerHeight ?? 600,
    });
    this.iconHost.hidden = false;
    this.iconHost.style.display = 'block';
    this.iconHost.style.left = `${String(Math.round(box.left))}px`;
    this.iconHost.style.top = `${String(Math.round(box.top))}px`;
  }

  private mountBubble(
    host: HTMLElement,
    selectable: boolean,
  ): {
    body: HTMLElement;
    note: HTMLElement;
    kicker: HTMLElement;
    card: HTMLElement;
    button: HTMLButtonElement;
    resizeLeft: HTMLButtonElement | null;
    resizeRight: HTMLButtonElement | null;
    copy: HTMLButtonElement;
    copyNote: HTMLElement;
  } {
    const shadow = attachUiShadow(host);
    const style = this.doc.createElement('style');
    style.textContent = BUBBLE_STYLE;
    const card = this.doc.createElement('div');
    card.className = 'card';
    // Marks the selection popup's card, so the shared bubble style can cap the translated
    // text there without touching the hover tooltip, which keeps its whole-card scrolling.
    if (selectable) card.classList.add('selection');
    card.setAttribute('role', selectable ? 'dialog' : 'tooltip');
    if (selectable) card.setAttribute('aria-label', this.labels.selectionTitle);

    const kicker = this.doc.createElement('p');
    kicker.className = 'kicker';
    kicker.textContent = selectable ? this.labels.selectionTitle : this.labels.original;

    const body = this.doc.createElement('p');
    body.className = 'body';
    if (selectable) body.setAttribute('aria-live', 'polite');
    const note = this.doc.createElement('p');
    note.className = 'note';
    card.append(kicker, body, note);

    const copy = this.doc.createElement('button');
    copy.type = 'button';
    copy.className = 'copy';
    copy.setAttribute('aria-label', this.labels.selectionCopy);
    copy.title = this.labels.selectionCopy;
    copy.disabled = true;
    appendCopyIcons(this.doc, copy);
    copy.hidden = !selectable;
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.copySelectionText();
    });

    const copyNote = this.doc.createElement('p');
    copyNote.className = 'note copy-note';
    copyNote.setAttribute('role', 'status');
    copyNote.setAttribute('aria-live', 'polite');
    copyNote.hidden = true;
    // Both controls live in one stretched row, so the icon-only box keeps the labeled
    // box's height instead of only the height of its own glyph.
    const controls = this.doc.createElement('div');
    controls.className = 'controls';
    controls.append(copy);
    if (selectable) card.append(copyNote, controls);

    const button = this.doc.createElement('button');
    button.type = 'button';
    button.textContent = this.labels.close;
    button.hidden = !selectable;
    let resizeLeft: HTMLButtonElement | null = null;
    let resizeRight: HTMLButtonElement | null = null;
    if (selectable) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.onClose) this.onClose();
        else this.hideSelection();
      });
      controls.append(button);
      const makeHandle = (edge: 'left' | 'right'): HTMLButtonElement => {
        const handle = this.doc.createElement('button');
        handle.type = 'button';
        handle.className = `resize-handle ${edge}`;
        handle.hidden = edge === 'left';
        handle.tabIndex = edge === 'left' ? -1 : 0;
        handle.setAttribute('aria-label', this.labels.selectionResize);
        handle.title = this.labels.selectionResize;
        handle.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight');
        handle.addEventListener('pointerdown', (event) => {
          this.startResize(event, edge);
        });
        handle.addEventListener('pointermove', this.onResizeMove);
        handle.addEventListener('pointerup', this.onResizeEnd);
        handle.addEventListener('pointercancel', this.onResizeEnd);
        handle.addEventListener('keydown', (event) => {
          this.handleResizeKey(event, edge);
        });
        handle.addEventListener('dblclick', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.resetPopupWidth();
        });
        return handle;
      };
      resizeLeft = makeHandle('left');
      resizeRight = makeHandle('right');
      card.append(resizeLeft, resizeRight);
    }

    shadow.append(style, card);
    return { body, note, kicker, card, button, resizeLeft, resizeRight, copy, copyNote };
  }

  private place(host: HTMLElement, rect: DOMRect, interactive: boolean): void {
    if (host === this.popHost) this.lastPopRect = rect;
    else if (host === this.tipHost) this.lastTipRect = rect;
    const view = this.doc.defaultView;
    const width = view?.innerWidth ?? 800;
    const height = view?.innerHeight ?? 600;
    host.style.pointerEvents = interactive ? 'auto' : 'none';
    host.style.display = 'block';
    host.hidden = false;
    const card = uiShadow(host)?.querySelector('.card');
    const cardWidth = card instanceof HTMLElement ? card.offsetWidth : 280;
    const cardHeight = card instanceof HTMLElement ? card.offsetHeight : 120;
    let left = rect.left;
    if (left + cardWidth > width - 8) left = width - cardWidth - 8;
    let top = rect.bottom + 16;
    if (top + cardHeight > height - 8) top = Math.max(8, rect.top - cardHeight - 16);
    // The flip still anchors to the selection's last line, and that line can sit below
    // the fold — a phone viewport wraps a long paragraph so the last line lands far
    // down. Pull the card up until its bottom sits on the viewport's bottom margin; a
    // card taller than the viewport stays pinned at the top margin by the clamp below,
    // and an unlaid-out card (height 0) keeps the flip's position instead of being
    // shoved to the bottom edge.
    if (cardHeight > 0 && top + cardHeight > height - 8) top = height - cardHeight - 8;
    host.style.left = `${Math.max(8, left)}px`;
    host.style.top = `${Math.max(8, top)}px`;
    if (host === this.popHost && this.popResizeLeft) {
      // The left handle is only useful when the card sits toward the right edge and can
      // grow leftward. Elsewhere it would sit on top of the first characters for no gain.
      const rightAnchored = rect.right > width * 0.5 || left < rect.left;
      this.popResizeLeft.hidden = !rightAnchored;
      this.popResizeLeft.tabIndex = rightAnchored ? 0 : -1;
    }
  }

  private applyPopupWidth(widthEm: number): number {
    const width = normalizeTranslationPopupWidth(widthEm);
    this.popupWidth = width;
    if (width === 0) {
      this.popCard.style.removeProperty('width');
      this.popCard.style.removeProperty('max-width');
      delete this.popCard.dataset.resized;
    } else {
      this.popCard.style.width = `${String(width)}em`;
      // A chosen width may exceed the default 30em reading measure, but never the viewport.
      this.popCard.style.maxWidth = 'calc(100vw - 16px)';
      this.popCard.dataset.resized = '1';
    }
    return width;
  }

  private resetPopupWidth(): void {
    this.applyPopupWidth(0);
    if (!this.popHost.hidden && this.lastPopRect) {
      this.place(this.popHost, this.lastPopRect, true);
    }
    this.onPopupWidth(0);
  }

  private startResize(event: PointerEvent, edge: 'left' | 'right'): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const card = this.popCard;
    const rect = card.getBoundingClientRect();
    const view = this.doc.defaultView;
    const fontSize =
      Number.parseFloat(view?.getComputedStyle(card).fontSize ?? '') ||
      Number.parseFloat(card.style.fontSize) ||
      12;
    const capture = event.currentTarget instanceof Element ? event.currentTarget : null;
    if (capture instanceof HTMLElement) capture.focus({ preventScroll: true });
    this.resizing = {
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: card.offsetWidth || rect.width || TRANSLATION_POPUP_WIDTH_MIN_EM * fontSize,
      fontSize,
      capture,
      changed: false,
    };
    this.popHost.dataset.resizing = '1';
    try {
      capture?.setPointerCapture(event.pointerId);
    } catch {
      // happy-dom and some hosts have no capture; the document listeners still resize.
    }
    this.doc.addEventListener('pointermove', this.onResizeMove, true);
    this.doc.addEventListener('pointerup', this.onResizeEnd, true);
    this.doc.addEventListener('pointercancel', this.onResizeEnd, true);
  }

  private stopResize(pointerId: number, capture: Element | null): void {
    this.resizing = null;
    delete this.popHost.dataset.resizing;
    try {
      if (capture?.hasPointerCapture(pointerId)) capture.releasePointerCapture(pointerId);
    } catch {
      // The pointer may already be gone, which is also a valid end.
    }
    this.doc.removeEventListener('pointermove', this.onResizeMove, true);
    this.doc.removeEventListener('pointerup', this.onResizeEnd, true);
    this.doc.removeEventListener('pointercancel', this.onResizeEnd, true);
  }

  private handleResizeKey(event: KeyboardEvent, edge: 'left' | 'right'): void {
    const step = event.shiftKey ? 2 : 1;
    const direction =
      event.key === 'ArrowRight'
        ? edge === 'right'
          ? 1
          : -1
        : event.key === 'ArrowLeft'
          ? edge === 'right'
            ? -1
            : 1
          : 0;
    if (direction === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const card = this.popCard;
    const view = this.doc.defaultView;
    const fontSize =
      Number.parseFloat(view?.getComputedStyle(card).fontSize ?? '') ||
      Number.parseFloat(card.style.fontSize) ||
      12;
    const current =
      this.popupWidth > 0
        ? this.popupWidth
        : Math.max(
            TRANSLATION_POPUP_WIDTH_MIN_EM,
            (card.offsetWidth || card.getBoundingClientRect().width || 0) / fontSize,
          );
    const maximum = Math.max(
      TRANSLATION_POPUP_WIDTH_MIN_EM,
      ((view?.innerWidth ?? 800) - 16) / fontSize,
    );
    const next = Math.min(
      maximum,
      Math.max(TRANSLATION_POPUP_WIDTH_MIN_EM, current + direction * step),
    );
    if (Math.abs(next - current) < 0.01) return;
    this.applyPopupWidth(next);
    if (!this.popHost.hidden && this.lastPopRect) {
      this.place(this.popHost, this.lastPopRect, true);
    }
    this.onPopupWidth(this.popupWidth);
  }
}

export const PAGE_STYLE_ELEMENT_ID = 'sakutto-style';

/**
 * Rules that decide whether translated text keeps the page's contrast. Exported so a
 * test can assert them without a browser, since the fade was purely a stylesheet bug.
 */
export const TRANSLATION_STYLE_RULES = {
  /** The bilingual line inherits the host color instead of mixing in transparency. */
  line: new RegExp(String.raw`${LINE_TAG}\s*\{[^}]*color:\s*inherit`, 'iu'),
  /** The pending marker paints nothing at all, so it cannot dim or un-dim a host block. */
  pending: /\[data-sakutto-pending="1"\]\s*\{[^}]*\}/iu,
  /** Any rule that lowers opacity, which is what used to fade translated text. */
  fadedOpacity: /opacity:\s*(?:0?\.\d+|0)\s*;/giu,
  /** Any rule that raises opacity, which would un-hide a block the host meant to hide. */
  forcedOpacity: /opacity:\s*1\s*;?/iu,
  shimmer: /@keyframes\s+sakutto-shimmer/iu,
  colorMix: /color-mix\(/iu,
} as const;

/** The part of the page stylesheet that paints translated text, without the status chip. */
function translationRules(css: string): string {
  const rules = css.split('sakutto-status')[0] ?? '';
  // Comments explain the history here, and they name the selectors and properties they
  // warn about, so they must not be scanned as if they were declarations.
  return rules.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * True when the injected page stylesheet leaves translated text at full contrast.
 * The status chip may dim its own chrome; the page's translated text may not.
 */
export function translationStyleKeepsContrast(css: string): boolean {
  const rules = translationRules(css);
  if (TRANSLATION_STYLE_RULES.shimmer.test(rules)) return false;
  if (TRANSLATION_STYLE_RULES.colorMix.test(rules)) return false;
  if (TRANSLATION_STYLE_RULES.pending.test(rules)) return false;
  if (TRANSLATION_STYLE_RULES.forcedOpacity.test(rules)) return false;
  TRANSLATION_STYLE_RULES.fadedOpacity.lastIndex = 0;
  return !TRANSLATION_STYLE_RULES.fadedOpacity.test(rules);
}

export function translationPageStyle(): string {
  return PAGE_STYLE;
}

const BAR_HEIGHT_PX = 40;

function readPadding(root: HTMLElement): number {
  const value = root.ownerDocument.defaultView?.getComputedStyle(root).paddingTop ?? '';
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function paddingWithBar(currentPx: number): string {
  if (currentPx <= 0) return `${String(BAR_HEIGHT_PX)}px`;
  return `calc(${String(currentPx)}px + ${String(BAR_HEIGHT_PX)}px)`;
}
