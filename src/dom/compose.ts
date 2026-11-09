import type { GlossaryEntry, TranslateOptions } from '@/engine/types';
import {
  canonicalLanguage,
  displayLanguage,
  isTargetLanguage,
  SUPPORTED_LANGUAGES,
  type TargetLanguage,
} from '@/shared/languages';
import { COMPOSE_PREVIEW_MS, planComposeTranslation } from '@/shared/compose-translation';
import { displayShortcut, matchesShortcut } from '@/shared/shortcuts';
import type { Formality } from '@/shared/settings';
import {
  isTranslateShortcut,
  MAX_TYPED_CHARS,
  normalizeTypedInput,
  type TypedReadiness,
} from '@/shared/typed-translation';
import { collectDocuments, focusedEditableField } from './blocks';
import {
  composeFieldRect,
  focusedComposeField,
  isComposeCandidate,
  isComposeMenuTarget,
  isSensitiveField,
  readComposeText,
  replaceComposeText,
  showsComposeIcon,
  snapshotComposeField,
  snapshotMatchesField,
  textsMatch,
  undoComposeReplace,
  type ComposeReplaceMethod,
  type ComposeSnapshot,
} from './compose-field';
import type { PageEngine } from './session';
import { uiShadow } from './overlay';

export interface ComposeLabels {
  title: string;
  icon: string;
  replace: string;
  undo: string;
  close: string;
  pending: string;
  failed: string;
  empty: string;
  tooLong: string;
  swap: string;
  replaced: string;
  stale: string;
  setup: string;
  loading: string;
  ineligible: string;
  openSetup: string;
  target: string;
  autoSource: string;
  replaceHint: (composeKey: string, enterKey: string) => string;
  langPair: (source: string, target: string) => string;
  into: (language: string) => string;
  chromeOnly: (language: string) => string;
}

export interface ComposePreferences {
  targetLanguage: string;
  form: Formality;
  glossary?: readonly GlossaryEntry[];
  enabled: boolean;
  uiLanguage: string;
  showIcon: boolean;
  readiness: TypedReadiness;
  /** True when the reader picked a compose target; skips the Japanese-draft auto-flip. */
  explicitTarget: boolean;
  /** One shortcut press translates and replaces, without waiting for the preview button. */
  instantReplace: boolean;
  /** Shown on the Replace button, e.g. `Alt+T`. Empty when the command is off. */
  replaceShortcut: string;
}

const ICON_PX = 26;
/** Chrome's command and the page keydown can both arrive for one keypress. */
const COMPOSE_SHORTCUT_DEDUP_MS = 200;

const uiShadows = new WeakMap<Element, ShadowRoot>();

function attachClosedShadow(host: HTMLElement): ShadowRoot {
  const existing = uiShadows.get(host);
  if (existing) return existing;
  const shadow = host.attachShadow({ mode: 'closed' });
  uiShadows.set(host, shadow);
  return shadow;
}

const ICON_STYLE = `
:host { all: initial; }
button {
  box-sizing: border-box;
  display: grid;
  place-items: center;
  width: ${String(ICON_PX)}px;
  height: ${String(ICON_PX)}px;
  padding: 0;
  border: 1px solid rgb(255 255 255 / 88%);
  border-radius: 7px;
  background: #101828;
  color: #f8fafc;
  box-shadow: 0 2px 8px rgb(15 23 32 / 28%);
  font: 700 10px/1 "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  cursor: pointer;
  user-select: none;
}
button:hover,
button:focus-visible { border-color: #67e8f9; }
button:focus-visible { outline: 2px solid #0e7490; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  button { transition: none; }
}
`;

const PANEL_STYLE = `
:host { all: initial; }
.card {
  box-sizing: border-box;
  padding: 8px 10px 8px 12px;
  border-radius: 12px;
  border: 1px solid #d5dde6;
  background: #ffffff;
  color: #18202d;
  font: 13px/1.45 "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  box-shadow: 0 10px 28px rgb(15 23 32 / 14%);
}
.card.dark {
  border-color: rgb(255 255 255 / 10%);
  background: #1e1f22;
  color: #f2f3f5;
  box-shadow: 0 10px 28px rgb(0 0 0 / 45%);
}
.body {
  position: relative;
  margin: 0 0 6px;
  max-height: 6.5em;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.45;
}
.body:empty, .card.undo .body:empty { display: none; }
.card.undo .body { display: none; }
.body.pending {
  min-height: 1.15em;
  color: transparent;
  background: linear-gradient(90deg, rgb(14 116 144 / 6%), rgb(14 116 144 / 22%), rgb(14 116 144 / 6%));
  background-size: 200% 100%;
  border-radius: 6px;
  animation: shimmer 1.15s linear infinite;
}
.card.dark .body.pending {
  background: linear-gradient(90deg, rgb(103 232 249 / 4%), rgb(103 232 249 / 18%), rgb(103 232 249 / 4%));
  background-size: 200% 100%;
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.chip {
  position: relative;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid #d5dde6;
  background: #f4f7fa;
  color: #0e7490;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.card.dark .chip {
  border-color: rgb(255 255 255 / 12%);
  background: #2b2d31;
  color: #67e8f9;
}
.chip::after {
  content: "▾";
  margin-left: 4px;
  font-size: 9px;
  opacity: 0.75;
}
.chip select {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  font-size: 16px;
}
.hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #5b6675;
  font-size: 11px;
}
.card.dark .hint { color: #b5bac1; }
.status {
  flex: 1 1 auto;
  min-width: 0;
  color: #5b6675;
  font-size: 11px;
}
.card.dark .status { color: #b5bac1; }
.card:not(.undo) .status { display: none; }
.card.undo .hint, .card.undo .chip, .card.undo button.replace { display: none; }
button {
  flex: 0 0 auto;
  padding: 4px 9px;
  border: 0;
  border-radius: 8px;
  background: #0e7490;
  color: #ffffff;
  font: 600 12px/1.2 "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  cursor: pointer;
}
.card.dark button.replace, .card.dark button.undo {
  background: #67e8f9;
  color: #062a33;
}
button.undo {
  background: #e8eef4;
  color: #18202d;
}
.card:not(.undo) button.undo { display: none; }
button.close {
  padding: 0;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: transparent;
  color: #5b6675;
  font-size: 16px;
  line-height: 1;
}
.card.dark button.close { color: #b5bac1; }
button:disabled { opacity: 0.45; cursor: default; }
button:focus-visible { outline: 2px solid #0e7490; outline-offset: 2px; }
.card.dark button:focus-visible { outline-color: #67e8f9; }
button.setup { display: none; }
button.setup.visible { display: inline-flex; }
@keyframes shimmer {
  from { background-position: 100% 0; }
  to { background-position: -100% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .body.pending { animation: none; background: rgb(14 116 144 / 12%); }
  .card.dark .body.pending { background: rgb(103 232 249 / 12%); }
}
`;

interface PanelState {
  preview: string;
  note: string;
  pending: boolean;
  lang: string;
  source: string | null;
  canReplace: boolean;
  canUndo: boolean;
  needsSetup: boolean;
  loading: boolean;
  dark: boolean;
}

/** Place the あA button so it does not sit on top of typed text in a short field. */
export function composeIconPosition(
  anchor: DOMRect,
  viewport: { width: number; height: number },
  iconPx = ICON_PX,
): { left: number; top: number } {
  const short = anchor.height < iconPx + 16;
  let left: number;
  let top: number;
  if (short) {
    left = anchor.right + 6;
    top = anchor.top + (anchor.height - iconPx) / 2;
    if (left + iconPx > viewport.width - 8) left = anchor.left - iconPx - 6;
    if (left < 8) {
      left = Math.min(Math.max(anchor.right - iconPx, 8), viewport.width - iconPx - 8);
      top = anchor.top - iconPx - 4;
    }
  } else {
    left = anchor.right - iconPx - 6;
    top = anchor.bottom - iconPx - 6;
  }
  left = Math.min(Math.max(left, 8), viewport.width - iconPx - 8);
  top = Math.min(Math.max(top, 8), viewport.height - iconPx - 8);
  return { left, top };
}

/** Short tag for the language chip, e.g. `JA` or `ZH`. */
export function composeLangTag(code: string | null | undefined): string {
  if (!code) return '';
  const canonical = canonicalLanguage(code) ?? code.toLowerCase();
  if (canonical === 'zh-hans') return 'ZH';
  if (canonical === 'zh-hant') return 'ZH-T';
  const base = canonical.split('-')[0] ?? canonical;
  return base.slice(0, 3).toUpperCase();
}

function parseCssColor(color: string): { r: number; g: number; b: number; a: number } | null {
  const trimmed = color.trim().toLowerCase();
  if (!trimmed || trimmed === 'transparent') return null;
  const rgb = trimmed.match(
    /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/u,
  );
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }
  const hex = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/u);
  if (!hex) return null;
  const raw = hex[1] ?? '';
  const full = raw.length === 3 ? `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}` : raw;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
    a: 1,
  };
}

function relativeLuminance(channel: { r: number; g: number; b: number }): number {
  const toLinear = (value: number): number => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(channel.r) + 0.7152 * toLinear(channel.g) + 0.0722 * toLinear(channel.b);
}

/**
 * Whether the compose bar should use a dark surface. Walks from the field up until a
 * background with real alpha is found; otherwise follows `prefers-color-scheme`.
 */
export function composeSurfaceIsDark(start: Element): boolean {
  let node: Element | null = start;
  while (node) {
    const view = node.ownerDocument.defaultView;
    const computed = view?.getComputedStyle(node).backgroundColor ?? '';
    const inline = node instanceof HTMLElement ? node.style.backgroundColor : '';
    const parsed =
      parseCssColor(computed) ??
      (computed === 'rgba(0, 0, 0, 0)' || computed === 'transparent' || computed.length === 0
        ? parseCssColor(inline)
        : null);
    if (parsed && parsed.a >= 0.4) return relativeLuminance(parsed) < 0.45;
    node = node.parentElement;
  }
  try {
    return (
      start.ownerDocument.defaultView?.matchMedia('(prefers-color-scheme: dark)').matches === true
    );
  } catch {
    return false;
  }
}

export function composePanelWidth(anchor: DOMRect, viewportWidth: number): number {
  return Math.round(Math.min(Math.max(anchor.width, 240), Math.max(240, viewportWidth - 16)));
}

/** Sit on the field's top edge; flip below when there is no room above. */
export function composePanelPosition(
  anchor: DOMRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 6,
): { left: number; top: number; placement: 'above' | 'below' } {
  let left = anchor.left;
  if (left + size.width > viewport.width - 8) left = viewport.width - size.width - 8;
  if (left < 8) left = 8;
  const above = anchor.top - size.height - gap;
  const below = anchor.bottom + gap;
  if (above >= 8) return { left, top: above, placement: 'above' };
  if (below + size.height <= viewport.height - 8) {
    return { left, top: below, placement: 'below' };
  }
  if (anchor.top >= viewport.height - anchor.bottom) {
    return { left, top: Math.max(8, above), placement: 'above' };
  }
  return {
    left,
    top: Math.min(below, Math.max(8, viewport.height - size.height - 8)),
    placement: 'below',
  };
}

class ComposeOverlay {
  private readonly iconHost: HTMLElement;
  private readonly panelHost: HTMLElement;
  private readonly iconButton: HTMLButtonElement;
  private readonly card: HTMLElement;
  private readonly chipFace: HTMLElement;
  private readonly targetSelect: HTMLSelectElement;
  private readonly body: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly status: HTMLElement;
  private readonly replaceButton: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly setupButton: HTMLButtonElement;
  private labels: ComposeLabels;
  private onIcon: () => void = () => undefined;
  private onReplace: () => void = () => undefined;
  private onUndo: () => void = () => undefined;
  private onClose: () => void = () => undefined;
  private onSetup: () => void = () => undefined;
  private onTarget: (language: TargetLanguage) => void = () => undefined;
  private replaceShortcut = '';
  private uiLanguage = 'en';

  constructor(
    private readonly doc: Document,
    labels: ComposeLabels,
  ) {
    this.labels = labels;
    this.iconHost = doc.createElement('sakutto-write');
    this.panelHost = doc.createElement('sakutto-compose');
    for (const host of [this.iconHost, this.panelHost]) {
      host.setAttribute('translate', 'no');
      host.style.position = 'fixed';
      host.style.zIndex = '2147483646';
      host.hidden = true;
      host.style.display = 'none';
      doc.documentElement.append(host);
    }
    this.iconHost.style.width = `${String(ICON_PX)}px`;
    this.iconHost.style.height = `${String(ICON_PX)}px`;
    this.iconButton = this.mountIcon();
    const panel = this.mountPanel();
    this.card = panel.card;
    this.chipFace = panel.chipFace;
    this.targetSelect = panel.target;
    this.body = panel.body;
    this.hint = panel.hint;
    this.status = panel.status;
    this.replaceButton = panel.replace;
    this.undoButton = panel.undo;
    this.closeButton = panel.close;
    this.setupButton = panel.setup;
    // Page scripts must not be able to fire Replace. The event exists only in the
    // fake-engine/test build, where e2e cannot pierce the closed shadow root.
    if (__SAKUTTO_FAKE_ENGINE__) {
      this.panelHost.addEventListener('sakutto-compose-action', (event) => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        if (detail === 'replace') this.onReplace();
        if (detail === 'undo') this.onUndo();
      });
    }
    this.fillLanguages();
  }

  setLabels(labels: ComposeLabels): void {
    this.labels = labels;
    this.iconButton.setAttribute('aria-label', labels.icon);
    this.iconButton.title = labels.icon;
    this.paintReplaceButton();
    this.paintHint();
    this.targetSelect.setAttribute('aria-label', labels.target);
    this.fillLanguages();
    this.undoButton.textContent = labels.undo;
    this.closeButton.setAttribute('aria-label', labels.close);
    this.closeButton.title = labels.close;
    this.setupButton.textContent = labels.openSetup;
    this.card.setAttribute('aria-label', labels.title);
  }

  setHandlers(handlers: {
    onIcon: () => void;
    onReplace: () => void;
    onUndo: () => void;
    onClose: () => void;
    onSetup: () => void;
    onTarget: (language: TargetLanguage) => void;
  }): void {
    this.onIcon = handlers.onIcon;
    this.onReplace = handlers.onReplace;
    this.onUndo = handlers.onUndo;
    this.onClose = handlers.onClose;
    this.onSetup = handlers.onSetup;
    this.onTarget = handlers.onTarget;
  }

  setReplaceShortcut(shortcut: string): void {
    this.replaceShortcut = shortcut;
    this.paintReplaceButton();
    this.paintHint();
  }

  setUiLanguage(language: string): void {
    if (this.uiLanguage === language) return;
    this.uiLanguage = language;
    this.fillLanguages();
  }

  showIcon(anchor: DOMRect): void {
    this.iconButton.setAttribute('aria-label', this.labels.icon);
    this.iconButton.title = this.labels.icon;
    const view = this.doc.defaultView;
    const { left, top } = composeIconPosition(anchor, {
      width: view?.innerWidth ?? 800,
      height: view?.innerHeight ?? 600,
    });
    this.iconHost.hidden = false;
    this.iconHost.style.display = 'block';
    this.iconHost.style.left = `${String(Math.round(left))}px`;
    this.iconHost.style.top = `${String(Math.round(top))}px`;
  }

  hideIcon(): void {
    this.iconHost.hidden = true;
    this.iconHost.style.display = 'none';
  }

  iconVisible(): boolean {
    return !this.iconHost.hidden && this.iconHost.style.display !== 'none';
  }

  showPanel(anchor: DOMRect, state: PanelState): void {
    const undoOnly = state.canUndo && !state.pending && !state.needsSetup && !state.loading;
    this.card.classList.toggle('dark', state.dark);
    this.card.classList.toggle('undo', undoOnly);
    this.panelHost.dataset.theme = state.dark ? 'dark' : 'light';
    this.panelHost.dataset.mode = undoOnly ? 'undo' : 'preview';
    this.body.classList.toggle('pending', state.pending);
    this.body.setAttribute('aria-busy', state.pending ? 'true' : 'false');
    if (state.pending) {
      this.body.textContent = '';
      const hidden = this.doc.createElement('span');
      hidden.className = 'sr';
      hidden.textContent = this.labels.pending;
      this.body.append(hidden);
    } else if (state.loading) {
      this.body.textContent = this.labels.loading;
    } else if (state.needsSetup) {
      this.body.textContent = this.labels.setup;
    } else {
      this.body.textContent = state.preview;
    }
    this.body.lang = state.lang;
    this.status.textContent = state.note;
    this.replaceButton.disabled = !state.canReplace;
    this.undoButton.disabled = !state.canUndo;
    this.setupButton.classList.toggle('visible', state.needsSetup);
    const source = composeLangTag(state.source) || this.labels.autoSource;
    const target = composeLangTag(state.lang) || state.lang.toUpperCase();
    this.chipFace.textContent = this.labels.langPair(source, target);
    if ([...this.targetSelect.options].some((option) => option.value === state.lang)) {
      this.targetSelect.value = state.lang;
    }
    this.paintHint();
    this.placePanel(anchor);
  }

  hidePanel(): void {
    this.panelHost.hidden = true;
    this.panelHost.style.display = 'none';
  }

  panelVisible(): boolean {
    return !this.panelHost.hidden && this.panelHost.style.display !== 'none';
  }

  contains(node: Node): boolean {
    return (
      this.iconHost.contains(node) ||
      this.panelHost.contains(node) ||
      uiShadows.get(this.iconHost)?.contains(node) === true ||
      uiShadows.get(this.panelHost)?.contains(node) === true
    );
  }

  destroy(): void {
    this.iconHost.remove();
    this.panelHost.remove();
  }

  private mountIcon(): HTMLButtonElement {
    const shadow = attachClosedShadow(this.iconHost);
    const style = this.doc.createElement('style');
    style.textContent = ICON_STYLE;
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-label', this.labels.icon);
    button.title = this.labels.icon;
    button.textContent = 'あA';
    const keepFocus = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    button.addEventListener('pointerdown', keepFocus);
    button.addEventListener('mousedown', keepFocus);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onIcon();
    });
    shadow.append(style, button);
    return button;
  }

  private paintReplaceButton(): void {
    this.replaceButton.textContent = this.labels.replace;
  }

  private paintHint(): void {
    const compose = this.replaceShortcut;
    const enter = displayShortcut('Ctrl+Enter');
    this.hint.textContent = compose.length > 0 ? this.labels.replaceHint(compose, enter) : enter;
  }

  private fillLanguages(): void {
    const current = this.targetSelect.value;
    this.targetSelect.replaceChildren();
    for (const language of SUPPORTED_LANGUAGES) {
      const option = this.doc.createElement('option');
      option.value = language;
      option.textContent = displayLanguage(language, this.uiLanguage);
      this.targetSelect.append(option);
    }
    if ([...this.targetSelect.options].some((option) => option.value === current)) {
      this.targetSelect.value = current;
    }
  }

  private mountPanel(): {
    card: HTMLElement;
    chipFace: HTMLElement;
    target: HTMLSelectElement;
    body: HTMLElement;
    hint: HTMLElement;
    status: HTMLElement;
    replace: HTMLButtonElement;
    undo: HTMLButtonElement;
    close: HTMLButtonElement;
    setup: HTMLButtonElement;
  } {
    const shadow = attachClosedShadow(this.panelHost);
    const style = this.doc.createElement('style');
    style.textContent = PANEL_STYLE;
    const card = this.doc.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', this.labels.title);
    const keep = (event: Event): void => {
      event.stopPropagation();
    };
    const keepFocus = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    card.addEventListener('pointerdown', keep);
    card.addEventListener('mousedown', keep);

    const body = this.doc.createElement('p');
    body.className = 'body';
    body.setAttribute('aria-live', 'polite');

    const toolbar = this.doc.createElement('div');
    toolbar.className = 'toolbar';
    const chip = this.doc.createElement('label');
    chip.className = 'chip';
    const chipFace = this.doc.createElement('span');
    chipFace.setAttribute('aria-hidden', 'true');
    const target = this.doc.createElement('select');
    target.className = 'target';
    target.setAttribute('aria-label', this.labels.target);
    target.addEventListener('mousedown', keep);
    target.addEventListener('pointerdown', keep);
    target.addEventListener('change', () => {
      const value = target.value;
      if (isTargetLanguage(value)) this.onTarget(value);
    });
    chip.append(chipFace, target);

    const hint = this.doc.createElement('span');
    hint.className = 'hint';
    const status = this.doc.createElement('span');
    status.className = 'status';

    const replace = this.doc.createElement('button');
    replace.type = 'button';
    replace.className = 'replace';
    replace.textContent = this.labels.replace;
    replace.addEventListener('pointerdown', keepFocus);
    replace.addEventListener('mousedown', keepFocus);
    replace.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (replace.disabled) return;
      this.onReplace();
    });
    const undo = this.doc.createElement('button');
    undo.type = 'button';
    undo.className = 'undo';
    undo.textContent = this.labels.undo;
    undo.disabled = true;
    undo.addEventListener('pointerdown', keepFocus);
    undo.addEventListener('mousedown', keepFocus);
    undo.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (undo.disabled) return;
      this.onUndo();
    });
    const close = this.doc.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.textContent = '×';
    close.setAttribute('aria-label', this.labels.close);
    close.title = this.labels.close;
    close.addEventListener('pointerdown', keepFocus);
    close.addEventListener('mousedown', keepFocus);
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onClose();
    });
    const setup = this.doc.createElement('button');
    setup.type = 'button';
    setup.className = 'setup';
    setup.textContent = this.labels.openSetup;
    setup.addEventListener('pointerdown', keepFocus);
    setup.addEventListener('mousedown', keepFocus);
    setup.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onSetup();
    });
    toolbar.append(chip, hint, status, replace, undo, setup, close);
    card.append(body, toolbar);
    shadow.append(style, card);
    return { card, chipFace, target, body, hint, status, replace, undo, close, setup };
  }

  private placePanel(anchor: DOMRect): void {
    const view = this.doc.defaultView;
    const viewport = { width: view?.innerWidth ?? 800, height: view?.innerHeight ?? 600 };
    const width = composePanelWidth(anchor, viewport.width);
    this.card.style.width = `${String(width)}px`;
    this.panelHost.style.pointerEvents = 'auto';
    this.panelHost.style.display = 'block';
    this.panelHost.hidden = false;
    const height = this.card.offsetHeight || 72;
    this.panelHost.style.width = `${String(width)}px`;
    this.panelHost.style.height = `${String(height)}px`;
    const { left, top, placement } = composePanelPosition(anchor, { width, height }, viewport);
    this.panelHost.dataset.placement = placement;
    this.panelHost.style.left = `${String(Math.round(left))}px`;
    this.panelHost.style.top = `${String(Math.round(top))}px`;
  }
}

export interface ComposeControllerOptions {
  engine: PageEngine;
  labels: ComposeLabels;
  preferences: ComposePreferences;
  composeKey?: (event: KeyboardEvent) => boolean;
  previewMs?: number;
  onWarm?: () => void;
  onSetup?: () => void;
  onTarget?: (language: TargetLanguage) => void;
}

/**
 * Translates the focused message box on request. A live preview is shown after the
 * reader opens the panel; the field is rewritten only when Replace is chosen, the
 * compose shortcut is pressed again, or Ctrl+Enter (⌘+Enter on a Mac) is pressed.
 */
export class ComposeController {
  private readonly engine: PageEngine;
  private readonly overlay: ComposeOverlay;
  private readonly composeKey: (event: KeyboardEvent) => boolean;
  private readonly previewMs: number;
  private readonly onWarm: (() => void) | undefined;
  private readonly onSetup: (() => void) | undefined;
  private readonly onTarget: ((language: TargetLanguage) => void) | undefined;
  private readonly boundDocs = new Set<Document>();
  private prefs: ComposePreferences;
  private labels: ComposeLabels;
  private field: Element | null = null;
  private lastField: Element | null = null;
  private panelOpen = false;
  private swapped = false;
  private preview = '';
  private pending = false;
  private failed = false;
  private stale = false;
  private snapshot: ComposeSnapshot | null = null;
  private replaceMethod: ComposeReplaceMethod | null = null;
  private applied: string | null = null;
  private ineligible = false;
  private lastAnchor: DOMRect | null = null;
  private replacing = false;
  private lastShortcutAt = 0;
  private replaceWhenReady = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private request: AbortController | null = null;
  private generation = 0;
  private scrollFrame = 0;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onFocusIn: (event: Event) => void;
  private readonly onFocusOut: (event: Event) => void;
  private readonly onInput: (event: Event) => void;
  private readonly onKeyDown: (event: Event) => void;
  private readonly onContextMenu: (event: Event) => void;
  private readonly onCompositionEnd: (event: Event) => void;
  private readonly onScroll: () => void;

  constructor(
    private readonly doc: Document,
    options: ComposeControllerOptions,
  ) {
    this.engine = options.engine;
    this.labels = options.labels;
    this.prefs = options.preferences;
    this.previewMs = options.previewMs ?? COMPOSE_PREVIEW_MS;
    this.composeKey = options.composeKey ?? ((event) => matchesShortcut(event, 'Alt+T'));
    this.onWarm = options.onWarm;
    this.onSetup = options.onSetup;
    this.onTarget = options.onTarget;
    this.overlay = new ComposeOverlay(doc, options.labels);
    this.overlay.setReplaceShortcut(this.prefs.replaceShortcut);
    this.overlay.setUiLanguage(this.prefs.uiLanguage);
    this.overlay.setHandlers({
      onIcon: () => this.openFromIcon(),
      onReplace: () => {
        void this.apply();
      },
      onUndo: () => {
        void this.undo();
      },
      onClose: () => this.dismiss(),
      onSetup: () => this.onSetup?.(),
      onTarget: (language) => this.pickTarget(language),
    });
    this.onFocusIn = (event) => this.handleFocus(event);
    this.onFocusOut = (event) => this.handleBlur(event);
    this.onInput = (event) => this.handleInput(event);
    this.onKeyDown = (event) => this.handleKey(event);
    this.onContextMenu = (event) => this.handleContextMenu(event);
    this.onCompositionEnd = (event) => this.handleCompositionEnd(event);
    this.onScroll = () => this.scheduleReposition();
    this.bindDocuments();
    this.doc.defaultView?.addEventListener('scroll', this.onScroll, true);
    this.doc.defaultView?.addEventListener('resize', this.onScroll);
  }

  setLabels(labels: ComposeLabels): void {
    this.labels = labels;
    this.overlay.setLabels(labels);
    if (this.panelOpen) this.render();
  }

  setPreferences(prefs: ComposePreferences): void {
    const languageChanged =
      prefs.targetLanguage !== this.prefs.targetLanguage ||
      prefs.explicitTarget !== this.prefs.explicitTarget;
    const becameReady = this.prefs.readiness !== 'ready' && prefs.readiness === 'ready';
    this.prefs = prefs;
    this.overlay.setReplaceShortcut(prefs.replaceShortcut);
    this.overlay.setUiLanguage(prefs.uiLanguage);
    if (!prefs.enabled) {
      this.dismiss();
      this.overlay.hideIcon();
      this.field = null;
      return;
    }
    this.syncIcon();
    if (this.panelOpen && !this.ineligible && (languageChanged || becameReady)) {
      this.translateField(this.resolveField());
    } else if (this.panelOpen) this.render();
  }

  /** Chrome command, context menu, or the in-page key. Never sends the message. */
  handleShortcut(): void {
    if (this.replacing) return;
    const now = Date.now();
    if (now - this.lastShortcutAt < COMPOSE_SHORTCUT_DEDUP_MS) return;
    this.lastShortcutAt = now;
    if (!this.prefs.enabled) return;
    const field = this.resolveField();
    if (!field) {
      this.showIneligible();
      return;
    }
    this.ineligible = false;
    this.field = field;
    this.lastField = field;
    if (this.panelOpen) {
      this.requestReplace();
      return;
    }
    this.openPanel(field);
    if (this.prefs.instantReplace) this.replaceWhenReady = true;
    this.translateField(field);
  }

  contains(node: Node): boolean {
    return this.overlay.contains(node);
  }

  destroy(): void {
    this.abort();
    this.clearDebounce();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.scrollFrame !== 0) this.doc.defaultView?.cancelAnimationFrame(this.scrollFrame);
    this.overlay.destroy();
    for (const doc of this.boundDocs) {
      doc.removeEventListener('focusin', this.onFocusIn, true);
      doc.removeEventListener('focusout', this.onFocusOut, true);
      doc.removeEventListener('input', this.onInput, true);
      doc.removeEventListener('keydown', this.onKeyDown, true);
      doc.removeEventListener('contextmenu', this.onContextMenu, true);
      doc.removeEventListener('compositionend', this.onCompositionEnd, true);
    }
    this.boundDocs.clear();
    this.doc.defaultView?.removeEventListener('scroll', this.onScroll, true);
    this.doc.defaultView?.removeEventListener('resize', this.onScroll);
  }

  private bindDocuments(): void {
    for (const doc of collectDocuments(this.doc)) {
      if (this.boundDocs.has(doc)) continue;
      doc.addEventListener('focusin', this.onFocusIn, true);
      doc.addEventListener('focusout', this.onFocusOut, true);
      doc.addEventListener('input', this.onInput, true);
      doc.addEventListener('keydown', this.onKeyDown, true);
      doc.addEventListener('contextmenu', this.onContextMenu, true);
      doc.addEventListener('compositionend', this.onCompositionEnd, true);
      this.boundDocs.add(doc);
    }
  }

  private resolveField(): Element | null {
    const focused = focusedComposeField(this.doc);
    if (focused) return focused;
    const active = focusedEditableField(this.doc.activeElement) ?? this.doc.activeElement;
    if (active instanceof Element && isSensitiveField(active)) return null;
    if (this.field && this.field.isConnected && isComposeCandidate(this.field)) return this.field;
    if (this.lastField && this.lastField.isConnected && isComposeCandidate(this.lastField)) {
      return this.lastField;
    }
    return null;
  }

  private focusedField(): Element | null {
    return focusedComposeField(this.doc);
  }

  private syncIcon(): void {
    const focused = this.focusedField();
    if (this.prefs.enabled && this.prefs.showIcon && focused && showsComposeIcon(focused)) {
      const rect = composeFieldRect(focused, this.doc);
      if (rect) {
        this.overlay.showIcon(rect);
        return;
      }
    }
    this.overlay.hideIcon();
  }

  private handleFocus(event: Event): void {
    this.bindDocuments();
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.overlay.contains(target)) return;
    const field = this.focusedField();
    if (!this.prefs.enabled || !field) {
      this.syncIcon();
      return;
    }
    if (this.field !== field) {
      this.applied = null;
      this.snapshot = null;
      this.replaceMethod = null;
      this.preview = '';
      this.swapped = false;
      this.stale = false;
    }
    this.field = field;
    this.lastField = field;
    this.syncIcon();
    if (this.panelOpen) {
      this.watchFieldSize(field);
      this.reposition();
    }
  }

  private handleBlur(event: Event): void {
    const next = event instanceof FocusEvent ? event.relatedTarget : null;
    if (next instanceof Node && this.overlay.contains(next)) return;
    window.setTimeout(() => {
      this.syncIcon();
    }, 50);
  }

  private handleInput(event: Event): void {
    if (this.replacing) return;
    if (isComposingEvent(event)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (this.overlay.contains(target)) return;
    const field = this.resolveField();
    if (!field || (field !== target && !field.contains(target))) return;
    const current = readComposeText(field);
    if (this.applied !== null && textsMatch(current, this.applied)) return;
    this.applied = null;
    this.snapshot = null;
    this.replaceMethod = null;
    if (!this.panelOpen) return;
    if (normalizeTypedInput(current).length === 0) {
      this.dismiss();
      return;
    }
    this.stale = true;
    this.render();
    this.schedulePreview(field);
  }

  private handleCompositionEnd(event: Event): void {
    if (this.replacing || !this.panelOpen) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (this.overlay.contains(target)) return;
    const field = this.resolveField();
    if (!field || (field !== target && !field.contains(target))) return;
    this.stale = true;
    this.render();
    this.schedulePreview(field);
  }

  private handleKey(event: Event): void {
    if (!(event instanceof KeyboardEvent) || event.repeat) return;
    if (event.key === 'Escape') {
      if (event.isComposing || !this.panelOpen) return;
      if (!this.escapeClosesFrom(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.dismiss();
      return;
    }
    if (event.isComposing) return;
    if (this.panelOpen && isTranslateShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (!this.replacing) this.requestReplace();
      return;
    }
    if (!this.composeKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (this.replacing) return;
    this.handleShortcut();
  }

  private handleContextMenu(event: Event): void {
    if (event instanceof MouseEvent) {
      this.lastAnchor = new DOMRect(event.clientX, event.clientY, 1, 1);
    }
    if (isComposeMenuTarget(event.target)) {
      const field = this.focusedField();
      if (field) this.lastField = field;
      return;
    }
    this.lastField = null;
  }

  private openFromIcon(): void {
    this.onWarm?.();
    const field = this.resolveField();
    if (!field) return;
    this.openPanel(field);
    this.translateField(field);
  }

  private openPanel(field: Element): void {
    this.panelOpen = true;
    this.swapped = false;
    this.failed = false;
    this.stale = false;
    this.preview = '';
    this.applied = null;
    this.snapshot = null;
    this.replaceMethod = null;
    this.ineligible = false;
    this.field = field;
    this.lastField = field;
    this.watchFieldSize(field);
    this.render();
  }

  private watchFieldSize(field: Element): void {
    const view = this.doc.defaultView;
    if (!view || typeof view.ResizeObserver !== 'function') return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new view.ResizeObserver(() => this.scheduleReposition());
    this.resizeObserver.observe(field);
  }

  private dismiss(): void {
    this.abort();
    this.clearDebounce();
    this.panelOpen = false;
    this.preview = '';
    this.pending = false;
    this.failed = false;
    this.stale = false;
    this.swapped = false;
    this.ineligible = false;
    this.replaceWhenReady = false;
    this.overlay.hidePanel();
    this.syncIcon();
  }

  private showIneligible(): void {
    this.panelOpen = true;
    this.ineligible = true;
    this.pending = false;
    this.failed = false;
    this.stale = false;
    this.preview = '';
    this.render();
  }

  private needsSetup(): boolean {
    const readiness = this.prefs.readiness;
    return (
      readiness === 'no-consent' ||
      readiness === 'model-absent' ||
      readiness === 'model-partial' ||
      readiness === 'model-error'
    );
  }

  private isLoading(): boolean {
    return this.prefs.readiness === 'model-busy';
  }

  private canApply(): boolean {
    return (
      this.panelOpen &&
      !this.ineligible &&
      !this.pending &&
      !this.stale &&
      !this.needsSetup() &&
      !this.isLoading() &&
      this.preview.trim().length > 0 &&
      this.applied === null
    );
  }

  private flushReplaceWhenReady(): void {
    if (!this.replaceWhenReady || !this.canApply()) return;
    this.replaceWhenReady = false;
    void this.apply();
  }

  private requestReplace(): void {
    if (this.replacing) return;
    if (this.canApply()) {
      void this.apply();
      return;
    }
    if (this.pending) {
      this.replaceWhenReady = true;
      return;
    }
    if (this.applied !== null) return;
    const field = this.resolveField();
    if (field) this.translateField(field);
  }

  private async apply(): Promise<void> {
    this.replaceWhenReady = false;
    if (this.replacing) return;
    const field = this.resolveField();
    if (!field || !this.canApply()) return;
    const snapshot = snapshotComposeField(field);
    this.replacing = true;
    try {
      const result = await replaceComposeText(field, this.preview);
      const changed = !snapshotMatchesField(field, snapshot);
      if (!result.ok && !changed) {
        this.failed = true;
        this.render();
        return;
      }
      this.snapshot = snapshot;
      this.replaceMethod = result.method;
      this.applied = readComposeText(field);
      this.stale = false;
      this.render();
    } finally {
      this.replacing = false;
    }
  }

  private async undo(): Promise<void> {
    if (this.replacing) return;
    const field = this.resolveField();
    if (!field || this.snapshot === null) return;
    const snapshot = this.snapshot;
    const method = this.replaceMethod;
    // Consume the snapshot before writing so a second click cannot insert again.
    this.snapshot = null;
    this.replaceMethod = null;
    this.replacing = true;
    try {
      const result = await undoComposeReplace(field, snapshot, method);
      this.applied = null;
      if (!result.ok) {
        this.failed = true;
        this.render();
        return;
      }
      this.render();
    } finally {
      this.replacing = false;
    }
  }

  private pickTarget(language: TargetLanguage): void {
    this.swapped = false;
    this.prefs = { ...this.prefs, targetLanguage: language, explicitTarget: true };
    this.onTarget?.(language);
    const field = this.resolveField();
    if (field) this.translateField(field);
    else this.render();
  }

  private schedulePreview(field: Element): void {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.translateField(field);
    }, this.previewMs);
  }

  private clearDebounce(): void {
    if (this.debounceTimer === null) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private abort(): void {
    this.request?.abort();
    this.request = null;
  }

  private preferredTarget(): TargetLanguage {
    return isTargetLanguage(this.prefs.targetLanguage) ? this.prefs.targetLanguage : 'en';
  }

  private translateField(field: Element | null): void {
    if (!field || !this.panelOpen || !this.prefs.enabled) return;
    const raw = readComposeText(field);
    const trimmed = normalizeTypedInput(raw);
    this.failed = false;
    if (this.needsSetup() || this.isLoading()) {
      this.abort();
      this.preview = '';
      this.pending = false;
      this.stale = false;
      this.render();
      return;
    }
    if (trimmed.length === 0) {
      this.abort();
      this.preview = '';
      this.pending = false;
      this.stale = false;
      this.render();
      return;
    }
    if (trimmed.length > MAX_TYPED_CHARS) {
      this.abort();
      this.preview = '';
      this.pending = false;
      this.failed = true;
      this.stale = false;
      this.render();
      return;
    }
    const plan = planComposeTranslation(
      trimmed,
      this.preferredTarget(),
      this.swapped,
      this.prefs.explicitTarget,
    );
    if (!plan.ok) {
      this.abort();
      this.preview = '';
      this.pending = false;
      this.stale = false;
      this.render();
      return;
    }
    this.abort();
    const controller = new AbortController();
    this.request = controller;
    this.pending = true;
    this.preview = '';
    this.render();
    const token = ++this.generation;
    void this.runTranslate(trimmed, plan.targetLanguage, controller.signal, token);
  }

  private async runTranslate(
    text: string,
    target: TargetLanguage,
    signal: AbortSignal,
    token: number,
  ): Promise<void> {
    let output = '';
    try {
      const options: TranslateOptions = {
        tgt: target,
        form: this.prefs.form,
        priority: 0,
        signal,
        eager: true,
        ...(this.prefs.glossary && this.prefs.glossary.length > 0
          ? { glossary: this.prefs.glossary }
          : {}),
      };
      for await (const chunk of this.engine.translate([{ id: 'compose', text }], options)) {
        if (signal.aborted || token !== this.generation) return;
        if (chunk.textDelta !== undefined) {
          output = chunk.restart === true ? chunk.textDelta : output + chunk.textDelta;
          this.preview = output;
          this.render();
        } else if (chunk.final !== undefined) {
          output = chunk.final;
          this.preview = output;
        }
      }
      if (signal.aborted || token !== this.generation) return;
      this.pending = false;
      this.stale = false;
      if (output.trim().length === 0) this.failed = true;
      this.render();
      if (this.failed) this.replaceWhenReady = false;
      else this.flushReplaceWhenReady();
    } catch {
      if (signal.aborted || token !== this.generation) return;
      this.pending = false;
      this.failed = true;
      this.replaceWhenReady = false;
      this.render();
    }
  }

  private escapeClosesFrom(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) return false;
    if (this.overlay.contains(target)) return true;
    const field = this.resolveField() ?? this.field;
    if (!field) return false;
    return field === target || field.contains(target);
  }

  private render(): void {
    const field = this.resolveField();
    if (!this.panelOpen) {
      this.overlay.hidePanel();
      return;
    }
    if (this.ineligible || !field) {
      const dark = field ? composeSurfaceIsDark(field) : false;
      this.overlay.showPanel(this.lastAnchor ?? new DOMRect(8, 8, 0, 0), {
        preview: this.labels.ineligible,
        note: '',
        pending: false,
        lang: this.preferredTarget(),
        source: null,
        canReplace: false,
        canUndo: false,
        needsSetup: false,
        loading: false,
        dark,
      });
      return;
    }
    const raw = readComposeText(field);
    const trimmed = normalizeTypedInput(raw);
    if (trimmed.length === 0) {
      this.dismiss();
      return;
    }
    const plan = planComposeTranslation(
      trimmed,
      this.preferredTarget(),
      this.swapped,
      this.prefs.explicitTarget,
    );
    const language = displayLanguage(plan.targetLanguage, this.prefs.uiLanguage);
    let note = this.labels.into(language);
    let preview = this.preview;
    const needsSetup = this.needsSetup();
    const loading = this.isLoading();
    if (needsSetup) {
      preview = this.labels.setup;
      note = '';
    } else if (loading) {
      preview = this.labels.loading;
      note = '';
    } else if (trimmed.length > MAX_TYPED_CHARS) {
      preview = this.labels.tooLong;
      note = '';
    } else if (!plan.ok) {
      preview = this.labels.chromeOnly(language);
      note = '';
    } else if (this.failed && this.preview.trim().length === 0) {
      preview = this.labels.failed;
    } else if (this.stale) {
      note = this.labels.stale;
    } else if (this.applied !== null) {
      note = this.labels.replaced;
    }
    this.syncIcon();
    const anchor = composeFieldRect(field, this.doc) ?? this.lastAnchor ?? new DOMRect(8, 8, 0, 0);
    this.overlay.showPanel(anchor, {
      preview,
      note,
      pending: this.pending && trimmed.length > 0 && plan.ok && !needsSetup && !loading,
      lang: plan.targetLanguage,
      source: plan.sourceLanguage,
      canReplace: this.canApply(),
      canUndo: this.snapshot !== null,
      needsSetup,
      loading,
      dark: composeSurfaceIsDark(field),
    });
  }

  private scheduleReposition(): void {
    if (this.scrollFrame !== 0) return;
    const view = this.doc.defaultView;
    if (!view) {
      this.reposition();
      return;
    }
    this.scrollFrame = view.requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.reposition();
    });
  }

  private reposition(): void {
    this.syncIcon();
    if (this.panelOpen) this.render();
  }
}

function isComposingEvent(event: Event): boolean {
  return 'isComposing' in event && (event as InputEvent).isComposing === true;
}

/** Exported so a test can read the closed panel without opening the shadow from the page. */
export function composeShadow(host: Element | null | undefined): ShadowRoot | null {
  if (!host) return null;
  return uiShadows.get(host) ?? uiShadow(host);
}
