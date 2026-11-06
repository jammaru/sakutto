import { estimateTokens } from '@/engine/text/tokens';
import { formatRate, pageRates } from './throughput';
import { joinTranslatedSentences, splitForTranslation } from '@/engine/text/sentences';
import { isPlainAltS } from '@/shared/shortcuts';
import { PriorityQueue } from '@/engine/queue/priority-queue';
import type { EngineKind, GlossaryEntry, TranslateOptions, TranslationChunk } from '@/engine/types';
import { mergeGlossary } from '@/shared/glossary';
import { chooseTargetLanguage, isTargetLanguage, type TargetLanguage } from '@/shared/languages';
import type { Formality, Settings, TranslationPace } from '@/shared/settings';
import { canonicalPageLanguage, isAlreadyTargetLanguage, languageOf } from './detect';
import { collectDocuments, collectShadowRoots, eachTranslatableBlock, isOwnUi } from './blocks';
import type { OverlayLabels } from './overlay';
import { PageOverlay, PAGE_STYLE_ELEMENT_ID } from './overlay';
import { assessTranslation, stripPlaceholderTokens } from './placeholders';
import {
  bandForRect,
  contentKind,
  lookaheadScreens,
  translationConcurrency,
  translationPriority,
  type ContentKind,
  type VisibilityBand,
} from './priority';
import {
  applyTranslation,
  paintPlain,
  removeTranslationUi,
  restoreSegment,
  showBilingual,
  showReplaceNote,
} from './render';
import {
  allSlots,
  buildSegment,
  placeholderIds,
  visibleOriginal,
  type SegmentModel,
} from './segment';
import type { SiteAuto, SiteRule } from './sites';

const SHORT_TOKEN_LIMIT = 40;
const BATCH_TOKEN_LIMIT = 200;
const PACK_TOKEN_LIMIT = 360;
const PACK_SEGMENT_TOKENS = 140;
const SLICE_SIZE = 24;
const PREVIEW_LIMIT = 2;
/** Keyboard selections settle before inference, so a partial highlight does not occupy the model. */
const SELECTION_SETTLE_MS = 48;
/** A selectionchange that follows pointerup is the same gesture and should not wait out the keyboard delay. */
const POINTER_RELEASE_WINDOW_MS = 80;

export interface PageEngine {
  translate(
    segments: readonly { id: string; text: string }[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk>;
}

export interface SessionPreferences {
  targetLanguage: string;
  targetExplicit: boolean;
  form: Formality;
  display: 'replace' | 'bilingual';
  auto: SiteAuto;
  host: string;
  context: boolean;
  tier: 'g' | 'c8' | 'c4' | null;
  pace: TranslationPace;
  glossary?: readonly GlossaryEntry[];
}

export interface PageViewState {
  active: boolean;
  display: 'replace' | 'bilingual';
  engine: EngineKind | null;
  simple: boolean;
  pending: number;
  done: number;
  total: number;
  host: string;
  auto: SiteAuto;
  targetLanguage: string;
  pageLanguage: string | null;
  targetAdjusted: boolean;
  sameLanguage: boolean;
  tokensPerSecond: number | null;
  segmentsPerSecond: number | null;
}

type LiveState = 'idle' | 'queued' | 'running' | 'done';
type LiveRole = 'page' | 'selection';

interface Live {
  id: string;
  role: LiveRole;
  model: SegmentModel | null;
  source: string;
  plain: string;
  placeholder: boolean;
  flatten: boolean;
  attempts: number;
  short: boolean;
  heading: boolean;
  kind: ContentKind;
  lang: string | null;
  index: number;
  band: VisibilityBand;
  state: LiveState;
  translation: string;
  engine: EngineKind | null;
  upgraded: boolean;
  draft: boolean;
  previewed: boolean;
  previewing: boolean;
  created: Text[];
  originalChildren: ChildNode[];
  partText: string[];
  partFinal: boolean[];
  partPlamo: boolean[];
  rect: DOMRect | null;
  batchToken: number;
}

interface InflightBatch {
  controller: AbortController;
  items: Live[];
  priority: number;
  settled: boolean;
}

export interface PageSessionOptions {
  engine: PageEngine;
  labels: OverlayLabels;
  preferences: SessionPreferences;
  scheduleFrame?: (callback: () => void) => void;
  debounceMs?: number;
  onSitePatch?: (patch: {
    display?: 'replace' | 'bilingual';
    targetLanguage?: TargetLanguage;
    auto?: SiteAuto;
  }) => void | Promise<void>;
  /** Resolves true only after this site already has host access. */
  onGrantSite?: () => boolean | Promise<boolean>;
  /** False when the user has changed the selection shortcut away from Alt+S. */
  selectionKey?: (event: KeyboardEvent) => boolean;
}

export function preferencesFor(
  settings: Settings,
  rule: SiteRule,
  host: string,
): SessionPreferences {
  const glossary = mergeGlossary(settings.glossary, rule.glossary);
  return {
    targetLanguage: rule.targetLanguage ?? settings.targetLanguage,
    targetExplicit: rule.targetLanguage !== undefined,
    form: settings.form,
    display: rule.display ?? settings.display,
    auto: rule.auto,
    host,
    context: false,
    tier: null,
    pace: settings.pace,
    ...(glossary.length > 0 ? { glossary } : {}),
  };
}

export class PageSession {
  private readonly engine: PageEngine;
  private readonly overlay: PageOverlay;
  private readonly scheduleFrame: (callback: () => void) => void;
  private readonly debounceMs: number;
  private readonly onSitePatch: PageSessionOptions['onSitePatch'];
  private readonly onGrantSite: PageSessionOptions['onGrantSite'];
  private readonly selectionKey: (event: KeyboardEvent) => boolean;
  private readonly keyWindows = new Set<Window>();
  private grantPending = false;
  private eagerOnce = true;
  private draftsLeft = 3;
  private previewing = 0;
  private previewGeneration = 0;
  private plamoSeen = false;
  private lastRateAt = 0;
  private readonly queue = new PriorityQueue<Live>();
  private readonly live = new Map<string, Live>();
  private readonly liveByBlock = new Map<Element, Live>();
  private readonly idleWaiters: Array<() => void> = [];
  private prefs: SessionPreferences;
  private labels: OverlayLabels;
  private detectedLanguage: string | null = null;
  private active = false;
  private paused = false;
  private pendingScans = 0;
  private scanChain: Promise<void> = Promise.resolve();
  private running = 0;
  private concurrency: number;
  private nextId = 0;
  private nextBatchToken = 0;
  private pageController: AbortController | null = null;
  private readonly inflightBatches = new Set<InflightBatch>();
  private selection: Live | null = null;
  /** True while the selection popover is the thing the user is looking at. */
  private selectionShown = false;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerDown = false;
  private pointerReleasedAt = 0;
  private navigating = false;
  private targetAdjusted = false;
  private observers: MutationObserver[] = [];
  private readonly visibilities = new Map<Document, IntersectionObserver>();
  private readonly pointerRoots = new Set<EventTarget>();
  private readonly frameLoads = new Map<HTMLIFrameElement, () => void>();
  private readonly expected = new WeakMap<Text, string>();
  private applying = 0;
  private plamoReady = false;
  private historyUnpatch: (() => void) | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private direction: 'down' | 'up' = 'down';
  private lastScroll = 0;
  private dirty = new Set<Live>();
  private frameQueued = false;
  private paintGeneration = 0;
  private startedAt = 0;
  private firstTextAt: number | null = null;
  private samples: { id: string; ms: number }[] = [];
  private perf: HTMLElement | null = null;
  private readonly onVisibility: () => void;
  private readonly onScroll: () => void;
  private readonly onPageHide: () => void;
  private readonly onPopState: () => void;
  private readonly onPointerOver: (event: Event) => void;
  private readonly onPointerOut: (event: Event) => void;
  private readonly onPointerDown: (event: Event) => void;
  private readonly onKeyDown: (event: Event) => void;
  private readonly onFocusIn: (event: Event) => void;
  private readonly onFocusOut: (event: Event) => void;
  private readonly onResize: () => void;
  private readonly onSelectionChange: () => void;
  private readonly onPointerUp: () => void;

  constructor(
    private readonly doc: Document,
    options: PageSessionOptions,
  ) {
    this.engine = options.engine;
    this.labels = options.labels;
    this.prefs = options.preferences;
    this.debounceMs = options.debounceMs ?? 120;
    this.onSitePatch = options.onSitePatch;
    this.onGrantSite = options.onGrantSite;
    this.selectionKey = options.selectionKey ?? isPlainAltS;
    this.concurrency = translationConcurrency(options.preferences.tier);
    this.scheduleFrame =
      options.scheduleFrame ??
      ((callback) => {
        const view = this.doc.defaultView;
        if (view) view.requestAnimationFrame(() => callback());
        else callback();
      });
    this.overlay = new PageOverlay(doc, options.labels);
    this.overlay.setOnClose(() => this.dismissSelection());
    this.overlay.setOnSelectionIcon(() => this.activateSelectionIcon());
    this.overlay.setBarActions({
      onOriginal: () => this.restore(),
      onAlways: () => {
        void this.rememberAlways();
      },
    });

    this.onVisibility = () => {
      if (this.doc.hidden) {
        this.paused = true;
        this.pointerDown = false;
        this.abortRunning(true);
        return;
      }
      this.paused = false;
      if (this.active) this.pump();
    };
    this.onScroll = () => {
      this.overlay.hideOriginal();
      this.followSelection();
      const top = this.doc.defaultView?.scrollY ?? 0;
      const next = top >= this.lastScroll ? 'down' : 'up';
      this.lastScroll = top;
      if (next === this.direction) return;
      this.direction = next;
      this.bindVisibility();
    };
    this.onPageHide = () => {
      this.stopForNavigation();
    };
    this.onPopState = () => {
      if (!this.active) return;
      this.invalidatePaints();
      this.abortRunning(true);
      this.scheduleScan();
    };
    this.onPointerOver = (event) => this.showHover(event);
    this.onPointerOut = (event) => this.hideHover(event);
    this.onPointerDown = (event) => {
      if (event instanceof MouseEvent && event.button !== 0) return;
      const target = event.target;
      if (target instanceof Node && this.overlay.contains(target)) return;
      this.pointerDown = true;
      this.clearSelectionOffer();
      this.overlay.hideOriginal();
      this.dismissSelection();
    };
    this.onPointerUp = () => {
      this.pointerDown = false;
      this.pointerReleasedAt = performance.now();
      this.scheduleSelectionOffer(0);
    };
    this.onSelectionChange = () => {
      if (this.pointerDown) return;
      if (this.applying > 0) {
        this.scheduleSelectionOffer(SELECTION_SETTLE_MS);
        return;
      }
      const justReleased = performance.now() - this.pointerReleasedAt < POINTER_RELEASE_WINDOW_MS;
      this.scheduleSelectionOffer(justReleased ? 0 : SELECTION_SETTLE_MS);
    };
    this.onKeyDown = (event) => {
      if (!(event instanceof KeyboardEvent) || event.repeat) return;
      if (event.key === 'Escape') {
        this.overlay.hideOriginal();
        if (!this.selection && !this.overlay.selectionIconVisible()) return;
        event.preventDefault();
        event.stopPropagation();
        this.dismissSelection();
        return;
      }
      if (!this.selectionKey(event)) return;
      const selected = this.readSelection();
      if (!selected) return;
      event.preventDefault();
      event.stopPropagation();
      this.translateSelection(selected.text, selected.rect);
    };
    this.onFocusIn = (event) => this.showHover(event);
    this.onFocusOut = (event) => this.hideHover(event);
    this.onResize = () => {
      this.followSelection();
      this.bindVisibility();
    };

    this.doc.addEventListener('visibilitychange', this.onVisibility);
    this.doc.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    this.doc.defaultView?.addEventListener('scroll', this.onScroll, { passive: true });
    this.doc.defaultView?.addEventListener('pagehide', this.onPageHide);
    this.doc.defaultView?.addEventListener('beforeunload', this.onPageHide);
    this.doc.defaultView?.addEventListener('popstate', this.onPopState);
    this.doc.defaultView?.addEventListener('resize', this.onResize);
    this.bindHistory();
    this.bindObservers();
    this.bindVisibility();
  }

  setDetectedLanguage(language: string | null): void {
    this.detectedLanguage = language;
  }

  setLabels(labels: OverlayLabels): void {
    this.labels = labels;
    this.overlay.setLabels(labels);
  }

  setPreferences(next: SessionPreferences): void {
    const previous = this.prefs;
    const tier = next.tier ?? previous.tier;
    this.prefs = { ...next, tier };
    this.concurrency = translationConcurrency(tier);
    if (lookaheadScreens(previous.tier) !== lookaheadScreens(tier)) this.bindVisibility();
    if (next.display !== previous.display) this.repaintAll();
    if (next.auto !== previous.auto && this.active) this.publishState();
    if (next.pace !== previous.pace) this.pumpPreviews();
    const languageChanged =
      next.targetLanguage !== previous.targetLanguage ||
      next.form !== previous.form ||
      glossaryKey(next.glossary) !== glossaryKey(previous.glossary);
    if (languageChanged && this.active) {
      this.retranslate();
      void this.requestScan().then(() => {
        if (this.active) this.pump();
      });
    }
  }

  setTier(tier: 'g' | 'c8' | 'c4' | null): void {
    this.setPreferences({ ...this.prefs, tier });
  }

  state(): PageViewState {
    const lives = [...this.live.values()];
    const pages = lives.filter((item) => item.role === 'page');
    const prose = pages.filter((item) => item.kind === 'prose');
    const tracked = prose.length > 0 ? prose : pages;
    const simple = lives.some((item) => item.engine === 'chrome');
    const hasPlamo = lives.some((item) => item.engine === 'plamo');
    let engine: EngineKind | null = null;
    if (this.active && hasPlamo) engine = 'plamo';
    else if (this.active && simple) engine = 'chrome';
    const pageLanguage = this.sourceLanguage();
    const rates = this.rates(tracked);

    return {
      active: this.active,
      display: this.prefs.display,
      engine,
      simple: this.active && simple && !hasPlamo,
      pending: tracked.filter((item) => item.state === 'queued' || item.state === 'running').length,
      done: tracked.filter((item) => item.state === 'done').length,
      total: tracked.length,
      host: this.prefs.host,
      auto: this.prefs.auto,
      targetLanguage: this.prefs.targetLanguage,
      pageLanguage,
      targetAdjusted: this.targetAdjusted,
      sameLanguage:
        this.active &&
        tracked.length === 0 &&
        pageLanguage !== null &&
        pageLanguage === canonicalPageLanguage(this.prefs.targetLanguage),
      tokensPerSecond: rates.tokensPerSecond,
      segmentsPerSecond: rates.segmentsPerSecond,
    };
  }

  async handle(command: 'toggle' | 'restore' | 'bilingual' | 'selection'): Promise<void> {
    switch (command) {
      case 'toggle':
        await this.toggle();
        return;
      case 'restore':
        this.restore();
        return;
      case 'bilingual':
        await this.toggleDisplay();
        return;
      case 'selection':
        this.translateDocumentSelection();
        return;
    }
  }

  async toggle(): Promise<void> {
    if (this.active) this.restore();
    else await this.translate();
  }

  async translate(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.navigating = false;
    this.startedAt = performance.now();
    this.firstTextAt = null;
    this.samples = [];
    this.pageController = new AbortController();
    this.eagerOnce = true;
    this.draftsLeft = 3;
    this.previewGeneration += 1;
    this.previewing = 0;
    this.plamoSeen = false;
    this.lastRateAt = 0;
    this.rememberSourceLanguage();
    this.alignTargetLanguage();
    this.doc.documentElement.lang = this.prefs.targetLanguage;
    this.publishState();
    await this.requestScan();
    this.pump();
  }

  restore(): void {
    this.active = false;
    this.targetAdjusted = false;
    const source = this.doc.documentElement.getAttribute('data-sakutto-source-lang');
    if (source !== null) {
      this.doc.documentElement.lang = source;
      this.doc.documentElement.removeAttribute('data-sakutto-source-lang');
    }
    this.invalidatePaints();
    this.previewGeneration += 1;
    this.previewing = 0;
    this.plamoSeen = false;
    this.pageController?.abort();
    this.pageController = null;
    this.abortRunning(false);
    this.queue.clear();
    for (const item of this.live.values()) this.resetLive(item);
    this.live.clear();
    this.liveByBlock.clear();
    this.selection = null;
    this.selectionShown = false;
    this.pointerDown = false;
    this.clearSelectionOffer();
    this.overlay.hideOriginal();
    this.overlay.hideSelection();
    this.overlay.hideSelectionIcon();
    this.overlay.hideBar();
    this.perf?.remove();
    this.perf = null;
    delete this.doc.documentElement.dataset.sakuttoState;
    delete this.doc.documentElement.dataset.sakuttoProgress;
    delete this.doc.documentElement.dataset.sakuttoRate;
    this.resolveIdle();
  }

  async toggleDisplay(): Promise<void> {
    this.overlay.hideOriginal();
    if (!this.active) {
      if (this.prefs.display !== 'bilingual') {
        this.prefs = { ...this.prefs, display: 'bilingual' };
        await this.onSitePatch?.({ display: 'bilingual' });
      }
      this.overlay.showStatus(this.labels.bilingualOn);
      await this.translate();
      return;
    }

    const display = this.prefs.display === 'replace' ? 'bilingual' : 'replace';
    this.prefs = { ...this.prefs, display };
    this.repaintAll();
    this.overlay.showStatus(
      display === 'bilingual' ? this.labels.bilingualOn : this.labels.replaceOn,
    );
    await this.onSitePatch?.({ display });
  }

  translateSelection(text: string, rect?: DOMRect, reveal = true): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.navigating = false;
    this.overlay.hideOriginal();
    const anchor = rect ?? new DOMRect(16, 16, 0, 0);
    const current = this.selection;
    if (
      current?.source === trimmed &&
      (current.state === 'queued' || current.state === 'running' || current.state === 'done')
    ) {
      current.rect = anchor;
      if (reveal) this.revealSelection();
      return;
    }

    this.queue.remove((item) => item.role === 'selection' && item.state !== 'running');
    const next = this.createSelection(trimmed, anchor);
    this.supersedeSelection(next);
    if (reveal) {
      this.selectionShown = true;
      this.overlay.hideSelectionIcon();
      this.overlay.showSelection(anchor, '', null, true, this.prefs.targetLanguage);
    } else if (this.selectionShown) {
      this.selectionShown = false;
      this.overlay.hideSelection();
    }
    this.enqueue(next, true);
    this.pump();
  }

  translateDocumentSelection(): void {
    const selected = this.readSelection();
    if (!selected) return;
    this.translateSelection(selected.text, selected.rect);
  }

  private readSelection(): { text: string; rect: DOMRect } | null {
    for (const doc of collectDocuments(this.doc)) {
      const selection = doc.getSelection?.() ?? doc.defaultView?.getSelection() ?? null;
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) continue;
      const text = selection.toString().trim();
      if (text.length === 0) continue;
      const endpoint = selection.anchorNode ?? selection.focusNode;
      if (endpoint && this.overlay.contains(endpoint)) continue;
      let range: Range;
      try {
        range = selection.getRangeAt(0);
      } catch {
        continue;
      }
      return { text, rect: selectionViewportRect(range, doc, this.doc) };
    }
    return null;
  }

  /**
   * Inference starts when the highlight stops moving. The icon only reveals the
   * popover, so a click does not wait to begin a request that is already running.
   */
  private scheduleSelectionOffer(delayMs: number): void {
    if (this.selectionTimer !== null) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null;
      if (!this.pointerDown) this.offerSelection();
      this.resolveIdle();
    }, delayMs);
  }

  private clearSelectionOffer(): void {
    if (this.selectionTimer === null) return;
    clearTimeout(this.selectionTimer);
    this.selectionTimer = null;
    this.resolveIdle();
  }

  private offerSelection(): void {
    if (this.navigating || this.doc.hidden || this.pointerDown) return;
    const selected = this.readSelection();
    if (!selected) {
      this.overlay.hideSelectionIcon();
      if (!this.selectionShown && this.selection) this.dismissSelection();
      return;
    }
    if (this.selectionShown && this.selection?.source === selected.text) {
      this.selection.rect = selected.rect;
      this.overlay.hideSelectionIcon();
      this.overlay.moveSelection(selected.rect);
      return;
    }
    if (this.selectionShown) this.dismissSelection();
    this.overlay.showSelectionIcon(selected.rect);
    this.translateSelection(selected.text, selected.rect, false);
  }

  private activateSelectionIcon(): void {
    const selected = this.readSelection();
    if (selected) {
      this.translateSelection(selected.text, selected.rect, true);
      return;
    }
    if (this.selection?.rect) this.revealSelection();
  }

  private revealSelection(): void {
    const item = this.selection;
    if (!item?.rect) return;
    this.selectionShown = true;
    this.overlay.hideSelectionIcon();
    const ready =
      item.state === 'done' ? item.translation : partialText(item, this.prefs.targetLanguage);
    const text = stripPlaceholderTokens(ready);
    if (item.state === 'done' && text.trim().length === 0) {
      this.overlay.showSelection(
        item.rect,
        this.labels.selectionFailed,
        null,
        false,
        this.prefs.targetLanguage,
      );
      return;
    }
    const pending = text.trim().length === 0;
    this.overlay.showSelection(
      item.rect,
      pending ? '' : text,
      pending ? null : item.engine,
      pending,
      this.prefs.targetLanguage,
    );
  }

  private followSelection(): void {
    if (!this.selectionShown && !this.overlay.selectionIconVisible()) return;
    const selected = this.readSelection();
    if (!selected) {
      this.overlay.hideSelectionIcon();
      return;
    }
    if (this.selection) this.selection.rect = selected.rect;
    if (this.overlay.selectionIconVisible()) this.overlay.moveSelectionIcon(selected.rect);
    if (this.selectionShown) this.overlay.moveSelection(selected.rect);
  }

  private supersedeSelection(next: Live): void {
    const previous = this.selection;
    this.selection = next;
    if (!previous || previous === next) return;
    this.queue.remove((item) => item === previous);
    if (previous.state !== 'running') {
      previous.state = 'idle';
      return;
    }
    for (const batch of this.inflightBatches) {
      if (!batch.items.includes(previous)) continue;
      if (batch.items.some((item) => item.role !== 'selection')) continue;
      batch.controller.abort();
      previous.state = 'idle';
    }
  }

  upgradeChromeSegments(): void {
    if (!this.active) return;
    this.plamoReady = true;
    for (const item of this.live.values()) {
      if (item.role !== 'page' || item.engine === 'plamo' || item.state === 'running') continue;
      if (item.engine === 'chrome' && item.state === 'queued') continue;
      this.enqueue(item, true);
    }
    this.pump();
    this.pumpPreviews();
  }

  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  dispose(): void {
    this.restore();
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
    for (const observer of this.visibilities.values()) observer.disconnect();
    this.visibilities.clear();
    this.unbindPointers();
    for (const [frame, onLoad] of this.frameLoads) frame.removeEventListener('load', onLoad);
    this.frameLoads.clear();
    this.historyUnpatch?.();
    this.historyUnpatch = null;
    if (this.scanTimer !== null) clearTimeout(this.scanTimer);
    this.doc.removeEventListener('visibilitychange', this.onVisibility);
    this.doc.removeEventListener('scroll', this.onScroll, { capture: true });
    this.doc.defaultView?.removeEventListener('scroll', this.onScroll);
    this.unbindKeys();
    this.doc.defaultView?.removeEventListener('pagehide', this.onPageHide);
    this.doc.defaultView?.removeEventListener('beforeunload', this.onPageHide);
    this.doc.defaultView?.removeEventListener('popstate', this.onPopState);
    this.doc.defaultView?.removeEventListener('resize', this.onResize);
    this.overlay.destroy();
  }

  private requestScan(): Promise<void> {
    this.pendingScans += 1;
    const run = this.scanChain.then(() => this.scanRoot());
    this.scanChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.pendingScans -= 1;
      this.resolveIdle();
    });
  }

  private async scanRoot(): Promise<void> {
    const roots: ParentNode[] = [];
    for (const document of collectDocuments(this.doc)) {
      roots.push(document);
      for (const shadow of collectShadowRoots(document)) roots.push(shadow);
    }

    let index = 0;
    for (const root of roots) {
      for (const block of eachTranslatableBlock(root)) {
        if (!this.active) return;
        this.addBlock(block, index);
        index += 1;
        if (index % SLICE_SIZE === 0) {
          if (this.hasVisibleProse()) this.pump();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }
    this.bindObservers();
    this.bindVisibility();
  }

  private addBlock(block: Element, index: number): void {
    if (this.liveByBlock.has(block)) return;
    if (isAlreadyTargetLanguage(block, this.prefs.targetLanguage, this.detectedLanguage)) return;

    const model = buildSegment(block);
    if (!model) return;

    const item: Live = {
      id: this.allocateId(),
      role: 'page',
      model,
      source: model.source,
      plain: visibleOriginal(block),
      placeholder: model.placeholder,
      flatten: false,
      attempts: 0,
      short: model.placeholder ? false : estimateTokens(model.source) <= SHORT_TOKEN_LIMIT,
      heading: /^H[1-6]$/u.test(block.tagName),
      kind: contentKind(block),
      lang: languageOf(block, this.detectedLanguage),
      index,
      band: bandForRect(block.getBoundingClientRect(), viewportHeight(block)),
      state: 'idle',
      translation: '',
      engine: null,
      upgraded: false,
      draft: false,
      previewed: false,
      previewing: false,
      created: [],
      originalChildren: [...block.childNodes],
      partText: [],
      partFinal: [],
      partPlamo: [],
      rect: null,
      batchToken: 0,
    };

    this.live.set(item.id, item);
    this.liveByBlock.set(block, item);
    this.observeBlock(block);
    this.enqueue(item);
  }

  private createSelection(text: string, rect: DOMRect): Live {
    return {
      id: this.allocateId(),
      role: 'selection',
      model: null,
      source: text,
      plain: text,
      placeholder: false,
      flatten: false,
      attempts: 0,
      short: true,
      heading: false,
      kind: 'prose',
      lang: this.detectedLanguage,
      index: 0,
      band: 'visible',
      state: 'queued',
      translation: '',
      engine: null,
      upgraded: false,
      draft: false,
      previewed: false,
      previewing: false,
      created: [],
      originalChildren: [],
      partText: [],
      partFinal: [],
      partPlamo: [],
      rect,
      batchToken: 0,
    };
  }

  private dismissSelection(): void {
    this.clearSelectionOffer();
    const current = this.selection;
    this.selection = null;
    this.selectionShown = false;
    this.overlay.hideSelection();
    this.overlay.hideSelectionIcon();
    if (!current) return;
    this.queue.remove((item) => item === current);
    if (current.state !== 'running') current.state = 'idle';
    this.abortBatches((priority) => priority <= 0, false);
    this.pump();
  }

  private rememberSourceLanguage(): void {
    const root = this.doc.documentElement;
    if (root.hasAttribute('data-sakutto-source-lang')) return;
    root.setAttribute('data-sakutto-source-lang', root.lang);
  }

  private sourceLanguage(): string | null {
    const root = this.doc.documentElement;
    if (root.hasAttribute('data-sakutto-source-lang')) {
      return (
        canonicalPageLanguage(root.getAttribute('data-sakutto-source-lang')) ??
        this.detectedLanguage
      );
    }
    return canonicalPageLanguage(root.lang) ?? this.detectedLanguage;
  }

  private alignTargetLanguage(): void {
    if (this.prefs.targetExplicit && isTargetLanguage(this.prefs.targetLanguage)) return;
    const page = this.sourceLanguage();
    const next = chooseTargetLanguage(page, this.prefs.targetLanguage, false);
    if (next === this.prefs.targetLanguage) return;
    this.targetAdjusted = true;
    this.prefs = { ...this.prefs, targetLanguage: next, targetExplicit: true };
    void this.onSitePatch?.({ targetLanguage: next });
  }

  private stopForNavigation(): void {
    this.navigating = true;
    this.invalidatePaints();
    this.pageController?.abort();
    this.queue.clear();
    this.selection = null;
    this.selectionShown = false;
    this.clearSelectionOffer();
    this.overlay.hideSelection();
    this.overlay.hideSelectionIcon();
    this.overlay.hideOriginal();
    this.abortBatches(() => true, false);
  }

  private allocateId(): string {
    this.nextId += 1;
    return `s${String(this.nextId)}`;
  }

  private enqueue(item: Live, force = false): void {
    if (item.state === 'running') return;
    if (item.state === 'queued') {
      if (!force) return;
      this.queue.remove((candidate) => candidate === item);
    } else if (item.state === 'done' && !force) {
      return;
    }
    item.state = 'queued';
    this.queue.enqueue(item, this.priorityOf(item));
  }

  private priorityOf(item: Live): number {
    if (item.role === 'selection') return translationPriority('selection', 0, 'prose');
    return translationPriority(item.band, item.index, item.kind);
  }

  private hasVisibleProse(): boolean {
    for (const item of this.live.values()) {
      if (item.role === 'page' && item.kind === 'prose' && item.band === 'visible') return true;
    }
    return false;
  }

  private selectionBusy(): boolean {
    const item = this.selection;
    return item !== null && (item.state === 'queued' || item.state === 'running');
  }

  private pump(): void {
    if (this.navigating) {
      this.resolveIdle();
      return;
    }
    if (!this.active && !this.selection) {
      this.resolveIdle();
      return;
    }
    if (this.paused) return;

    this.startQueuedSelection();

    while (this.running < this.concurrency && this.queue.size > 0) {
      const next = this.queue.peek();
      if (!next) break;
      if (this.selectionBusy() && next.value.role !== 'selection') break;
      const batch = this.takeBatch();
      if (batch.length === 0) break;
      const priority = Math.min(...batch.map((item) => this.priorityOf(item)));
      this.beginBatch(batch, priority);
    }

    this.pumpPreviews();
    this.publishState();
    this.resolveIdle();
  }

  /**
   * A queued selection starts even while a page batch is in flight. The engine
   * scheduler then runs it immediately after the completion that is already
   * inside the model, without cancelling that completion.
   */
  private startQueuedSelection(): void {
    const item = this.selection;
    if (!item || item.state !== 'queued') return;
    this.queue.remove((candidate) => candidate === item);
    this.beginBatch([item], 0);
  }

  private beginBatch(batch: Live[], priority: number): void {
    for (const item of batch) item.state = 'running';
    const controller = new AbortController();
    const entry: InflightBatch = { controller, items: batch, priority, settled: false };
    this.inflightBatches.add(entry);
    this.running += 1;
    void this.runBatch(batch, priority, controller).finally(() => {
      this.releaseBatch(entry);
      this.pump();
    });
  }

  private takeBatch(): Live[] {
    const first = this.queue.dequeue();
    if (!first) return [];
    first.state = 'running';
    const batch = [first];
    if (first.role === 'selection') return batch;

    const allowLong = !this.eagerOnce && !first.heading;
    const firstTokens = estimateTokens(first.source);
    const firstPackable = first.short || (allowLong && firstTokens <= PACK_SEGMENT_TOKENS);
    if (!firstPackable) return batch;

    let tokens = firstTokens;
    let placeholders = openPlaceholderCount(first.source);
    const limit = this.eagerOnce ? BATCH_TOKEN_LIMIT : PACK_TOKEN_LIMIT;
    const firstPriority = this.priorityOf(first);
    while (this.queue.size > 0 && batch.length < 8) {
      const peeked = this.queue.peek();
      if (!peeked) break;
      const next = peeked.value;
      if (next.role !== 'page' || next.lang !== first.lang) break;
      if (next.placeholder !== first.placeholder) break;
      if (peeked.priority > firstPriority + 3) break;
      const added = estimateTokens(next.source);
      const packable = next.short || (allowLong && !next.heading && added <= PACK_SEGMENT_TOKENS);
      const nextPlaceholders = openPlaceholderCount(next.source);
      if (!packable || tokens + added > limit || placeholders + nextPlaceholders > 16) break;
      this.queue.dequeue();
      next.state = 'running';
      batch.push(next);
      tokens += added;
      placeholders += nextPlaceholders;
    }

    return batch;
  }

  private async runBatch(
    batch: readonly Live[],
    priority: number,
    controller: AbortController,
  ): Promise<void> {
    const signal = this.pageController
      ? AbortSignal.any([this.pageController.signal, controller.signal])
      : controller.signal;
    const token = ++this.nextBatchToken;
    for (const item of batch) item.batchToken = token;
    const requests: { id: string; text: string }[] = [];
    const owners = new Map<string, Live>();

    for (const item of batch) {
      if (item.model?.placeholder) item.model.block.setAttribute('data-sakutto-pending', '1');
      const pieces = expandSource(item);
      const keepPreview = item.engine === 'chrome' && item.partText.some((part) => part.length > 0);
      item.partFinal = pieces.map(() => false);
      item.partPlamo = pieces.map(() => false);
      if (keepPreview) {
        item.draft = true;
        item.partText = pieces.map((_, index) => item.partText[index] ?? '');
      } else {
        item.partText = pieces.map(() => '');
        item.draft = false;
      }
      for (const piece of pieces) {
        requests.push(piece);
        owners.set(piece.id, item);
      }
    }

    try {
      for await (const chunk of this.engine.translate(
        requests,
        this.optionsFor(batch, priority, signal),
      )) {
        if (signal.aborted) return;
        const item = owners.get(chunk.id);
        if (!item || item.batchToken !== token) continue;
        const index = partIndex(chunk.id);
        const plamoUpgrade = item.draft && chunk.engine === 'plamo';
        if (item.state !== 'running' && !(plamoUpgrade && item.state === 'done')) continue;
        if (chunk.engine === 'chrome' && item.partPlamo[index]) continue;
        if (plamoUpgrade && !item.partPlamo[index]) {
          item.partPlamo[index] = true;
          if (chunk.textDelta) item.partText[index] = '';
        }
        if (chunk.engine === 'plamo' && !this.plamoSeen) {
          this.plamoSeen = true;
          this.pumpPreviews();
        }
        if (chunk.engine) item.engine = chunk.engine;
        if (chunk.textDelta) {
          item.partText[index] = (item.partText[index] ?? '') + chunk.textDelta;
          this.queuePaint(item);
        }
        if (chunk.final !== undefined) {
          item.partText[index] = chunk.final;
          item.partFinal[index] = true;
          if (item.partFinal.every(Boolean)) this.complete(item);
          else this.queuePaint(item);
        }
      }
    } catch {
      // A failed batch leaves the original text in place.
    } finally {
      for (const item of batch) {
        if (item.batchToken !== token) continue;
        if (item.state === 'running') {
          const unfinished = item.translation.trim().length === 0;
          item.state = item.translation.length > 0 ? 'done' : 'idle';
          item.model?.block.removeAttribute('data-sakutto-pending');
          if (unfinished) this.showSelectionFailure(item, signal);
        } else {
          this.showSelectionFailure(item, signal);
        }
        this.queueChromeUpgrade(item);
      }
    }
  }

  private showSelectionFailure(item: Live, signal: AbortSignal): void {
    if (signal.aborted || item.role !== 'selection' || item !== this.selection || !item.rect)
      return;
    if (!this.selectionShown || item.translation.trim().length > 0) return;
    this.overlay.showSelection(
      item.rect,
      this.labels.selectionFailed,
      null,
      false,
      this.prefs.targetLanguage,
    );
  }

  private queueChromeUpgrade(item: Live): void {
    if (item.role !== 'page' || item.state !== 'done' || item.engine !== 'chrome') return;
    if (!this.plamoReady || item.upgraded || item.partPlamo.some(Boolean)) return;
    item.upgraded = true;
    this.enqueue(item, true);
  }

  private complete(item: Live): void {
    if (item.role === 'page' && !this.active) return;
    const joined = joinTranslatedSentences(
      item.partText.map((part) => part.trim()).filter((part) => part.length > 0),
      this.prefs.targetLanguage,
    );
    const markup = this.acceptTranslation(
      item,
      joined.length > 0 ? joined : item.partText.join(''),
    );
    if (markup === 'retry') return;
    item.translation = markup;
    item.state = 'done';
    if (item.translation.trim().length > 0) this.paint(item, false);
    else item.model?.block.removeAttribute('data-sakutto-pending');
    this.noteTiming(item);
    if (
      item.role === 'page' &&
      item.engine === 'chrome' &&
      this.plamoReady &&
      !item.upgraded &&
      !item.draft
    ) {
      item.upgraded = true;
      this.enqueue(item, true);
    }
    this.publishState();
  }

  private acceptTranslation(item: Live, output: string): string | 'retry' {
    if (item.role === 'selection' || !item.model?.placeholder || item.flatten) {
      return stripPlaceholderTokens(output);
    }
    const verdict = assessTranslation(output, placeholderIds(item.model));
    if (verdict.ok) return verdict.text;
    if (item.draft && item.engine === 'chrome') return verdict.plain;
    if (item.attempts < 1) {
      item.attempts += 1;
      item.flatten = true;
      item.partText = [];
      item.partFinal = [];
      item.translation = '';
      item.state = 'idle';
      item.model.block.setAttribute('data-sakutto-pending', '1');
      this.enqueue(item, true);
      return 'retry';
    }
    return verdict.plain;
  }

  private optionsFor(
    batch: readonly Live[],
    priority: number,
    signal: AbortSignal,
  ): TranslateOptions {
    const languages = new Set(batch.map((item) => item.lang));
    const source = languages.size === 1 ? [...languages][0] : null;
    const glossary = placeholderGlossary(
      batch,
      (this.prefs.glossary ?? []).filter(
        (entry) => entry.source.trim().length > 0 && entry.target.trim().length > 0,
      ),
    );
    const context = this.contextFor(batch[0]);
    const visibleProse =
      priority < 24 &&
      batch.some((item) => item.role === 'page' && item.kind === 'prose' && !item.heading);
    const eager = this.eagerOnce && visibleProse;
    if (eager) this.eagerOnce = false;
    const draft = this.draftsLeft > 0 && visibleProse;
    if (draft) {
      this.draftsLeft -= 1;
      for (const item of batch) {
        if (item.role === 'page' && item.kind === 'prose' && !item.heading) item.draft = true;
      }
    }

    return {
      tgt: this.prefs.targetLanguage,
      form: this.prefs.form,
      priority,
      signal,
      ...(source ? { src: source } : {}),
      ...(glossary.length > 0 ? { glossary } : {}),
      ...(context ? { context } : {}),
      ...(eager ? { eager: true } : {}),
      ...(draft ? { draft: true } : {}),
    };
  }

  private async rememberAlways(): Promise<void> {
    if (this.prefs.auto === 'always' || this.grantPending) return;
    this.grantPending = true;
    try {
      const granted = await this.onGrantSite?.();
      if (granted !== true) return;
      this.prefs = { ...this.prefs, auto: 'always' };
      this.publishState();
      await this.onSitePatch?.({ auto: 'always' });
    } catch {
      // A failed save leaves the site on its previous choice.
    } finally {
      this.grantPending = false;
    }
  }

  private contextFor(item: Live | undefined): string | undefined {
    if (!this.prefs.context || !item || item.role !== 'page') return undefined;
    const title = this.doc.title.trim();
    const previous = [...this.live.values()].find(
      (candidate) => candidate.index === item.index - 1,
    );
    const parts = [title, previous?.plain ?? '']
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0) return undefined;
    return parts.join('\n').slice(0, 500);
  }

  private queuePaint(item: Live): void {
    this.dirty.add(item);
    if (this.frameQueued) return;
    this.frameQueued = true;
    const generation = this.paintGeneration;
    this.scheduleFrame(() => {
      if (generation !== this.paintGeneration) {
        this.frameQueued = false;
        return;
      }
      this.frameQueued = false;
      const items = [...this.dirty];
      this.dirty.clear();
      for (const dirty of items) {
        if (dirty.state === 'idle') continue;
        if (dirty.role !== 'selection' && !this.active) continue;
        this.paint(dirty, dirty.state !== 'done');
      }
      this.noteTiming();
      this.noteLiveRate();
    });
  }

  private paint(item: Live, partial: boolean): void {
    let text = partial ? partialText(item, this.prefs.targetLanguage) : item.translation;
    if (text.trim().length === 0) return;

    if (item.role === 'selection') {
      if (!this.selectionShown || item !== this.selection || !item.rect) return;
      this.overlay.showSelection(
        item.rect,
        stripPlaceholderTokens(text),
        item.engine,
        false,
        this.prefs.targetLanguage,
      );
      return;
    }

    const model = item.model;
    if (!model || !this.active) return;
    if (model.placeholder && !item.flatten && !partial) {
      const verdict = assessTranslation(text, placeholderIds(model));
      if (!verdict.ok) {
        if (!(item.draft && item.engine === 'chrome')) return;
        text = verdict.plain;
      } else {
        text = verdict.text;
      }
    } else {
      text = stripPlaceholderTokens(text);
    }

    const bilingual = this.prefs.display === 'bilingual' && this.keepsOriginalVisible(item);
    this.editDom(() => {
      model.block.setAttribute('data-sakutto-id', item.id);
      if (item.engine) model.block.setAttribute('data-sakutto-engine', item.engine);

      if (bilingual) {
        showBilingual(model, text, item.engine, this.labels.simple, item.created);
        const line = model.block.querySelector('sakutto-line');
        if (line instanceof HTMLElement) line.lang = this.prefs.targetLanguage;
        if (!partial || !model.placeholder) model.block.removeAttribute('data-sakutto-pending');
      } else if (partial) {
        paintPlain(model, text, item.created);
        if (item.engine === 'chrome') {
          showReplaceNote(model.block, item.engine, this.labels.simple);
          model.block.setAttribute('data-sakutto-pending', '1');
        } else if (model.placeholder) {
          model.block.setAttribute('data-sakutto-pending', '1');
        }
      } else {
        applyTranslation(model, text, item.created);
        showReplaceNote(model.block, item.engine, this.labels.simple);
        model.block.removeAttribute('data-sakutto-pending');
      }
      this.remember(model, item.created);
    });
  }

  private repaintAll(): void {
    for (const item of this.live.values()) {
      if (!item.translation) continue;
      this.paint(item, false);
    }
  }

  private retranslate(): void {
    this.invalidatePaints();
    this.abortRunning(false);
    const target = canonicalPageLanguage(this.prefs.targetLanguage);
    for (const item of [...this.live.values()]) {
      if (item.role !== 'page') continue;
      if (item.lang && target && item.lang === target) {
        this.forgetLive(item, true);
        continue;
      }
      if (item.model) this.resetLive(item);
      item.translation = '';
      item.engine = null;
      item.upgraded = false;
      item.draft = false;
      item.previewed = false;
      item.previewing = false;
      item.flatten = false;
      item.attempts = 0;
      item.partText = [];
      item.partFinal = [];
      item.state = 'idle';
      this.enqueue(item, true);
    }
    this.pump();
  }

  private resetLive(item: Live): void {
    if (!item.model) return;
    const model = item.model;
    const block = model.block;
    this.editDom(() => {
      restoreSegment(model, item.created);
      removeTranslationUi(block);
      for (const node of item.originalChildren) {
        if (node.parentNode === block) block.appendChild(node);
      }
      this.remember(model, item.created);
    });
  }

  private abortRunning(requeue: boolean): void {
    this.abortBatches(() => true, requeue);
  }

  private releaseBatch(entry: InflightBatch): void {
    if (entry.settled) return;
    entry.settled = true;
    this.inflightBatches.delete(entry);
    this.running = Math.max(0, this.running - 1);
  }

  private abortBatches(match: (priority: number) => boolean, requeue: boolean): void {
    let released = false;
    for (const batch of [...this.inflightBatches]) {
      if (!match(batch.priority)) continue;
      batch.controller.abort();
      this.releaseBatch(batch);
      released = true;
      for (const item of batch.items) {
        if (item.role === 'selection') {
          item.state = 'idle';
          if (this.selection === item) this.selection = null;
          continue;
        }
        if (item.translation.length > 0) {
          item.state = 'done';
          continue;
        }
        item.state = 'idle';
        item.partText = [];
        item.partFinal = [];
        item.model?.block.removeAttribute('data-sakutto-pending');
        if (requeue && this.active && !this.navigating) this.enqueue(item);
      }
    }
    if (released) this.pump();
  }

  private editDom(fn: () => void): void {
    this.applying += 1;
    try {
      fn();
    } finally {
      queueMicrotask(() => {
        this.applying = Math.max(0, this.applying - 1);
      });
    }
  }

  private remember(model: SegmentModel, created: readonly Text[]): void {
    for (const slot of allSlots(model)) this.expected.set(slot.node, slot.node.nodeValue ?? '');
    for (const node of created) this.expected.set(node, node.nodeValue ?? '');
  }

  private forgetLive(item: Live, restore: boolean): void {
    if (item.model) {
      if (restore) this.resetLive(item);
      else {
        removeTranslationUi(item.model.block);
        item.model.block.removeAttribute('data-sakutto-pending');
        item.model.block.removeAttribute('data-sakutto-id');
        item.model.block.removeAttribute('data-sakutto-engine');
        for (const node of item.created) node.remove();
        item.created.length = 0;
      }
      this.liveByBlock.delete(item.model.block);
    }
    this.live.delete(item.id);
    this.queue.remove((candidate) => candidate === item);
    this.dirty.delete(item);
  }

  private rates(items?: readonly Live[]): {
    tokensPerSecond: number | null;
    segmentsPerSecond: number | null;
  } {
    const tracked = items ?? [...this.live.values()].filter((item) => item.role === 'page');
    const output = tracked
      .map((item) => (item.translation.length > 0 ? item.translation : item.partText.join('')))
      .join('\n');
    const done = tracked.filter((item) => item.state === 'done').length;
    return pageRates({
      active: this.active,
      elapsedMs: this.startedAt === 0 ? 0 : performance.now() - this.startedAt,
      done,
      output,
    });
  }

  private barText(view: PageViewState): string {
    const base =
      view.pending > 0 ? this.labels.barProgress(view.done, view.total) : this.labels.barDone;
    if (view.tokensPerSecond === null || view.segmentsPerSecond === null) return base;
    return `${base} · ${this.labels.barRate(formatRate(view.tokensPerSecond), formatRate(view.segmentsPerSecond))}`;
  }

  private noteLiveRate(): void {
    const now = performance.now();
    if (now - this.lastRateAt < 500) return;
    this.lastRateAt = now;
    this.publishState();
  }

  private pumpPreviews(): void {
    if (
      this.prefs.pace !== 'fast' ||
      !this.plamoReady ||
      !this.plamoSeen ||
      !this.active ||
      this.navigating
    ) {
      return;
    }
    const generation = this.previewGeneration;
    while (this.previewing < PREVIEW_LIMIT) {
      const item = [...this.live.values()].find(
        (candidate) =>
          candidate.role === 'page' &&
          candidate.band !== 'visible' &&
          candidate.state === 'queued' &&
          !candidate.previewed &&
          !candidate.previewing &&
          candidate.engine === null &&
          hasBox(candidate),
      );
      if (!item) return;
      item.previewing = true;
      this.previewing += 1;
      void this.runPreview(item, generation).finally(() => {
        if (generation !== this.previewGeneration) return;
        item.previewing = false;
        item.previewed = true;
        this.previewing = Math.max(0, this.previewing - 1);
        this.pumpPreviews();
        this.resolveIdle();
      });
    }
  }

  private async runPreview(item: Live, generation: number): Promise<void> {
    const signal = this.pageController?.signal;
    if (!signal || signal.aborted) return;
    const pieces = expandSource(item);
    try {
      for await (const chunk of this.engine.translate(pieces, {
        tgt: this.prefs.targetLanguage,
        form: this.prefs.form,
        priority: this.priorityOf(item),
        signal,
        preview: true,
        ...(item.lang ? { src: item.lang } : {}),
      })) {
        if (generation !== this.previewGeneration || signal.aborted) return;
        if (item.state === 'running' || item.engine === 'plamo') return;
        if (chunk.final === undefined) continue;
        const index = partIndex(chunk.id);
        if (item.partText.length !== pieces.length) item.partText = pieces.map(() => '');
        item.partText[index] = chunk.final;
        item.engine = 'chrome';
        item.draft = true;
        this.paint(item, true);
      }
    } catch {
      // A missing built-in translator leaves the block for PLaMo.
    }
  }

  private noteTiming(item?: Live): void {
    if (
      this.firstTextAt === null &&
      (item?.translation || item?.partText.some((part) => part.length > 0))
    ) {
      this.firstTextAt = performance.now();
    }
    if (!item?.translation) return;
    this.samples.push({
      id: item.id,
      ms: Math.round(performance.now() - this.startedAt),
    });
    if (!this.perf) {
      this.perf = this.doc.createElement('sakutto-perf');
      this.perf.hidden = true;
      this.perf.setAttribute('translate', 'no');
      this.doc.documentElement.append(this.perf);
    }
    const rates = this.rates();
    this.perf.textContent = JSON.stringify({
      startedAt: this.startedAt,
      firstTextAt: this.firstTextAt,
      tokensPerSecond: rates.tokensPerSecond,
      segmentsPerSecond: rates.segmentsPerSecond,
      segments: this.samples,
    });
  }

  private publishState(): void {
    const root = this.doc.documentElement;
    if (!this.active) {
      delete root.dataset.sakuttoState;
      delete root.dataset.sakuttoProgress;
      this.overlay.hideBar();
      return;
    }
    const view = this.state();
    root.dataset.sakuttoState = view.pending > 0 ? 'translating' : 'translated';
    root.dataset.sakuttoProgress = `${String(view.done)}/${String(view.total)}`;
    if (view.tokensPerSecond !== null && view.segmentsPerSecond !== null) {
      root.dataset.sakuttoRate = `${formatRate(view.tokensPerSecond)} tok/s, ${formatRate(view.segmentsPerSecond)} seg/s`;
    } else {
      delete root.dataset.sakuttoRate;
    }
    this.overlay.showBar({
      text: this.barText(view),
      original: this.labels.barOriginal,
      always: view.auto === 'always' ? this.labels.barAlwaysOn : this.labels.barAlways,
      alwaysEnabled: view.auto !== 'always',
    });
  }

  private showHover(event: Event): void {
    const block = blockFromEvent(event);
    if (!block) return;
    const item = this.liveByBlock.get(block);
    if (!item?.translation || item.kind === 'chrome') return;
    if (this.prefs.display === 'bilingual' && this.keepsOriginalVisible(item)) return;
    const point =
      event instanceof PointerEvent ? { x: event.clientX, y: event.clientY } : undefined;
    this.overlay.showOriginal(block, item.plain, item.engine, point);
  }

  private hideHover(event: Event): void {
    const block = blockFromEvent(event);
    const next =
      event instanceof PointerEvent || event instanceof FocusEvent ? event.relatedTarget : null;
    if (block && next instanceof Node && block.contains(next)) return;
    this.overlay.hideOriginal();
  }

  private onMutations(records: MutationRecord[]): void {
    if (!this.active || this.applying > 0) return;
    let external = false;
    let removed = 0;
    const stale = new Set<Element>();

    for (const record of records) {
      if (record.type === 'characterData') {
        if (this.isExpectedText(record.target)) continue;
        external = true;
        const block = this.blockOf(record.target);
        if (block) stale.add(block);
        continue;
      }
      for (const node of record.addedNodes) {
        if (this.isOwnNode(node)) continue;
        external = true;
        const block = this.blockOf(node);
        if (block && this.liveByBlock.has(block)) stale.add(block);
      }
      for (const node of record.removedNodes) {
        if (this.isOwnNode(node)) continue;
        external = true;
        if (node instanceof Element && this.liveByBlock.has(node)) removed += 1;
      }
    }

    if (!external) return;
    if (removed > 0 && this.liveByBlock.size > 0 && removed * 2 >= this.liveByBlock.size) {
      this.abortRunning(true);
    }
    this.forgetDisconnected();
    for (const block of stale) this.refreshBlock(block);
    this.scheduleScan();
  }

  private isExpectedText(node: Node): boolean {
    return node instanceof Text && this.expected.get(node) === (node.nodeValue ?? '');
  }

  private isOwnNode(node: Node): boolean {
    if (node instanceof Text && this.expected.has(node)) return true;
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return false;
    if (element.id === PAGE_STYLE_ELEMENT_ID) return true;
    return isOwnUi(element);
  }

  private blockOf(node: Node): Element | null {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest('[data-sakutto-id]') ?? null;
  }

  private refreshBlock(block: Element): void {
    const existing = this.liveByBlock.get(block);
    if (!existing || existing.state === 'running') return;
    const model = buildSegment(block);
    if (model && model.source === existing.source) return;
    const index = existing.index;
    this.forgetLive(existing, false);
    this.addBlock(block, index);
  }

  private forgetDisconnected(): void {
    let running = false;
    for (const [block, item] of this.liveByBlock) {
      if (block.isConnected) continue;
      if (item.state === 'running') running = true;
    }
    if (running) this.abortRunning(true);
    for (const [block, item] of [...this.liveByBlock]) {
      if (block.isConnected) continue;
      this.forgetLive(item, false);
    }
  }

  private scheduleScan(): void {
    if (this.scanTimer !== null) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.requestScan().then(() => {
        if (this.active) this.pump();
      });
    }, this.debounceMs);
  }

  private bindObservers(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];

    const watch = (root: Node): void => {
      try {
        const observer = new MutationObserver((records) => this.onMutations(records));
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        this.observers.push(observer);
      } catch {
        // Documents without MutationObserver still translate the tree captured at start.
      }
    };

    this.bindKeys();
    for (const document of collectDocuments(this.doc)) {
      this.bindPointerRoot(document);
      watch(document.body ?? document.documentElement);
      for (const shadow of collectShadowRoots(document)) {
        this.bindPointerRoot(shadow);
        watch(shadow);
      }
    }
    this.watchFrames();
  }

  private bindKeys(): void {
    const live = new Set<Window>();
    for (const document of collectDocuments(this.doc)) {
      const view = document.defaultView;
      if (!view) continue;
      live.add(view);
      if (this.keyWindows.has(view)) continue;
      view.addEventListener('keydown', this.onKeyDown, true);
      this.keyWindows.add(view);
    }
    for (const view of this.keyWindows) {
      if (live.has(view)) continue;
      view.removeEventListener('keydown', this.onKeyDown, true);
      this.keyWindows.delete(view);
    }
  }

  private unbindKeys(): void {
    for (const view of this.keyWindows) view.removeEventListener('keydown', this.onKeyDown, true);
    this.keyWindows.clear();
  }

  private invalidatePaints(): void {
    this.paintGeneration += 1;
    this.dirty.clear();
    this.frameQueued = false;
  }

  private keepsOriginalVisible(item: Live): boolean {
    const block = item.model?.block;
    return item.kind === 'prose' && !item.heading && block !== undefined && isBodyCopy(block);
  }

  private bindPointerRoot(root: Document | ShadowRoot): void {
    if (this.pointerRoots.has(root)) return;
    root.addEventListener('pointerover', this.onPointerOver);
    root.addEventListener('pointerout', this.onPointerOut);
    root.addEventListener('pointerdown', this.onPointerDown);
    root.addEventListener('pointerup', this.onPointerUp);
    root.addEventListener('pointercancel', this.onPointerUp);
    root.addEventListener('focusin', this.onFocusIn);
    root.addEventListener('focusout', this.onFocusOut);
    if (isSelectionRoot(root)) root.addEventListener('selectionchange', this.onSelectionChange);
    this.pointerRoots.add(root);
  }

  private unbindPointers(): void {
    for (const root of this.pointerRoots) {
      root.removeEventListener('pointerover', this.onPointerOver);
      root.removeEventListener('pointerout', this.onPointerOut);
      root.removeEventListener('pointerdown', this.onPointerDown);
      root.removeEventListener('pointerup', this.onPointerUp);
      root.removeEventListener('pointercancel', this.onPointerUp);
      root.removeEventListener('focusin', this.onFocusIn);
      root.removeEventListener('focusout', this.onFocusOut);
      if (isSelectionRoot(root)) {
        root.removeEventListener('selectionchange', this.onSelectionChange);
      }
    }
    this.pointerRoots.clear();
  }

  private watchFrames(): void {
    const frames: HTMLIFrameElement[] = [];
    const gather = (root: ParentNode): void => {
      for (const frame of root.querySelectorAll('iframe')) {
        if (frame instanceof HTMLIFrameElement) frames.push(frame);
      }
      for (const element of root.querySelectorAll('*')) {
        if (isOwnUi(element) || !element.shadowRoot) continue;
        gather(element.shadowRoot);
      }
    };
    for (const document of collectDocuments(this.doc)) gather(document);

    for (const frame of frames) {
      if (this.frameLoads.has(frame)) continue;
      const onLoad = (): void => {
        this.bindObservers();
        this.bindVisibility();
        if (this.active) this.scheduleScan();
      };
      frame.addEventListener('load', onLoad);
      this.frameLoads.set(frame, onLoad);
    }
  }

  private bindHistory(): void {
    const view = this.doc.defaultView;
    const history = view?.history;
    if (!view || !history) return;
    const pushState = history.pushState;
    const replaceState = history.replaceState;
    const notify = (before: string, url: string | URL | null | undefined): void => {
      if (!this.active || !locationChanged(before, url)) return;
      this.invalidatePaints();
      this.abortRunning(true);
      this.scheduleScan();
    };
    history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
      const before = view.location.href;
      pushState.apply(this, args);
      notify(before, args[2]);
    };
    history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
      const before = view.location.href;
      replaceState.apply(this, args);
      notify(before, args[2]);
    };
    this.historyUnpatch = () => {
      history.pushState = pushState;
      history.replaceState = replaceState;
    };
  }

  private bindVisibility(): void {
    for (const observer of this.visibilities.values()) observer.disconnect();
    this.visibilities.clear();

    const view = this.doc.defaultView;
    const height = this.doc.documentElement.clientHeight || view?.innerHeight || 800;
    const screens = lookaheadScreens(this.prefs.tier);
    const ahead = Math.round(height * screens);
    const behind = Math.round(ahead * 0.25);
    const top = this.direction === 'down' ? behind : ahead;
    const bottom = this.direction === 'down' ? ahead : behind;
    const rootMargin = `${String(top)}px 0px ${String(bottom)}px 0px`;
    const callback = (entries: IntersectionObserverEntry[]): void => {
      let changed = false;
      for (const entry of entries) {
        if (!(entry.target instanceof Element)) continue;
        const item = this.liveByBlock.get(entry.target);
        if (!item) continue;
        const rect = entry.boundingClientRect;
        if (rect.width === 0 && rect.height === 0) continue;
        const viewport = entry.rootBounds?.height || height;
        const onScreen = rect.bottom > 0 && rect.top < viewport;
        const band: VisibilityBand = onScreen ? 'visible' : entry.isIntersecting ? 'near' : 'far';
        if (band === item.band) continue;
        item.band = band;
        changed = true;
      }
      if (changed) this.reprioritize();
    };

    for (const document of collectDocuments(this.doc)) {
      const Observer = document.defaultView?.IntersectionObserver;
      if (!Observer) continue;
      try {
        this.visibilities.set(
          document,
          new Observer(callback, { root: null, rootMargin, threshold: 0 }),
        );
      } catch {
        // This document cannot host an observer. Its blocks stay in document order.
      }
    }

    for (const block of this.liveByBlock.keys()) this.observeBlock(block);
  }

  private observeBlock(block: Element): void {
    const observer = this.visibilities.get(block.ownerDocument);
    if (!observer) return;
    try {
      observer.observe(block);
    } catch {
      // A block from another document is observed with that document's observer.
    }
  }

  private reprioritize(): void {
    const queued: Live[] = [];
    this.queue.clear();
    for (const item of this.live.values()) {
      if (item.state === 'queued') queued.push(item);
    }
    if (this.selection?.state === 'queued') queued.push(this.selection);
    for (const item of queued) this.queue.enqueue(item, this.priorityOf(item));
    this.pump();
  }

  private isIdle(): boolean {
    return (
      this.running === 0 &&
      this.previewing === 0 &&
      this.queue.size === 0 &&
      this.scanTimer === null &&
      this.selectionTimer === null &&
      this.pendingScans === 0
    );
  }

  private resolveIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

function hasBox(item: Live): boolean {
  const rect = item.model?.block.getBoundingClientRect();
  if (!rect) return false;
  return rect.width > 0 && rect.height > 0;
}

function isBodyCopy(block: Element): boolean {
  return block.matches('p, li, blockquote, dd, figcaption');
}

/**
 * `pushState` / `replaceState` fire for query and hash updates that leave the
 * article in place. Restarting there aborts the current completion and the
 * bar stays at zero until that wasted generation ends.
 */
function locationChanged(before: string, url: string | URL | null | undefined): boolean {
  if (url === undefined || url === null || url === '') return false;
  try {
    const next = new URL(String(url), before);
    const previous = new URL(before);
    return next.origin !== previous.origin || next.pathname !== previous.pathname;
  } catch {
    return false;
  }
}

function openPlaceholderCount(source: string): number {
  return [...source.matchAll(/<i\d+>/g)].length;
}

function glossaryKey(glossary: readonly GlossaryEntry[] | undefined): string {
  return (glossary ?? []).map((entry) => `${entry.source}\u0000${entry.target}`).join('\u0001');
}

function expandSource(item: Live): { id: string; text: string }[] {
  const source = item.flatten ? stripPlaceholderTokens(item.source) : item.source;
  const pieces = splitForTranslation(source);
  if (pieces.length <= 1) return [{ id: item.id, text: source }];
  return pieces.map((text, index) => ({ id: `${item.id}#${String(index)}`, text }));
}

function placeholderGlossary(
  batch: readonly Live[],
  glossary: readonly GlossaryEntry[],
): GlossaryEntry[] {
  const ids = new Set<string>();
  for (const item of batch) {
    if (item.flatten || item.role === 'selection') continue;
    for (const match of item.source.matchAll(/<\/?(i\d+)>/g)) {
      const id = match[1];
      if (id) ids.add(id);
    }
  }
  const locked = [...ids].flatMap((id) => [
    { source: `<${id}>`, target: `<${id}>` },
    { source: `</${id}>`, target: `</${id}>` },
  ]);
  return [...glossary, ...locked];
}

function viewportHeight(element: Element): number {
  const view = element.ownerDocument.defaultView;
  return view?.innerHeight || element.ownerDocument.documentElement.clientHeight || 800;
}

function partIndex(id: string): number {
  const marker = id.lastIndexOf('#');
  if (marker === -1) return 0;
  const index = Number(id.slice(marker + 1));
  return Number.isInteger(index) ? index : 0;
}

function partialText(item: Live, target: string): string {
  const parts = item.partText.filter((part) => part.trim().length > 0);
  if (parts.length === 0) return '';
  return joinTranslatedSentences(parts, target);
}

/**
 * A frame document fails `instanceof Document` when `Document` comes from another
 * window. selectionchange is dispatched on each document, not on its shadow roots.
 */
function isSelectionRoot(root: EventTarget): root is Document {
  return 'nodeType' in root && (root as Node).nodeType === Node.DOCUMENT_NODE;
}

function selectionViewportRect(range: Range, source: Document, page: Document): DOMRect {
  const local = endClientRect(range);
  let left = local.left;
  let topPx = local.top;
  let current: Document | null = source;
  const seen = new Set<Document>();
  while (current && current !== page && !seen.has(current)) {
    seen.add(current);
    const frameElement: Element | null = current.defaultView?.frameElement ?? null;
    if (!(frameElement instanceof HTMLElement)) break;
    const frameRect = frameElement.getBoundingClientRect();
    left += frameRect.left;
    topPx += frameRect.top;
    current = frameElement.ownerDocument;
  }
  return new DOMRect(left, topPx, local.width, local.height);
}

function endClientRect(range: Range): DOMRect {
  if (typeof range.getClientRects === 'function') {
    const rects = range.getClientRects();
    for (let index = rects.length - 1; index >= 0; index -= 1) {
      const rect = rects.item(index);
      if (!rect || (rect.width <= 0 && rect.height <= 0)) continue;
      return new DOMRect(rect.left, rect.top, rect.width, rect.height);
    }
  }
  const box = range.getBoundingClientRect();
  return new DOMRect(box.left, box.top, box.width, box.height);
}

function blockFromEvent(event: Event): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const nodes = path.length > 0 ? path : event.target ? [event.target] : [];
  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    if (node.matches('[data-sakutto-id]')) return node;
    const closest = node.closest('[data-sakutto-id]');
    if (closest) return closest;
  }
  return null;
}
