import type { GlossaryEntry, TranslateOptions } from '@/engine/types';
import {
  displayLanguage,
  isTargetLanguage,
  SUPPORTED_LANGUAGES,
  type TargetLanguage,
} from '@/shared/languages';
import {
  COMPOSE_PREVIEW_MS,
  composePairOther,
  planComposeTranslation,
} from '@/shared/compose-translation';
import { matchesShortcut } from '@/shared/shortcuts';
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
  width: min(360px, 70vw);
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid #d5dde6;
  background: #ffffff;
  color: #18202d;
  font: 12px/1.45 "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  box-shadow: 0 8px 24px rgb(15 23 32 / 16%);
}
.kicker {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 0 4px;
  color: #5b6675;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.body {
  margin: 0;
  max-height: 8.5em;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.note {
  margin: 6px 0 0;
  color: #5b6675;
  font-size: 10px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
button {
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: #0e7490;
  color: #ffffff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
button.secondary {
  background: #e8eef4;
  color: #18202d;
}
button:disabled {
  opacity: 0.55;
  cursor: default;
}
button:focus-visible { outline: 2px solid #0e7490; outline-offset: 2px; }
button.swap {
  padding: 2px 6px;
  background: transparent;
  color: #0e7490;
  font-weight: 700;
}
.target {
  max-width: 11em;
  padding: 1px 4px;
  border: 1px solid #d5dde6;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 10px;
}
kbd {
  margin-left: 0.35em;
  font: 600 10px/1 var(--font-mono, ui-monospace, monospace);
  opacity: 0.85;
}
button.setup { display: none; }
button.setup.visible { display: inline-flex; }
@media (prefers-color-scheme: dark) {
  .card {
    border-color: #2d3947;
    background: #151b23;
    color: #edf1f6;
    box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
  }
  .kicker, .note { color: #b7c2cf; }
  button { background: #67e8f9; color: #062a33; }
  button.secondary { background: #1d2631; color: #edf1f6; }
  button.swap { color: #67e8f9; background: transparent; }
  .target { border-color: #2d3947; color: #edf1f6; }
}
`;

interface PanelState {
  preview: string;
  note: string;
  pending: boolean;
  lang: string;
  canReplace: boolean;
  canUndo: boolean;
  needsSetup: boolean;
  loading: boolean;
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

class ComposeOverlay {
  private readonly iconHost: HTMLElement;
  private readonly panelHost: HTMLElement;
  private readonly iconButton: HTMLButtonElement;
  private readonly kicker: HTMLElement;
  private readonly swapButton: HTMLButtonElement;
  private readonly targetSelect: HTMLSelectElement;
  private readonly body: HTMLElement;
  private readonly note: HTMLElement;
  private readonly replaceButton: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly setupButton: HTMLButtonElement;
  private labels: ComposeLabels;
  private onIcon: () => void = () => undefined;
  private onReplace: () => void = () => undefined;
  private onUndo: () => void = () => undefined;
  private onClose: () => void = () => undefined;
  private onSwap: () => void = () => undefined;
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
    this.kicker = panel.kicker;
    this.swapButton = panel.swap;
    this.targetSelect = panel.target;
    this.body = panel.body;
    this.note = panel.note;
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
    this.kicker.textContent = labels.title;
    this.swapButton.setAttribute('aria-label', labels.swap);
    this.swapButton.title = labels.swap;
    this.paintReplaceButton();
    this.targetSelect.setAttribute('aria-label', labels.target);
    this.fillLanguages();
    this.undoButton.textContent = labels.undo;
    this.closeButton.textContent = labels.close;
    this.setupButton.textContent = labels.openSetup;
    const card = uiShadows.get(this.panelHost)?.querySelector('.card');
    if (card instanceof HTMLElement) card.setAttribute('aria-label', labels.title);
  }

  setHandlers(handlers: {
    onIcon: () => void;
    onReplace: () => void;
    onUndo: () => void;
    onClose: () => void;
    onSwap: () => void;
    onSetup: () => void;
    onTarget: (language: TargetLanguage) => void;
  }): void {
    this.onIcon = handlers.onIcon;
    this.onReplace = handlers.onReplace;
    this.onUndo = handlers.onUndo;
    this.onClose = handlers.onClose;
    this.onSwap = handlers.onSwap;
    this.onSetup = handlers.onSetup;
    this.onTarget = handlers.onTarget;
  }

  setReplaceShortcut(shortcut: string): void {
    this.replaceShortcut = shortcut;
    this.paintReplaceButton();
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
    this.body.textContent = state.pending
      ? this.labels.pending
      : state.loading
        ? this.labels.loading
        : state.needsSetup
          ? this.labels.setup
          : state.preview;
    this.body.lang = state.lang;
    this.note.textContent = state.note;
    this.replaceButton.disabled = !state.canReplace;
    this.undoButton.disabled = !state.canUndo;
    this.setupButton.classList.toggle('visible', state.needsSetup);
    this.kicker.textContent = this.labels.title;
    this.targetSelect.value = state.lang;
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
    const hint = this.replaceShortcut;
    this.replaceButton.textContent = '';
    this.replaceButton.append(this.doc.createTextNode(this.labels.replace));
    if (hint.length > 0) {
      const kbd = this.doc.createElement('kbd');
      kbd.textContent = hint;
      this.replaceButton.append(' ', kbd);
    }
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
    kicker: HTMLElement;
    swap: HTMLButtonElement;
    target: HTMLSelectElement;
    body: HTMLElement;
    note: HTMLElement;
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
    card.setAttribute('role', 'dialog');
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

    const kickerRow = this.doc.createElement('div');
    kickerRow.className = 'kicker';
    const kicker = this.doc.createElement('span');
    kicker.textContent = this.labels.title;
    const swap = this.doc.createElement('button');
    swap.type = 'button';
    swap.className = 'swap';
    swap.textContent = '↔';
    swap.setAttribute('aria-label', this.labels.swap);
    swap.title = this.labels.swap;
    swap.addEventListener('pointerdown', keepFocus);
    swap.addEventListener('mousedown', keepFocus);
    swap.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onSwap();
    });
    const target = this.doc.createElement('select');
    target.className = 'target';
    target.setAttribute('aria-label', this.labels.target);
    target.addEventListener('mousedown', keep);
    target.addEventListener('pointerdown', keep);
    target.addEventListener('change', () => {
      const value = target.value;
      if (isTargetLanguage(value)) this.onTarget(value);
    });
    kickerRow.append(kicker, target, swap);

    const body = this.doc.createElement('p');
    body.className = 'body';
    body.setAttribute('aria-live', 'polite');
    const note = this.doc.createElement('p');
    note.className = 'note';

    const actions = this.doc.createElement('div');
    actions.className = 'actions';
    const replace = this.doc.createElement('button');
    replace.type = 'button';
    replace.className = 'replace';
    replace.textContent = this.labels.replace;
    replace.addEventListener('pointerdown', keepFocus);
    replace.addEventListener('mousedown', keepFocus);
    replace.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onReplace();
    });
    const undo = this.doc.createElement('button');
    undo.type = 'button';
    undo.className = 'secondary';
    undo.textContent = this.labels.undo;
    undo.disabled = true;
    undo.addEventListener('pointerdown', keepFocus);
    undo.addEventListener('mousedown', keepFocus);
    undo.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onUndo();
    });
    const close = this.doc.createElement('button');
    close.type = 'button';
    close.className = 'secondary';
    close.textContent = this.labels.close;
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
    actions.append(replace, undo, close, setup);
    card.append(kickerRow, body, note, actions);
    shadow.append(style, card);
    return { kicker, swap, target, body, note, replace, undo, close, setup };
  }

  private placePanel(anchor: DOMRect): void {
    const view = this.doc.defaultView;
    const width = view?.innerWidth ?? 800;
    const height = view?.innerHeight ?? 600;
    this.panelHost.style.pointerEvents = 'auto';
    this.panelHost.style.display = 'block';
    this.panelHost.hidden = false;
    const card = uiShadows.get(this.panelHost)?.querySelector('.card');
    const cardWidth = card instanceof HTMLElement ? card.offsetWidth : 280;
    const cardHeight = card instanceof HTMLElement ? card.offsetHeight : 140;
    this.panelHost.style.width = `${String(cardWidth)}px`;
    this.panelHost.style.height = `${String(cardHeight)}px`;
    let left = anchor.left;
    if (left + cardWidth > width - 8) left = width - cardWidth - 8;
    let top = anchor.bottom + 8;
    if (top + cardHeight > height - 8) top = Math.max(8, anchor.top - cardHeight - 8);
    this.panelHost.style.left = `${String(Math.max(8, left))}px`;
    this.panelHost.style.top = `${String(Math.max(8, top))}px`;
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
      onSwap: () => this.swapDirection(),
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
    const now = Date.now();
    if (now - this.lastShortcutAt < 80) return;
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
    if (this.panelOpen) this.reposition();
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
      event.preventDefault();
      event.stopPropagation();
      this.dismiss();
      return;
    }
    if (event.isComposing) return;
    if (this.panelOpen && isTranslateShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      this.requestReplace();
      return;
    }
    if (!this.composeKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
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
    this.render();
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
    const field = this.resolveField();
    if (!field || this.snapshot === null) return;
    const snapshot = this.snapshot;
    this.replacing = true;
    try {
      const result = await undoComposeReplace(field, snapshot, this.replaceMethod);
      if (!result.ok) {
        this.failed = true;
        this.render();
        return;
      }
      this.applied = null;
      this.snapshot = null;
      this.replaceMethod = null;
      this.render();
    } finally {
      this.replacing = false;
    }
  }

  private swapDirection(): void {
    const field = this.resolveField();
    const trimmed = field ? normalizeTypedInput(readComposeText(field)) : '';
    const plan = planComposeTranslation(
      trimmed,
      this.preferredTarget(),
      this.swapped,
      this.prefs.explicitTarget,
    );
    this.pickTarget(composePairOther(plan.targetLanguage, this.preferredTarget()));
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

  private render(): void {
    const field = this.resolveField();
    if (!this.panelOpen) {
      this.overlay.hidePanel();
      return;
    }
    if (this.ineligible || !field) {
      this.overlay.showPanel(this.lastAnchor ?? new DOMRect(8, 8, 0, 0), {
        preview: this.labels.ineligible,
        note: '',
        pending: false,
        lang: this.preferredTarget(),
        canReplace: false,
        canUndo: false,
        needsSetup: false,
        loading: false,
      });
      return;
    }
    const raw = readComposeText(field);
    const trimmed = normalizeTypedInput(raw);
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
    } else if (trimmed.length === 0) {
      preview = this.labels.empty;
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
      canReplace: this.canApply(),
      canUndo: this.snapshot !== null,
      needsSetup,
      loading,
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
