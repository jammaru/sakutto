import { estimateTokens } from '@/engine/text/tokens';
import {
  coveredBlocks,
  formatRate,
  outputTokenCount,
  pageRates,
  RATE_HOLD_MS,
  roundProgress,
  type PageRates,
  type ThroughputSample,
} from './throughput';
import { DEFAULT_BATCHING } from '@/engine/text/plan';
import { chunkForTranslation, joinTranslatedSentences } from '@/engine/text/sentences';
import { isPlainAltS } from '@/shared/shortcuts';
import { PriorityQueue } from '@/engine/queue/priority-queue';
import type { EngineKind, GlossaryEntry, TranslateOptions, TranslationChunk } from '@/engine/types';
import { mergeGlossary } from '@/shared/glossary';
import { chooseTargetLanguage, isTargetLanguage, type TargetLanguage } from '@/shared/languages';
import type { Formality, Settings, TranslationPace } from '@/shared/settings';
import { canonicalPageLanguage, isAlreadyTargetLanguage, languageOf } from './detect';
import {
  collectDocuments,
  collectShadowRoots,
  eachTranslatableBlock,
  isAriaHiddenLeaf,
  isBlockElement,
  isFrozenInline,
  isOwnUi,
  isScreenReaderOnly,
  isTranslationExcluded,
  isTypedTextSelection,
} from './blocks';
import type { OverlayLabels } from './overlay';
import { PageOverlay, PAGE_STYLE_ELEMENT_ID } from './overlay';
import { assessTranslation, stripPlaceholderTokens } from './placeholders';
import {
  bandForRect,
  contentKind,
  lookaheadScreens,
  GPU_TRANSLATION_CONCURRENCY,
  TRANSLATION_CONCURRENCY,
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
  stripLegacyNotes,
} from './render';
import {
  allSlots,
  buildSegment,
  placeholderIds,
  visibleOriginal,
  type SegmentModel,
} from './segment';
import type { SiteAuto, SiteRule } from './sites';

/** The engine packs by the same rule, so a request the page packs is not split up again. */
const PACK_TOKEN_LIMIT = DEFAULT_BATCHING.maxBatchTokens;
const PACK_SEGMENT_TOKENS = DEFAULT_BATCHING.maxSegmentTokens;
/** How many blocks one packed completion may carry. */
const MAX_BATCH_SEGMENTS = 8;
/** Placeholder tags one packed request may carry before the line match gets unreliable. */
const MAX_BATCH_PLACEHOLDERS = 16;
/** How far behind the head of the queue a block may sit and still join its request. */
const PACK_PRIORITY_SLACK = 24;
const SLICE_SIZE = 24;
const MAX_PAGE_FAILURES = 2;
/** Keyboard selections settle before inference, so a partial highlight does not occupy the model. */
const SELECTION_SETTLE_MS = 48;
/** A selectionchange that follows pointerup is the same gesture and should not wait out the keyboard delay. */
const POINTER_RELEASE_WINDOW_MS = 80;
/**
 * The rate only needs a few observations per second, so the whole page is not re-counted
 * for every finished segment. Each count walks every translated character.
 */
const TOKEN_RECOUNT_MS = 250;

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
  /** Visible prose the page had when translation started that never got a translation. */
  skipped: number;
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
  failures: number;
  heading: boolean;
  /** The block is too large or too structured to share a completion with another block. */
  solo: boolean;
  kind: ContentKind;
  lang: string | null;
  index: number;
  band: VisibilityBand;
  state: LiveState;
  translation: string;
  engine: EngineKind | null;
  created: Text[];
  originalChildren: ChildNode[];
  partText: string[];
  partFinal: boolean[];
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
  /**
   * True for the key the reader bound to the selection command. Defaults to Alt+S, the key the
   * manifest suggests; a page that can read the current binding passes its own test.
   */
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
  private lastRateAt = 0;
  private tokenCountAt = 0;
  private throughputSamples: ThroughputSample[] = [];
  private heldRates: PageRates = { tokensPerSecond: null, segmentsPerSecond: null };
  private heldTokensAt = 0;
  private heldSegmentsAt = 0;
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
  private readonly observedRoots = new Map<Node, MutationObserver>();
  private readonly visibilities = new Map<Document, IntersectionObserver>();
  private readonly pointerRoots = new Set<EventTarget>();
  private readonly frameLoads = new Map<HTMLIFrameElement, () => void>();
  private readonly expected = new WeakMap<Text, string>();
  /**
   * Blocks the last scan found but could not turn into a translation job. Only a block
   * that owns prose of its own counts: a layout container whose text lives in nested
   * blocks is covered by those blocks, and counting it would make every page look partial.
   */
  private readonly skippedBlocks = new Map<Element, string>();
  private applying = 0;
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
  /**
   * Scheduling counters for the page bench. They describe how the page drove the engine
   * — batches and pieces — which is the only part of a run a mock translator can still
   * measure, and the part a software-side speed change actually moves.
   */
  private work = { batches: 0, pieces: 0, engineMs: 0 };
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
    if (
      lookaheadScreens(previous.tier, previous.pace) !== lookaheadScreens(tier, this.prefs.pace)
    ) {
      this.bindVisibility();
    }
    if (next.display !== previous.display) this.repaintAll();
    if (next.auto !== previous.auto && this.active) this.publishState();
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
    const tracked = this.trackedPages();
    const lives = [...this.live.values()];
    // Chrome appears here only for a pair the model cannot translate at all; it is never a
    // stand-in for a warming model. Until something has painted, the engine is still null.
    let engine: EngineKind | null = null;
    if (this.active) {
      if (lives.some((item) => item.engine === 'plamo')) engine = 'plamo';
      else if (lives.some((item) => item.engine === 'chrome')) engine = 'chrome';
    }
    const pageLanguage = this.sourceLanguage();
    const rates = this.rates();

    return {
      active: this.active,
      display: this.prefs.display,
      engine,
      pending: tracked.filter((item) => item.state === 'queued' || item.state === 'running').length,
      done: roundProgress(coveredBlocks(tracked)),
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
      skipped: this.active ? this.skippedProse() : 0,
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
    this.sweepLegacyNotes();
    this.startedAt = performance.now();
    this.firstTextAt = null;
    this.samples = [];
    this.throughputSamples = [{ atMs: this.startedAt, tokens: 0, segments: 0 }];
    this.heldRates = { tokensPerSecond: null, segmentsPerSecond: null };
    this.heldTokensAt = 0;
    this.heldSegmentsAt = 0;
    this.work = { batches: 0, pieces: 0, engineMs: 0 };
    this.pageController = new AbortController();
    this.eagerOnce = true;
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
    this.throughputSamples = [];
    this.heldRates = { tokensPerSecond: null, segmentsPerSecond: null };
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
      // A field the reader is typing in reports its value as the document selection.
      if (isTypedTextSelection(doc.activeElement, text)) continue;
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

  /**
   * A block that failed while the model was still loading shows its source text. Once the
   * model is ready those blocks are queued again; nothing was painted in their place, so
   * there is no draft to replace — only missing text to translate.
   */
  retryUntranslated(): void {
    if (!this.active) return;
    for (const item of this.live.values()) {
      if (item.role !== 'page' || item.state === 'running') continue;
      if (item.translation.trim().length > 0) continue;
      this.enqueue(item, true);
    }
    this.pump();
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
    this.observedRoots.clear();
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

  /**
   * A translated page must not read as finished while visible prose has no translation.
   * A block is admitted when it becomes a translation job; it is skipped when it is
   * already in the target language, which is correct. Anything else the page shows as
   * prose but that produced no job is reported, so a page whose collector found too
   * little can no longer present "Translated" over an English column.
   */
  private addBlock(block: Element, index: number): void {
    if (this.liveByBlock.has(block)) return;
    if (isAlreadyTargetLanguage(block, this.prefs.targetLanguage, this.detectedLanguage)) return;

    const model = buildSegment(block);
    if (!model) {
      // A container whose only text belongs to nested blocks is covered by those blocks.
      // Reporting it would turn every page with a menu or a form into a partial result.
      if (ownProse(block, canonicalPageLanguage(this.prefs.targetLanguage))) {
        this.skippedBlocks.set(block, block.textContent ?? '');
      }
      return;
    }

    const item: Live = {
      id: this.allocateId(),
      role: 'page',
      model,
      source: model.source,
      plain: visibleOriginal(block),
      placeholder: model.placeholder,
      flatten: false,
      attempts: 0,
      failures: 0,
      heading: /^H[1-6]$/u.test(block.tagName),
      solo: model.source.includes('\n'),
      kind: contentKind(block),
      lang: languageOf(block, this.detectedLanguage),
      index,
      band: bandForRect(block.getBoundingClientRect(), viewportHeight(block)),
      state: 'idle',
      translation: '',
      engine: null,
      created: [],
      originalChildren: [...block.childNodes],
      partText: [],
      partFinal: [],
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
      failures: 0,
      heading: false,
      solo: true,
      kind: 'prose',
      lang: this.detectedLanguage,
      index: 0,
      band: 'visible',
      state: 'queued',
      translation: '',
      engine: null,
      created: [],
      originalChildren: [],
      partText: [],
      partFinal: [],
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

  /**
   * Blocks still showing source text, either because no translation job could be built for
   * them or because every attempt failed and the block fell back to its source. A block
   * that later gains a translation, or whose text the page replaced, stops counting.
   */
  private skippedProse(): number {
    let count = 0;
    for (const [block, text] of [...this.skippedBlocks]) {
      // A block that got a translation is covered, even though it is still a live item.
      // A block that failed keeps its live entry with an empty translation, so it has to
      // stay counted here.
      const live = this.liveByBlock.get(block);
      const translated = live !== undefined && live.translation.trim().length > 0;
      const gone = translated || !block.isConnected || block.textContent !== text;
      if (gone) {
        this.skippedBlocks.delete(block);
        continue;
      }
      count += 1;
    }
    return count;
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

    const concurrency =
      this.prefs.tier === 'g' ? GPU_TRANSLATION_CONCURRENCY : TRANSLATION_CONCURRENCY;
    while (this.running < concurrency && this.queue.size > 0) {
      const next = this.queue.peek();
      if (!next) break;
      if (this.selectionBusy() && next.value.role !== 'selection') break;
      const batch = this.takeBatch();
      if (batch.length === 0) break;
      const priority = Math.min(...batch.map((item) => this.priorityOf(item)));
      this.beginBatch(batch, priority);
    }

    this.publishState();
    this.resolveIdle();
  }

  /**
   * A queued selection starts even while a page batch is in flight. The engine
   * scheduler then runs it next, after whatever completions are already inside the model,
   * without cancelling those.
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
    // The very first request of a run paints one block on its own, so the reader sees text
    // before the rest of the screen is packed. Every later request packs.
    const eager = this.eagerOnce;
    this.eagerOnce = false;
    if (first.role === 'selection' || first.heading || first.solo || eager) return batch;

    const limit = PACK_TOKEN_LIMIT;
    const firstTokens = estimateTokens(first.source);
    if (firstTokens > PACK_SEGMENT_TOKENS) return batch;

    let tokens = firstTokens;
    let placeholders = openPlaceholderCount(first.source);
    const firstPriority = this.priorityOf(first);
    while (this.queue.size > 0 && batch.length < MAX_BATCH_SEGMENTS) {
      const peeked = this.queue.peek();
      if (!peeked) break;
      const next = peeked.value;
      if (next.role !== 'page' || next.lang !== first.lang) break;
      if (next.heading || next.solo) break;
      if (peeked.priority > firstPriority + PACK_PRIORITY_SLACK) break;
      const added = estimateTokens(next.source);
      const nextPlaceholders = openPlaceholderCount(next.source);
      if (
        added > PACK_SEGMENT_TOKENS ||
        tokens + added > limit ||
        placeholders + nextPlaceholders > MAX_BATCH_PLACEHOLDERS
      ) {
        break;
      }
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
      if (item.role === 'page' && item.model) {
        item.model.block.setAttribute('data-sakutto-pending', '1');
      }
      const pieces = expandSource(item);
      const preserve = item.failures > 0 && item.partText.length === pieces.length;
      item.partFinal = pieces.map((_, index) =>
        preserve ? item.partFinal[index] === true : false,
      );
      if (preserve) {
        // A retry restarts unfinished pieces, so their half-decoded text must go;
        // otherwise attempt two appends onto the fragment attempt one left behind.
        item.partText = pieces.map((_, index) =>
          item.partFinal[index] === true ? (item.partText[index] ?? '') : '',
        );
      } else {
        item.partText = pieces.map(() => '');
      }
      for (const piece of pieces) {
        const index = partIndex(piece.id);
        if (item.partFinal[index]) continue;
        requests.push(piece);
        owners.set(piece.id, item);
      }
    }

    if (requests.length === 0) {
      for (const item of batch) {
        if (item.partFinal.length > 0 && item.partFinal.every(Boolean)) this.complete(item);
      }
      return;
    }

    this.work.batches += 1;
    this.work.pieces += requests.length;
    const engineStarted = performance.now();

    try {
      for await (const chunk of this.engine.translate(
        requests,
        this.optionsFor(batch, priority, signal),
      )) {
        if (signal.aborted) return;
        const item = owners.get(chunk.id);
        if (!item || item.batchToken !== token) continue;
        const index = partIndex(chunk.id);
        if (item.state !== 'running') continue;
        if (chunk.engine) item.engine = chunk.engine;
        if (chunk.textDelta) {
          const before = chunk.restart === true ? '' : (item.partText[index] ?? '');
          item.partText[index] = before + chunk.textDelta;
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
      // Unfinished blocks are retried below. Abort keeps the previous text.
    } finally {
      this.work.engineMs += Math.round(performance.now() - engineStarted);
      // The last `complete()` of this batch already ran inside the loop above, before this
      // time was added, so the payload has to be rewritten once the batch's cost is known.
      this.writePerf();
      for (const item of batch) {
        if (item.batchToken !== token || item.state !== 'running') {
          if (item.batchToken === token) this.showSelectionFailure(item, signal);
          continue;
        }
        if (signal.aborted) {
          item.state = item.translation.length > 0 ? 'done' : 'idle';
          item.model?.block.removeAttribute('data-sakutto-pending');
          this.showSelectionFailure(item, signal);
          continue;
        }
        if (item.partFinal.length > 0 && item.partFinal.every(Boolean)) {
          this.complete(item);
          continue;
        }
        if (item.role === 'page' && item.failures < MAX_PAGE_FAILURES) {
          item.failures += 1;
          // Retry alone. A packed request that failed may have done so because of one of
          // its neighbours, so packing the same group again would fail the same way and
          // take every block in it down with it.
          item.solo = true;
          item.state = 'idle';
          this.enqueue(item, true);
          continue;
        }
        if (item.role === 'selection') {
          item.state = item.translation.length > 0 ? 'done' : 'idle';
          item.model?.block.removeAttribute('data-sakutto-pending');
          this.showSelectionFailure(item, signal);
          continue;
        }
        this.settleFailed(item);
      }
    }
  }

  /**
   * Keeps any finished sentences and lets the page counter move past a block that will not
   * complete. Only pieces that actually finished are kept; a half-decoded fragment is not a
   * translation, so that piece falls back to the source text instead.
   */
  private settleFailed(item: Live): void {
    const pieces = expandSource(item);
    const keep = pieces.map((_, index) =>
      item.partFinal[index] === true ? (item.partText[index]?.trim() ?? '') : '',
    );
    if (!keep.some((part) => part.length > 0)) {
      // Nothing finished. Undo the partial paint so the block shows its source text
      // instead of a half-decoded fragment.
      // The page keeps showing source prose here, so it must not read as translated. A
      // block that exhausted its retries is the case the reported page hit: the requests
      // failed and the bar still said the page was done.
      if (item.model) this.skippedBlocks.set(item.model.block, item.model.block.textContent ?? '');
      this.resetLive(item);
      item.state = 'done';
      item.translation = '';
      item.partText = [];
      item.partFinal = [];
      item.engine = null;
      item.model?.block.removeAttribute('data-sakutto-pending');
      this.publishState();
      return;
    }
    item.partText = pieces.map((piece, index) => {
      const text = keep[index] ?? '';
      return text.length > 0 ? text : piece.text;
    });
    item.partFinal = item.partText.map(() => true);
    this.complete(item);
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
    this.publishState();
  }

  private acceptTranslation(item: Live, output: string): string | 'retry' {
    if (item.role === 'selection' || !item.model?.placeholder || item.flatten) {
      return stripPlaceholderTokens(output);
    }
    const verdict = assessTranslation(output, placeholderIds(item.model));
    if (verdict.ok) return verdict.text;
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

    return {
      tgt: this.prefs.targetLanguage,
      form: this.prefs.form,
      priority,
      signal,
      ...(source ? { src: source } : {}),
      ...(glossary.length > 0 ? { glossary } : {}),
      ...(context ? { context } : {}),
      ...(eager ? { eager: true } : {}),
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
      if (!verdict.ok) return;
      text = verdict.text;
    } else {
      text = stripPlaceholderTokens(text);
    }

    const bilingual = this.prefs.display === 'bilingual' && this.keepsOriginalVisible(item);
    this.editDom(() => {
      model.block.setAttribute('data-sakutto-id', item.id);
      if (item.engine) model.block.setAttribute('data-sakutto-engine', item.engine);

      if (bilingual) {
        showBilingual(model, text, item.created);
        const line = model.block.querySelector('sakutto-line');
        if (line instanceof HTMLElement) line.lang = this.prefs.targetLanguage;
        if (!partial || !model.placeholder) model.block.removeAttribute('data-sakutto-pending');
      } else if (partial) {
        removeTranslationUi(model.block);
        paintPlain(model, text, item.created);
        if (item.engine === 'chrome' || model.placeholder) {
          model.block.setAttribute('data-sakutto-pending', '1');
        }
      } else {
        removeTranslationUi(model.block);
        applyTranslation(model, text, item.created);
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
      item.flatten = false;
      item.attempts = 0;
      item.failures = 0;
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

  /**
   * A page translated by an older build keeps its badge in the DOM. Blocks that already
   * read as the target language are skipped by the scan, so the per-block cleanup never
   * reaches them: this clears the whole page before the first paint instead.
   */
  private sweepLegacyNotes(): void {
    this.editDom(() => {
      for (const document of collectDocuments(this.doc)) {
        stripLegacyNotes(document);
        for (const shadow of collectShadowRoots(document)) stripLegacyNotes(shadow);
      }
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

  /**
   * Every block the page is translating. The bar used to count only `prose` blocks, so a
   * page whose text lives in table cells or sidebars reported "2 / 2" while a hundred rows
   * were still pending — and, once the scan started splitting table rows into cells, that
   * silent filter hid nearly all of the work. Coverage is about blocks that got a job, not
   * about how the ranking classified them.
   */
  private trackedPages(): Live[] {
    return [...this.live.values()].filter((item) => item.role === 'page');
  }

  private rates(): PageRates {
    const tracked = this.trackedPages();
    this.noteThroughput(tracked);
    const now = performance.now();
    const measured = pageRates({
      active: this.active,
      nowMs: now,
      samples: this.throughputSamples,
    });
    const tokens = measured.tokensPerSecond ?? this.heldRate('tokens', now);
    const segments = measured.segmentsPerSecond ?? this.heldRate('segments', now);
    if (measured.tokensPerSecond !== null) {
      this.heldRates = { ...this.heldRates, tokensPerSecond: measured.tokensPerSecond };
      this.heldTokensAt = now;
    }
    if (measured.segmentsPerSecond !== null) {
      this.heldRates = { ...this.heldRates, segmentsPerSecond: measured.segmentsPerSecond };
      this.heldSegmentsAt = now;
    }
    return { tokensPerSecond: tokens, segmentsPerSecond: segments };
  }

  /**
   * The last measured rate stays on the bar while a page request is inside the engine. A
   * prompt's prefill produces no tokens, and on the CPU runtime it costs nearly as much per
   * token as decoding, so dropping the rate there made a working engine look stalled.
   */
  private heldRate(kind: 'tokens' | 'segments', now: number): number | null {
    const at = kind === 'tokens' ? this.heldTokensAt : this.heldSegmentsAt;
    if (at === 0) return null;
    if (now - at > RATE_HOLD_MS && !this.pageWorkInFlight()) return null;
    return kind === 'tokens' ? this.heldRates.tokensPerSecond : this.heldRates.segmentsPerSecond;
  }

  private pageWorkInFlight(): boolean {
    for (const batch of this.inflightBatches) {
      if (batch.items.some((item) => item.role === 'page')) return true;
    }
    return false;
  }

  private noteThroughput(tracked: readonly Live[], now = performance.now()): void {
    if (!this.active) return;
    const segments = tracked.reduce((count, item) => {
      if (item.partFinal.some(Boolean)) return count + item.partFinal.filter(Boolean).length;
      return count + (item.state === 'done' ? 1 : 0);
    }, 0);
    const last = this.throughputSamples[this.throughputSamples.length - 1];
    if (last && last.segments === segments && now - last.atMs < 200) return;

    // Counting tokens means walking every translated character on the page. That was done
    // on every completion and every paint frame, which is quadratic on a long page for a
    // number that only needs a few observations per second to produce a rate.
    if (this.tokenCountAt > 0 && now - this.tokenCountAt < TOKEN_RECOUNT_MS) return;
    const tokens = outputTokenCount(
      tracked.map((item) =>
        item.translation.length > 0 ? item.translation : item.partText.join(''),
      ),
    );
    this.tokenCountAt = now;
    if (last && last.tokens === tokens && last.segments === segments) return;
    if (last && last.segments === segments && now - last.atMs < 200) {
      last.tokens = tokens;
      last.atMs = now;
      return;
    }
    this.throughputSamples.push({ atMs: now, tokens, segments });
    const cutoff = now - RATE_HOLD_MS * 2;
    while (this.throughputSamples.length > 2 && (this.throughputSamples[0]?.atMs ?? 0) < cutoff) {
      this.throughputSamples.shift();
    }
  }

  private barText(view: PageViewState): string {
    const base =
      view.pending > 0
        ? this.labels.barProgress(view.done, view.total)
        : view.skipped > 0
          ? this.labels.barPartial(view.skipped)
          : this.labels.barDone;
    if (view.tokensPerSecond === null || view.segmentsPerSecond === null) return base;
    return `${base} · ${this.labels.barRate(formatRate(view.tokensPerSecond), formatRate(view.segmentsPerSecond))}`;
  }

  private noteLiveRate(): void {
    const now = performance.now();
    if (now - this.lastRateAt < 500) return;
    this.lastRateAt = now;
    this.publishState();
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
    this.writePerf();
  }

  /**
   * Rewrites the `sakutto-perf` payload. This also runs after a batch's engine time is
   * added, because `noteTiming` is reached from the last `complete()` inside the batch —
   * one statement before that time is counted — so the final batch of every page used to
   * be missing from `engineMs`, which on a single-block page is the whole cost.
   */
  private writePerf(): void {
    if (!this.perf) return;
    const rates = this.rates();
    this.perf.textContent = JSON.stringify({
      startedAt: this.startedAt,
      firstTextAt: this.firstTextAt,
      tokensPerSecond: rates.tokensPerSecond,
      segmentsPerSecond: rates.segmentsPerSecond,
      segments: this.samples,
      batches: this.work.batches,
      pieces: this.work.pieces,
      engineMs: this.work.engineMs,
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
    // `translated` is what the popup and the e2e suite read, so it may only appear when
    // the page really is translated. Leftover source prose keeps the page `partial`.
    const finished = view.pending === 0;
    root.dataset.sakuttoState = finished
      ? view.skipped > 0
        ? 'partial'
        : 'translated'
      : 'translating';
    const blocksDone = Math.min(view.total, Math.floor(view.done));
    root.dataset.sakuttoProgress = `${String(blocksDone)}/${String(view.total)}`;
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

  /**
   * Observers are attached incrementally instead of being rebuilt. Disconnecting them
   * on every scan dropped the mutations that arrived while a scan was walking, which is
   * exactly the window in which a single-page app mounts its sidebar. Only roots that
   * disappeared are dropped, so a long page does not pay for a full teardown per scan.
   */
  private bindObservers(): void {
    const documents = collectDocuments(this.doc);
    const roots = new Set<Node>();
    for (const document of documents) {
      roots.add(document.body ?? document.documentElement);
      for (const shadow of collectShadowRoots(document)) roots.add(shadow);
    }

    for (const [root, observer] of [...this.observedRoots]) {
      if (roots.has(root)) continue;
      observer.disconnect();
      this.observedRoots.delete(root);
    }

    for (const root of roots) {
      if (this.observedRoots.has(root)) continue;
      try {
        const observer = new MutationObserver((records) => this.onMutations(records));
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        this.observedRoots.set(root, observer);
        this.observers.push(observer);
      } catch {
        // Documents without MutationObserver still translate the tree captured at start.
      }
    }

    this.bindKeys();
    for (const document of documents) this.bindPointerRoot(document);
    for (const document of documents) {
      for (const shadow of collectShadowRoots(document)) this.bindPointerRoot(shadow);
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
    const screens = lookaheadScreens(this.prefs.tier, this.prefs.pace);
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

function isBodyCopy(block: Element): boolean {
  return block.matches('p, li, blockquote, dd, figcaption');
}

/**
 * True when a block shows prose a reader would notice staying in the source language.
 *
 * `buildSegment` keeps a great deal of text out of a segment on purpose: citations and
 * pronunciation in frozen inlines, inline icon glyphs, screen-reader-only labels, and text
 * that is already in the target language. None of that is a coverage gap, so counting it
 * reported every Wikipedia article as "partial" — its interlanguage links, IPA cells and
 * ward names in Japanese are all source text the builder correctly leaves alone.
 */
function ownProse(block: Element, target: string | null): boolean {
  for (const child of block.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const value = child.nodeValue ?? '';
      if (value.trim().length > 0 && /\p{L}/u.test(value)) return true;
      continue;
    }
    if (!(child instanceof Element)) continue;
    if (isBlockElement(child)) continue;
    // Everything the segment builder drops from the source text. A <style> or <script>
    // inside a block is excluded the same way; its CSS is not prose the reader sees.
    if (isTranslationExcluded(child)) continue;
    if (isFrozenInline(child)) continue;
    if (isScreenReaderOnly(child)) continue;
    if (isAriaHiddenLeaf(child)) continue;
    if (target !== null && isAlreadyTargetLanguage(child, target, null)) continue;
    if (ownProse(child, target)) return true;
  }
  return false;
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
  const pieces = chunkForTranslation(source);
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
