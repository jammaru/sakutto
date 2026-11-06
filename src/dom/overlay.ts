import type { EngineKind } from '@/engine/types';

export interface OverlayLabels {
  original: string;
  simple: string;
  simpleDetail: string;
  machine: string;
  selectionPending: string;
  selectionFailed: string;
  selectionTitle: string;
  selectionIcon: string;
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
sakutto-line {
  display: block;
  margin: 0.2em 0 0.35em;
  color: inherit;
  font: inherit;
  line-height: 1.55;
}
sakutto-note {
  color: inherit;
  font: inherit;
  font-size: 0.72em;
  font-weight: 600;
  letter-spacing: 0.03em;
}
sakutto-note[data-mode="replace"] {
  display: inline;
  margin-inline-start: 0.35em;
  vertical-align: super;
}
sakutto-note[data-mode="bilingual"] {
  display: inline-block;
  margin-inline-start: 0.45em;
  padding: 0 0.4em;
  border: 1px solid currentColor;
  border-radius: 999px;
}
/*
 * [data-sakutto-pending="1"] has no rule on purpose. It used to fade the whole block to
 * 58% and shimmer down to 32%, so every block that PLaMo had not finished — and, because
 * the attribute could outlive a draft-held or retried block, some that it had — read as
 * pale gray instead of Japanese. Progress is already shown by the status bar and by text
 * that fills in. It must not paint opacity 1 either: that would override a host that dims
 * its own text (disabled rows, carousel slides at opacity 0) and make content the page
 * meant to hide appear as soon as a block starts streaming.
 */
sakutto-status {
  position: fixed;
  z-index: 2147483646;
  left: 16px;
  bottom: 16px;
  max-width: min(360px, calc(100vw - 32px));
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid #d5dde6;
  background: #ffffff;
  color: #18202d;
  font: 12px/1.45 "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  box-shadow: 0 8px 24px rgb(15 23 32 / 16%);
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
:host { all: initial; }
.card {
  box-sizing: border-box;
  max-width: min(360px, 70vw);
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid #d5dde6;
  background: #ffffff;
  color: #18202d;
  font: 12px/1.45 "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  box-shadow: 0 8px 24px rgb(15 23 32 / 16%);
}
.kicker {
  margin: 0 0 4px;
  color: #5b6675;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.body {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.note {
  margin: 6px 0 0;
  color: #5b6675;
  font-size: 10px;
}
button {
  margin-top: 8px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: #0e7490;
  color: #ffffff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
button:focus-visible { outline: 2px solid #0e7490; outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  .card {
    border-color: #2d3947;
    background: #151b23;
    color: #edf1f6;
    box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
  }
  .kicker, .note { color: #b7c2cf; }
  button { background: #67e8f9; color: #062a33; }
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
  private readonly status: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly barText: HTMLElement;
  private readonly barOriginal: HTMLButtonElement;
  private readonly barAlways: HTMLButtonElement;
  private labels: OverlayLabels;
  private returnFocus: HTMLElement | null = null;
  private onClose: (() => void) | null = null;
  private onSelectionIcon: (() => void) | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.status = doc.createElement('sakutto-status');
    this.status.setAttribute('translate', 'no');
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;
    doc.documentElement.append(this.status);

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
    const shadow = this.bar.attachShadow({ mode: 'open' });
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

  setLabels(labels: OverlayLabels): void {
    this.labels = labels;
    this.tipKicker.textContent = labels.original;
    this.popKicker.textContent = labels.selectionTitle;
    this.popCard.setAttribute('aria-label', labels.selectionTitle);
    this.popButton.textContent = labels.close;
    this.iconButton.setAttribute('aria-label', labels.selectionIcon);
    this.iconButton.title = labels.selectionIcon;
    this.bar.setAttribute('aria-label', labels.barLabel);
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
    this.tipNote.textContent = engine === 'chrome' ? this.labels.simpleDetail : this.labels.machine;
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
  ): void {
    const opening = this.popHost.hidden;
    this.popBody.textContent = pending ? this.labels.selectionPending : text;
    this.popBody.lang = lang ?? '';
    this.popNote.textContent = pending
      ? ''
      : engine === 'chrome'
        ? this.labels.simpleDetail
        : this.labels.machine;
    this.place(this.popHost, anchor, true);
    if (!opening) return;
    const active = this.doc.activeElement;
    this.returnFocus = active instanceof HTMLElement ? active : null;
    this.popButton.focus();
  }

  hideSelection(): void {
    if (this.popHost.hidden && this.popHost.style.display === 'none') return;
    this.popHost.hidden = true;
    this.popHost.style.display = 'none';
    const back = this.returnFocus;
    this.returnFocus = null;
    back?.focus();
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
      this.tipHost.shadowRoot?.contains(node) === true ||
      this.popHost.shadowRoot?.contains(node) === true ||
      this.iconHost.shadowRoot?.contains(node) === true ||
      this.bar.shadowRoot?.contains(node) === true
    );
  }

  destroy(): void {
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.style.remove();
    this.tipHost.remove();
    this.popHost.remove();
    this.iconHost.remove();
    this.status.remove();
    this.reservePage(false);
    this.bar.remove();
  }

  private mountSelectionIcon(host: HTMLElement): HTMLButtonElement {
    const shadow = host.attachShadow({ mode: 'open' });
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
  } {
    const shadow = host.attachShadow({ mode: 'open' });
    const style = this.doc.createElement('style');
    style.textContent = BUBBLE_STYLE;
    const card = this.doc.createElement('div');
    card.className = 'card';
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

    const button = this.doc.createElement('button');
    button.type = 'button';
    button.textContent = this.labels.close;
    button.hidden = !selectable;
    if (selectable) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.onClose) this.onClose();
        else this.hideSelection();
      });
      card.append(button);
    }

    shadow.append(style, card);
    return { body, note, kicker, card, button };
  }

  private place(host: HTMLElement, rect: DOMRect, interactive: boolean): void {
    const view = this.doc.defaultView;
    const width = view?.innerWidth ?? 800;
    const height = view?.innerHeight ?? 600;
    host.style.pointerEvents = interactive ? 'auto' : 'none';
    host.style.display = 'block';
    host.hidden = false;
    const card = host.shadowRoot?.querySelector('.card');
    const cardWidth = card instanceof HTMLElement ? card.offsetWidth : 280;
    const cardHeight = card instanceof HTMLElement ? card.offsetHeight : 120;
    let left = rect.left;
    if (left + cardWidth > width - 8) left = width - cardWidth - 8;
    let top = rect.bottom + 16;
    if (top + cardHeight > height - 8) top = Math.max(8, rect.top - cardHeight - 16);
    host.style.left = `${Math.max(8, left)}px`;
    host.style.top = `${Math.max(8, top)}px`;
  }
}

export const PAGE_STYLE_ELEMENT_ID = 'sakutto-style';

/**
 * Rules that decide whether translated text keeps the page's contrast. Exported so a
 * test can assert them without a browser, since the fade was purely a stylesheet bug.
 */
export const TRANSLATION_STYLE_RULES = {
  /** The bilingual line inherits the host color instead of mixing in transparency. */
  line: /sakutto-line\s*\{[^}]*color:\s*inherit/iu,
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
