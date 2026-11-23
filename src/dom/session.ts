import { hasTranslatableText } from '@/engine/text/sanitize';
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
import {
  chunkForTranslation,
  hasSentenceTerminator,
  joinTranslatedSentences,
  sentenceSpans,
} from '@/engine/text/sentences';
import { PriorityQueue } from '@/engine/queue/priority-queue';
import {
  isAbortError,
  isFolderPermissionError,
  isLocalServerError,
  isModelChangedError,
} from '@/engine/errors';
import type { EngineKind, GlossaryEntry, TranslateOptions, TranslationChunk } from '@/engine/types';
import { glossaryKey, mergeGlossary } from '@/shared/glossary';
import {
  chooseTargetLanguage,
  effectivePageTarget,
  isPlamoOnlyTarget,
  isTargetLanguage,
  type TargetLanguage,
} from '@/shared/languages';
import type { PageCommandName } from '@/shared/messages';
import {
  TRANSLATION_POPUP_SIZE_DEFAULT,
  TRANSLATION_POPUP_WIDTH_AUTO,
  type Formality,
  type PlainTextLineBreakMode,
  type Settings,
  type TranslationPace,
  type TranslationReveal,
} from '@/shared/settings';
import {
  applyPlainTextLineBreaks,
  plainTextSelectionSource,
  plainTextTranslationInput,
  type PlainTextBreakMap,
} from '@/shared/plain-text-line-breaks';
import { canonicalPageLanguage, isAlreadyTargetLanguage, languageOf } from './detect';
import {
  collectDocuments,
  collectShadowRoots,
  eachTranslatableBlock,
  focusedEditableField,
  isAriaHiddenLeaf,
  isBlockElement,
  isFrozenInline,
  isOwnUi,
  isScreenReaderOnly,
  isSubSuperscript,
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
  translationConcurrencyFor,
  translationPriority,
  type ContentKind,
  type VisibilityBand,
} from './priority';
import {
  applyTranslation,
  LINE_TAG,
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
import { REVEAL_STREAM_AFTER_MS, Revealer, type RevealKind } from './reveal';
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
/**
 * How many viewport blocks stream their tokens before their first sentence ends. Only
 * the first ones need the fast path: they are what a reader meets on arrival, and the
 * first painted word is all the page bench times. Holding the rest to whole sentences
 * keeps the height reservation from shifting a screenful of short labels as tokens
 * grow, which is what drove layout shift above the smooth-mode range.
 */
const FAST_VISIBLE_BLOCKS = 2;
/**
 * How long a fast-path block may keep decoded text back before writing it anyway, and how
 * many characters may pile up before a write. A clause boundary writes sooner than either.
 * The first tokens of a block are never held: first-visible text must not wait for this.
 */
const FAST_FLUSH_MS = 40;
const FAST_FLUSH_CHARS = 96;
/** Keyboard selections settle before inference, so a partial highlight does not occupy the model. */
const SELECTION_SETTLE_MS = 48;
/** A selectionchange that follows pointerup is the same gesture and should not wait out the keyboard delay. */
const POINTER_RELEASE_WINDOW_MS = 80;
/** Selections larger than this bound skip the already-translated check and prefetch. */
const MAX_SELECTION_SCAN_NODES = 512;
/**
 * Defensive deduplication for duplicate native command delivery. Toggle would otherwise
 * translate and immediately restore, which looks like the shortcut doing nothing.
 */
export const PAGE_SHORTCUT_DEDUP_MS = 200;

/**
 * True when the reader is typing in a field, where an unassigned Option+letter must type
 * rather than run a page command. Chrome-assigned commands still arrive through onCommand.
 */
function isTypingShortcutTarget(event: KeyboardEvent): boolean {
  const fromEvent = event.target instanceof Element ? event.target : null;
  const doc = event.view?.document ?? fromEvent?.ownerDocument ?? null;
  const field = focusedEditableField(fromEvent) ?? focusedEditableField(doc?.activeElement);
  if (!field) return false;
  return !isOwnUi(field);
}

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
  /** Percent text size for the hover, selection, and status popups. */
  popupSize?: number;
  /** Selection popup width in em at 100% scale; `0` or missing means automatic width. */
  popupWidth?: number;
  /** How source line breaks are reflected in a selection translation. Missing means `none`. */
  plainTextLineBreaks?: PlainTextLineBreakMode;
  /** How a finished page block appears in replace mode. Missing means `stream`. */
  reveal?: TranslationReveal;
  auto: SiteAuto;
  host: string;
  context: boolean;
  tier: 'g' | 'c8' | 'c4' | 'c1' | null;
  pace: TranslationPace;
  engineSource?: 'in-browser' | 'local-server';
  localServerParallel?: number;
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
  partError: boolean[];
  rect: DOMRect | null;
  batchToken: number;
  /** When the running request sent this block's first text, or null before that. */
  firstPieceAt: number | null;
  /** Unfinished text of this block has been written to the page. */
  streamed: boolean;
  /**
   * Highest text of each piece already written to the page in sentence reveal mode.
   * Indexed by piece, so a restart of one piece cannot erase sentences from another.
   */
  sentenceShownParts?: string[];
  /** When the fast path last flushed partial text of this block. */
  fastFlushAt?: number;
  /** Length of the partial text at that flush, for the character budget. */
  fastFlushLength?: number;
  /** Timer that re-paints a held fast-path write when its time budget expires. */
  fastFlushTimer?: ReturnType<typeof setTimeout> | undefined;
  /** When the text of this block last grew. */
  lastPieceAt: number;
  /** How many characters of source each piece of the running request has. */
  partSource: number[];
  /**
   * Whether each piece is translated by itself. A short one can share a request with other
   * lines, and such a request says it is finished only when all of its lines are.
   */
  partAlone: boolean[];
  /** Selection only: normalized source, its model input, and the break map. */
  plainSource?: string;
  plainBreakMap?: PlainTextBreakMap;
}

interface InflightBatch {
  controller: AbortController;
  items: Live[];
  priority: number;
  settled: boolean;
  /** The engine has sent this batch's first chunk, so the model is already decoding it. */
  streaming: boolean;
}

export interface PageSelectionSnapshot {
  text: string;
  rect: DOMRect;
}

type PageSelection = PageSelectionSnapshot & { range: Range | null };

/** Capture a document selection now; later awaits must not depend on it still existing. */
export function capturePageSelection(
  doc: Document,
  isOwnUi: (node: Node) => boolean = () => false,
): PageSelectionSnapshot | null {
  const selection = readPageSelection(doc, isOwnUi);
  return selection && { text: selection.text, rect: selection.rect };
}

function readPageSelection(doc: Document, isOwnUi: (node: Node) => boolean): PageSelection | null {
  for (const current of collectDocuments(doc)) {
    const selection = current.getSelection?.() ?? current.defaultView?.getSelection() ?? null;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) continue;
    const text = selection.toString().trim();
    if (text.length === 0 || !hasTranslatableText(text)) continue;
    const endpoint = selection.anchorNode ?? selection.focusNode;
    if (endpoint && isOwnUi(endpoint)) continue;
    // A field the reader is typing in reports its value as the document selection.
    if (isTypedTextSelection(current.activeElement, text)) continue;
    let range: Range;
    try {
      range = selection.getRangeAt(0);
    } catch {
      continue;
    }
    return {
      text,
      rect: selectionViewportRect(range, current, doc),
      range: selection.rangeCount === 1 ? range : null,
    };
  }
  return null;
}

export interface PageSessionOptions {
  engine: PageEngine;
  labels: OverlayLabels;
  preferences: SessionPreferences;
  scheduleFrame?: (callback: (time?: number) => void) => void;
  debounceMs?: number;
  onSitePatch?: (patch: {
    display?: 'replace' | 'bilingual';
    targetLanguage?: TargetLanguage;
    auto?: SiteAuto;
  }) => void | Promise<void>;
  /** Resolves true only after this site already has host access. */
  onGrantSite?: () => boolean | Promise<boolean>;
  /** True for the key the reader bound to the selection command. */
  selectionKey?: (event: KeyboardEvent) => boolean;
  /** Page translate / restore, used only under the all-sites grant when unassigned. */
  pageKey?: (event: KeyboardEvent) => boolean;
  /** Bilingual toggle, used only under the all-sites grant when unassigned. */
  bilingualKey?: (event: KeyboardEvent) => boolean;
  /**
   * Runs page commands from in-page shortcuts with the same gating and deduplication as
   * `commands.onCommand`. Without this, Alt+A and a Chrome command can both call `handle`.
   */
  onPageCommand?: (command: PageCommandName) => void;
  /** Saves a width chosen by dragging or keyboard, in em at 100% text scale. */
  onPopupWidth?: (widthEm: number) => void | Promise<void>;
  /** True only while the shared folder grant actually needs the reader to act. */
  folderGrantUiActive?: boolean;
  /** Opens the toolbar popup or a top-level grant window from the in-page hint. */
  onFolderEnable?: () => void;
}

export function preferencesFor(
  settings: Settings,
  rule: SiteRule,
  host: string,
): SessionPreferences {
  const glossary = mergeGlossary(settings.glossary, rule.glossary);
  return {
    targetLanguage: effectivePageTarget(settings.targetLanguage, rule.targetLanguage),
    // The saved global language is the reader's choice. A site language is only an
    // override when the site rule actually stores one, never because the page matched.
    targetExplicit: true,
    form: settings.form,
    display: rule.display ?? settings.display,
    popupSize: settings.translationPopupSize,
    popupWidth: settings.translationPopupWidth,
    plainTextLineBreaks: settings.plainTextLineBreaks,
    reveal: settings.translationReveal,
    auto: rule.auto,
    host,
    context: false,
    tier: null,
    pace: settings.pace,
    engineSource: settings.engineSource,
    localServerParallel: settings.localServerParallel,
    ...(glossary.length > 0 ? { glossary } : {}),
  };
}

export class PageSession {
  private readonly engine: PageEngine;
  private readonly overlay: PageOverlay;
  private readonly scheduleFrame: (callback: (time?: number) => void) => void;
  private readonly debounceMs: number;
  private readonly onSitePatch: PageSessionOptions['onSitePatch'];
  private readonly onGrantSite: PageSessionOptions['onGrantSite'];
  private readonly onPopupWidth: PageSessionOptions['onPopupWidth'];
  private readonly selectionKey: ((event: KeyboardEvent) => boolean) | undefined;
  private readonly pageKey: ((event: KeyboardEvent) => boolean) | undefined;
  private readonly bilingualKey: ((event: KeyboardEvent) => boolean) | undefined;
  private readonly onPageCommand: ((command: PageCommandName) => void) | undefined;
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
  /** Clear/forget report the reveal as settled before their replacement work is queued. */
  private revealChanging = 0;
  private revealSettled = false;
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
  /** Quiet on hosts the reader turned Sakutto off for, until an explicit action arrives. */
  private selectionOffersSuppressed = false;
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
  /** Set when a local-server request fails, so the bar can keep the Settings hint. */
  private serverFault = false;
  private folderPermissionFault = false;
  /** Set when the active model is deleted, so the bar stops counting unfinished work. */
  private modelMissingFault = false;
  private folderGrantUiActive: boolean;
  private readonly onFolderEnable: (() => void) | undefined;
  private selectionGrantTimer: ReturnType<typeof setTimeout> | null = null;
  private historyUnpatch: (() => void) | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private direction: 'down' | 'up' = 'down';
  private lastScroll = 0;
  private dirty = new Set<Live>();
  private readonly revealer: Revealer;
  /** The finished text each block shows, so that writing it again is not shown as a change. */
  private readonly shown = new WeakMap<Element, string>();
  /** How long translations on this page have been for their source; null before the first. */
  private outputRatio: number | null = null;
  /** Characters of translation one request gets in a millisecond; null before the first. */
  private pace: number | null = null;
  /** Lines that were finished before their request ended, with the request they were in. */
  private readonly endedEarly = new WeakMap<Live, number>();
  /** The block the latest piece of text was for, and when it came. */
  private pieceFor: Live | null = null;
  private pieceAt = 0;
  /** When text last came for another block than the one the latest piece was for. */
  private otherPieceAt = 0;
  private frameQueued = false;
  private paintGeneration = 0;
  private startedAt = 0;
  /** When the first engine request of this run was sent. */
  private firstRequestAt: number | null = null;
  /** When the first decoded token of this run arrived from the engine. */
  private firstTokenAt: number | null = null;
  /** When translated text was first written into a page block in this run. */
  private firstDomWriteAt: number | null = null;
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
  private readonly onPageShow: (event: PageTransitionEvent) => void;
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
  private lastShortcutCommand: 'toggle' | 'bilingual' | 'selection' | null = null;
  private lastShortcutAt = 0;

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
    this.onPopupWidth = options.onPopupWidth;
    this.selectionKey = options.selectionKey;
    this.pageKey = options.pageKey;
    this.bilingualKey = options.bilingualKey;
    this.onPageCommand = options.onPageCommand;
    this.folderGrantUiActive = options.folderGrantUiActive === true;
    this.onFolderEnable = options.onFolderEnable;
    this.scheduleFrame =
      options.scheduleFrame ??
      ((callback) => {
        const view = this.doc.defaultView;
        if (view) view.requestAnimationFrame((time) => callback(time));
        else callback();
      });
    this.overlay = new PageOverlay(doc, options.labels);
    this.revealer = new Revealer(doc, {
      now: () => performance.now(),
      frame: (callback) => this.scheduleFrame(callback),
      later: (ms, callback) => {
        (this.doc.defaultView ?? globalThis).setTimeout(callback, ms);
      },
      settled: () => {
        if (this.active) this.publishState();
        if (this.revealChanging > 0) {
          this.revealSettled = true;
          return;
        }
        this.resolveIdle();
      },
    });
    this.overlay.setPopupTextScale(this.prefs.popupSize ?? TRANSLATION_POPUP_SIZE_DEFAULT);
    this.overlay.setPopupWidth(this.prefs.popupWidth ?? TRANSLATION_POPUP_WIDTH_AUTO);
    this.overlay.setOnPopupWidth((width) => {
      this.prefs = { ...this.prefs, popupWidth: width };
      void this.onPopupWidth?.(width);
    });
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
        // A completion the model is decoding runs to its end even when aborted, so the
        // batch it belongs to finishes and paints. Batches still waiting give the engine back.
        // Hidden before the first chunk (still prefilling) aborts the batch and discards
        // that completion's output.
        this.abortBatches((batch) => !batch.streaming, true);
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
    this.onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      this.navigating = false;
      if (this.active) this.scheduleScan();
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
      if (!(event instanceof KeyboardEvent) || event.repeat || event.isComposing) return;
      if (event.key === 'Escape') {
        this.overlay.hideOriginal();
        if (!this.selection && !this.overlay.selectionIconVisible()) return;
        event.preventDefault();
        event.stopPropagation();
        this.dismissSelection();
        return;
      }
      // In-page fallback (unassigned commands): skip when a field is focused so Option+letter
      // can type. Chrome-assigned commands still run via onCommand inside fields.
      if (this.pageKey?.(event)) {
        if (isTypingShortcutTarget(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.onPageCommand) this.onPageCommand('toggle');
        else void this.handle('toggle');
        return;
      }
      if (this.bilingualKey?.(event)) {
        if (isTypingShortcutTarget(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.onPageCommand) this.onPageCommand('bilingual');
        else void this.handle('bilingual');
        return;
      }
      if (!this.selectionKey?.(event)) return;
      if (isTypingShortcutTarget(event)) return;
      const selected = this.readSelection();
      if (!selected) return;
      event.preventDefault();
      event.stopPropagation();
      if (this.onPageCommand) this.onPageCommand('selection');
      else this.translateSelection(selected.text, selected.rect);
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
    this.doc.defaultView?.addEventListener('pageshow', this.onPageShow);
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

  /** Called when the engine status says whether the shared folder grant needs action. */
  setFolderGrantUiActive(active: boolean): void {
    if (this.folderGrantUiActive === active) return;
    this.folderGrantUiActive = active;
    if (active) {
      this.publishState();
      return;
    }
    this.folderPermissionFault = false;
    if (this.selectionGrantTimer !== null) {
      clearTimeout(this.selectionGrantTimer);
      this.selectionGrantTimer = null;
    }
    this.overlay.hideFolderEnable();
    this.publishState();
  }

  setPreferences(next: SessionPreferences): void {
    const previous = this.prefs;
    const tier = next.tier ?? previous.tier;
    this.prefs = { ...next, tier };
    if (
      lookaheadScreens(previous.tier, previous.pace, previous.engineSource) !==
      lookaheadScreens(tier, this.prefs.pace, this.prefs.engineSource)
    ) {
      this.bindVisibility();
    }
    if (next.display !== previous.display) this.repaintAll();
    else if (next.reveal !== previous.reveal) this.revealer.flush();
    if (
      (next.popupSize ?? TRANSLATION_POPUP_SIZE_DEFAULT) !==
      (previous.popupSize ?? TRANSLATION_POPUP_SIZE_DEFAULT)
    ) {
      this.overlay.setPopupTextScale(this.prefs.popupSize ?? TRANSLATION_POPUP_SIZE_DEFAULT);
    }
    if (
      (next.popupWidth ?? TRANSLATION_POPUP_WIDTH_AUTO) !==
      (previous.popupWidth ?? TRANSLATION_POPUP_WIDTH_AUTO)
    ) {
      this.overlay.setPopupWidth(this.prefs.popupWidth ?? TRANSLATION_POPUP_WIDTH_AUTO);
    }
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

  setTier(tier: 'g' | 'c8' | 'c4' | 'c1' | null): void {
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
      pending:
        tracked.filter((item) => item.state === 'queued' || item.state === 'running').length +
        this.revealer.finished,
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
        !isPlamoOnlyTarget(this.prefs.targetLanguage) &&
        pageLanguage === canonicalPageLanguage(this.prefs.targetLanguage),
      tokensPerSecond: rates.tokensPerSecond,
      segmentsPerSecond: rates.segmentsPerSecond,
      skipped: this.active ? this.skippedProse() : 0,
    };
  }

  async handle(
    command: 'toggle' | 'restore' | 'bilingual' | 'selection' | 'compose',
  ): Promise<void> {
    if (command === 'toggle' || command === 'bilingual' || command === 'selection') {
      const now = Date.now();
      if (
        this.lastShortcutCommand === command &&
        now - this.lastShortcutAt < PAGE_SHORTCUT_DEDUP_MS
      ) {
        return;
      }
      this.lastShortcutCommand = command;
      this.lastShortcutAt = now;
    }
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
      case 'compose':
        // Handled by ComposeController in the content script, which owns the focused field.
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
    if (this.prefs.reveal === 'smooth') this.revealer.prime();
    this.serverFault = false;
    this.folderPermissionFault = false;
    this.modelMissingFault = false;
    this.navigating = false;
    this.sweepLegacyNotes();
    this.startedAt = performance.now();
    this.firstTextAt = null;
    this.firstRequestAt = null;
    this.firstTokenAt = null;
    this.firstDomWriteAt = null;
    this.samples = [];
    this.throughputSamples = [{ atMs: this.startedAt, tokens: 0, segments: 0 }];
    this.heldRates = { tokensPerSecond: null, segmentsPerSecond: null };
    this.heldTokensAt = 0;
    this.heldSegmentsAt = 0;
    this.work = { batches: 0, pieces: 0, engineMs: 0 };
    // Create the hook now rather than at the first completion: the first request, token and
    // DOM write all happen long before a block finishes on a slow engine, and the bench
    // reads this element to break the first-visible time down.
    this.ensurePerf();
    this.writePerf();
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
    this.serverFault = false;
    this.folderPermissionFault = false;
    this.modelMissingFault = false;
    this.overlay.hideFolderEnable();
    this.targetAdjusted = false;
    const source = this.doc.documentElement.getAttribute('data-sakutto-source-lang');
    if (source !== null) {
      this.doc.documentElement.lang = source;
      this.doc.documentElement.removeAttribute('data-sakutto-source-lang');
    }
    this.revealer.clear();
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
    const mode = this.prefs.plainTextLineBreaks ?? 'none';
    // `none` is the historical path: trim the ends but keep the reader's internal
    // spacing exactly as the engine used to receive it. Other modes normalize first so
    // the same snapshot can be mapped back onto translated sentence boundaries.
    const source = plainTextSelectionSource(text, mode);
    if (source.length === 0) return;
    this.navigating = false;
    this.overlay.hideOriginal();
    const anchor = rect ?? new DOMRect(16, 16, 0, 0);
    const current = this.selection;
    if (
      current?.plainSource === source &&
      (current.state === 'queued' || current.state === 'running' || current.state === 'done')
    ) {
      current.rect = anchor;
      if (reveal) this.revealSelection();
      return;
    }

    this.queue.remove((item) => item.role === 'selection' && item.state !== 'running');
    const { engineText, breakMap } = plainTextTranslationInput(source, mode);
    const next = this.createSelection(source, engineText, breakMap, anchor);
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
    if (reveal && this.folderGrantUiActive) {
      if (this.selectionGrantTimer !== null) clearTimeout(this.selectionGrantTimer);
      this.selectionGrantTimer = setTimeout(() => {
        this.selectionGrantTimer = null;
        if (!this.folderGrantUiActive) return;
        const current = this.selection;
        if (!current || current.state === 'done') return;
        if (current.translation.trim().length > 0) return;
        if (current.state !== 'queued' && current.state !== 'running') return;
        this.beginFolderGrantWait();
      }, 12_000);
    }
  }

  translateDocumentSelection(): void {
    const selected = this.readSelection();
    if (!selected) return;
    this.translateSelection(selected.text, selected.rect);
  }

  private readSelection(): PageSelection | null {
    return readPageSelection(this.doc, (node) => this.overlay.contains(node));
  }

  /**
   * Start inference when the highlight stops moving unless the selection is already translated.
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
    if (this.selectionOffersSuppressed) return;
    if (this.navigating || this.doc.hidden || this.pointerDown) return;
    const selected = this.readSelection();
    if (!selected) {
      this.overlay.hideSelectionIcon();
      if (!this.selectionShown && this.selection) this.dismissSelection();
      return;
    }
    const source = plainTextSelectionSource(
      selected.text,
      this.prefs.plainTextLineBreaks ?? 'none',
    );
    if (this.selectionShown && this.selection?.plainSource === source) {
      this.selection.rect = selected.rect;
      this.overlay.hideSelectionIcon();
      this.overlay.moveSelection(selected.rect);
      return;
    }
    const prefetch = selected.range === null || this.shouldPrefetchRange(selected.range);
    if (
      this.selectionShown ||
      (!prefetch && this.selection && this.selection.plainSource !== source)
    ) {
      this.dismissSelection();
    }
    this.overlay.showSelectionIcon(selected.rect);
    if (prefetch) this.translateSelection(selected.text, selected.rect, false);
  }

  /**
   * Offers a selection that already existed when this script initialized, once. A highlight
   * made before the listeners were bound never fires `selectionchange` here, so the first
   * check re-reads the document. One offer, no loop; the page is never translated by it.
   */
  offerExistingSelection(): void {
    this.offerSelection();
  }

  /**
   * The passive all-sites injection stays quiet on a host whose rule is `never`: the
   * selection button returns only after an explicit popup or command reached this page.
   */
  setSelectionOffersSuppressed(suppressed: boolean): void {
    if (this.selectionOffersSuppressed === suppressed) return;
    this.selectionOffersSuppressed = suppressed;
    if (suppressed) this.overlay.hideSelectionIcon();
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
        // The failure notice is not a translation; the copy control stays off for it.
        true,
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
  noteFolderPermission(): void {
    this.folderPermissionFault = true;
    this.beginFolderGrantWait();
  }

  /**
   * The active model file was deleted while this page was translating. Abort every batch and
   * retire queued work so the bar cannot keep counting blocks that can never finish, then
   * leave a short no-model message in its place.
   */
  noteModelMissing(): void {
    if (!this.active) return;
    this.modelMissingFault = true;
    this.pageController?.abort();
    this.pageController = null;
    this.queue.clear();
    this.abortRunning(false);
    // Queued items were removed from the queue but still hold their old state. Retire them
    // too, otherwise the view keeps counting work that will never start.
    for (const item of this.live.values()) {
      if (item.state !== 'queued') continue;
      item.state = 'idle';
      item.partText = [];
      item.partFinal = [];
      item.partError = [];
      item.model?.block.removeAttribute('data-sakutto-pending');
    }
    this.selection = null;
    this.selectionShown = false;
    this.clearSelectionOffer();
    this.overlay.hideSelection();
    this.overlay.hideSelectionIcon();
    this.overlay.hideOriginal();
    this.publishState();
  }

  beginFolderGrantWait(): void {
    if (!this.folderGrantUiActive || this.overlay.folderEnableVisible()) return;
    this.overlay.showFolderEnable(this.onFolderEnable);
    if (this.selectionShown) {
      this.overlay.hideSelection();
      this.selectionShown = false;
    }
    this.publishState();
  }

  endFolderGrantWait(): void {
    this.folderPermissionFault = false;
    this.overlay.hideFolderEnable();
    if (this.selectionGrantTimer !== null) {
      clearTimeout(this.selectionGrantTimer);
      this.selectionGrantTimer = null;
    }
    this.retryUntranslated();
    this.publishState();
  }

  retryUntranslated(): void {
    this.folderPermissionFault = false;
    this.modelMissingFault = false;
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
    this.doc.defaultView?.removeEventListener('pageshow', this.onPageShow);
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

    const model = buildSegment(block);
    if (
      isAlreadyTargetLanguage(
        block,
        this.prefs.targetLanguage,
        this.detectedLanguage,
        model?.source ?? '',
      )
    ) {
      return;
    }

    if (!model) {
      // A container whose only text belongs to nested blocks is covered by those blocks.
      // Reporting it would turn every page with a menu or a form into a partial result.
      if (
        ownProse(
          block,
          isPlamoOnlyTarget(this.prefs.targetLanguage)
            ? null
            : canonicalPageLanguage(this.prefs.targetLanguage),
        )
      ) {
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
      lang: languageOf(block, this.detectedLanguage, model.source),
      index,
      band: bandForRect(block.getBoundingClientRect(), viewportHeight(block)),
      state: 'idle',
      translation: '',
      engine: null,
      created: [],
      originalChildren: [...block.childNodes],
      partText: [],
      partFinal: [],
      partError: [],
      rect: null,
      batchToken: 0,
      firstPieceAt: null,
      streamed: false,
      lastPieceAt: 0,
      partSource: [],
      partAlone: [],
    };

    this.live.set(item.id, item);
    this.liveByBlock.set(block, item);
    this.observeBlock(block);
    this.enqueue(item);
  }

  private createSelection(
    source: string,
    engineText: string,
    breakMap: PlainTextBreakMap | null,
    rect: DOMRect,
  ): Live {
    return {
      id: this.allocateId(),
      role: 'selection',
      model: null,
      source: engineText,
      plain: engineText,
      plainSource: source,
      ...(breakMap ? { plainBreakMap: breakMap } : {}),
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
      partError: [],
      rect,
      batchToken: 0,
      firstPieceAt: null,
      streamed: false,
      lastPieceAt: 0,
      partSource: [],
      partAlone: [],
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
    this.abortBatches((batch) => batch.priority <= 0, false);
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
    if (this.modelMissingFault) return;
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
    if (this.modelMissingFault) {
      this.resolveIdle();
      return;
    }
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

    const concurrency = translationConcurrencyFor(
      this.prefs.tier,
      this.prefs.engineSource,
      this.prefs.localServerParallel,
    );
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
    const entry: InflightBatch = {
      controller,
      items: batch,
      priority,
      settled: false,
      streaming: false,
    };
    this.inflightBatches.add(entry);
    this.running += 1;
    void this.runBatch(entry).finally(() => {
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

  private async runBatch(entry: InflightBatch): Promise<void> {
    const { controller, items: batch, priority } = entry;
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
        // The source is still on the page here, so measure its box once and hold that
        // height before the first token arrives. On screen, sentence mode then writes
        // tokens as they decode without moving whatever sits under the block.
        if (this.prefs.reveal === 'sentence' && item.band === 'visible') {
          this.revealer.reserve(item.model.block);
        }
      }
      item.firstPieceAt = null;
      delete item.fastFlushAt;
      delete item.fastFlushLength;
      const pieces = expandSource(item);
      item.partSource = pieces.map((piece) => piece.text.length);
      item.partAlone = pieces.map(
        (piece) => piece.text.includes('\n') || estimateTokens(piece.text) > PACK_SEGMENT_TOKENS,
      );
      const preserve = item.failures > 0 && item.partText.length === pieces.length;
      item.partFinal = pieces.map((_, index) =>
        preserve ? item.partFinal[index] === true : false,
      );
      item.partError = pieces.map((_, index) =>
        preserve ? item.partError[index] === true : false,
      );
      if (preserve) {
        // A retry restarts unfinished pieces, so their half-decoded text must go;
        // otherwise attempt two appends onto the fragment attempt one left behind.
        item.partText = pieces.map((_, index) =>
          item.partFinal[index] === true ? (item.partText[index] ?? '') : '',
        );
        // The matching high-water marks must go too: a retry's first clause is not an
        // extension of the failed attempt's fragment and would otherwise be rejected
        // until the final settle, leaving the stale fragment on the page.
        this.keepFinalShownParts(item);
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
    if (this.firstRequestAt === null) {
      this.firstRequestAt = engineStarted;
      this.writePerf();
    }
    let abortedByEngine = false;

    try {
      for await (const chunk of this.engine.translate(
        requests,
        this.optionsFor(batch, priority, signal),
      )) {
        if (signal.aborted) return;
        entry.streaming = true;
        const item = owners.get(chunk.id);
        if (!item || item.batchToken !== token) continue;
        const index = partIndex(chunk.id);
        if (item.state !== 'running') {
          // A line that was finished when the next line of its request began. The request
          // answers for it now; that answer counts where it says something else.
          if (chunk.final !== undefined && this.endedEarly.get(item) === token) {
            this.correctLine(item, chunk.final, chunk.error === true, token, signal);
          }
          continue;
        }
        if (chunk.engine) item.engine = chunk.engine;
        if (chunk.textDelta !== undefined) {
          const before = chunk.restart === true ? '' : (item.partText[index] ?? '');
          item.partText[index] = before + chunk.textDelta;
          if (item.firstPieceAt === null && chunk.textDelta.length > 0) {
            this.endLineBefore(batch, item, token);
          }
          item.firstPieceAt ??= performance.now();
          if (chunk.textDelta.length > 0) {
            if (this.firstTokenAt === null) {
              this.firstTokenAt = performance.now();
              this.writePerf();
            }
            item.lastPieceAt = performance.now();
            if (this.pieceFor !== item) {
              this.otherPieceAt = this.pieceAt;
              this.pieceFor = item;
            }
            this.pieceAt = item.lastPieceAt;
          }
          // Text that is kept back needs no frame.
          if (this.holdsBack(item)) this.noteLiveRate();
          else this.queuePaint(item);
        }
        if (chunk.final !== undefined) {
          item.partText[index] = chunk.final;
          item.partFinal[index] = true;
          if (chunk.error === true) item.partError[index] = true;
          if (item.partFinal.every(Boolean)) {
            this.notePace(item);
            if (item.partError.length > 0 && item.partError.every(Boolean)) {
              this.markUntranslated(item, signal);
            } else {
              this.complete(item);
            }
          } else if (this.holdsBack(item)) this.noteLiveRate();
          else this.queuePaint(item);
        }
      }
    } catch (error) {
      // Unfinished blocks are retried below. Abort keeps the previous text.
      if (isAbortError(error)) {
        abortedByEngine = true;
      } else if (isModelChangedError(error)) {
        for (const item of batch) {
          if (item.batchToken !== token || item.state !== 'running') continue;
          this.discardUnfinishedPaint(item);
        }
      } else if (!signal.aborted && isLocalServerError(error)) {
        this.serverFault = true;
        if (this.labels.engineFailed) this.overlay.showStatus(this.labels.engineFailed);
      } else if (!signal.aborted && isFolderPermissionError(error)) {
        this.noteFolderPermission();
      }
    } finally {
      this.work.engineMs += Math.round(performance.now() - engineStarted);
      // The last `complete()` of this batch already ran inside the loop above, before this
      // time was added, so the payload has to be rewritten once the batch's cost is known.
      this.writePerf();
      const sessionStopped = this.pageController?.signal.aborted === true;
      for (const item of batch) {
        if (item.batchToken !== token || item.state !== 'running') {
          if (item.batchToken === token) this.showSelectionFailure(item, signal);
          continue;
        }
        if (signal.aborted && (sessionStopped || !abortedByEngine)) {
          item.state = item.translation.length > 0 ? 'done' : 'idle';
          item.model?.block.removeAttribute('data-sakutto-pending');
          this.showSelectionFailure(item, signal);
          continue;
        }
        if (abortedByEngine && !sessionStopped && item.role === 'page') {
          // Caption preemption (and other engine aborts) must not burn page retries.
          item.state = 'idle';
          this.enqueue(item, true);
          continue;
        }
        if (signal.aborted) {
          item.state = item.translation.length > 0 ? 'done' : 'idle';
          item.model?.block.removeAttribute('data-sakutto-pending');
          this.showSelectionFailure(item, signal);
          continue;
        }
        if (this.folderPermissionFault) {
          item.state = 'idle';
          item.model?.block.removeAttribute('data-sakutto-pending');
          if (item.role === 'selection' && item === this.selection) {
            this.beginFolderGrantWait();
          }
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
   * A retry answers every unfinished piece afresh. Keep only the high-water marks of
   * pieces that finished: an old mark would reject the replacement's partials and hold
   * the previous attempt's fragment on the page until the final settle. A fast-path
   * flush queued for that fragment belongs to the discarded attempt as well.
   */
  private keepFinalShownParts(item: Live): void {
    this.cancelFastFlush(item);
    const shown = item.sentenceShownParts;
    if (!shown) return;
    const kept = shown.map((text, index) => (item.partFinal[index] === true ? text : ''));
    if (kept.some((text) => text.length > 0)) item.sentenceShownParts = kept;
    else delete item.sentenceShownParts;
  }

  /**
   * Drop half-decoded fragments as soon as the host reports a model change. Finished
   * pieces stay; they were cached under the previous model id. Unfinished paint is
   * restored immediately so the page does not keep showing "こん" until the retry.
   */
  private discardUnfinishedPaint(item: Live): void {
    const pieces = expandSource(item);
    item.partText = pieces.map((_, index) =>
      item.partFinal[index] === true ? (item.partText[index] ?? '') : '',
    );
    // A shown clause/token fragment is not a finished sentence. Leaving its high-water
    // mark would make the repaint re-write it and reject every retry partial whose text
    // does not extend that fragment, freezing the block until the final settle.
    delete item.sentenceShownParts;
    this.cancelFastFlush(item);
    this.dirty.delete(item);
    if (item.partFinal.some(Boolean) && item.partText.some((part) => part.trim().length > 0)) {
      this.paint(item, true);
      return;
    }
    if (item.model) this.resetLive(item);
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
      if (item.model) {
        const block = item.model.block;
        this.changingReveal(() => {
          this.resetLive(item);
          // The optimistic partial text is gone now: record the source the reader sees,
          // otherwise skippedProse() mistakes the restored block for a page replacement.
          this.skippedBlocks.set(block, block.textContent ?? '');
        });
      }
      item.state = 'done';
      item.translation = '';
      item.partText = [];
      item.partFinal = [];
      item.partError = [];
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

  /**
   * A piece whose CPU retry was also collapsed keeps its source text. That is
   * not a translation, so the block is counted like any other failed job and
   * the bar uses `pagePartial` / selectionFailed.
   */
  private markUntranslated(item: Live, signal: AbortSignal): void {
    if (item.role === 'page' && item.model) {
      const block = item.model.block;
      this.changingReveal(() => {
        this.resetLive(item);
        // Capture the restored source, not the optimistic translation that may have
        // been painted before the request reported its error.
        this.skippedBlocks.set(block, block.textContent ?? '');
      });
    }
    item.state = 'done';
    item.translation = '';
    item.partText = [];
    item.partFinal = [];
    item.partError = [];
    item.engine = null;
    item.model?.block.removeAttribute('data-sakutto-pending');
    this.showSelectionFailure(item, signal);
    this.publishState();
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
      // The failure notice is not a translation; the copy control stays off for it.
      true,
    );
  }

  private complete(item: Live): void {
    if (item.role === 'page' && !this.active) return;
    const joined = joinTranslatedSentences(
      item.partText.map((part) => part.trim()).filter((part) => part.length > 0),
      this.prefs.targetLanguage,
    );
    let translated = joined.length > 0 ? joined : item.partText.join('');
    if (item.role === 'selection' && item.plainBreakMap) {
      translated = applyPlainTextLineBreaks(
        item.plainBreakMap.modelText,
        translated,
        item.plainBreakMap,
        this.prefs.plainTextLineBreaks ?? 'none',
      );
    }
    const markup = this.acceptTranslation(item, translated);
    if (markup === 'retry') return;
    if (item.role === 'page' && item.source.length >= 40) {
      const ratio = translated.length / item.source.length;
      this.outputRatio = this.outputRatio === null ? ratio : this.outputRatio * 0.8 + ratio * 0.2;
    }
    item.translation = markup;
    item.state = 'done';
    if (item.translation.trim().length > 0) this.paint(item, false);
    else item.model?.block.removeAttribute('data-sakutto-pending');
    // Whatever was or was not painted, the block is no longer filling in.
    if (item.model) this.revealer.release(item.model.block);
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
      item.partError = [];
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

  /**
   * Background tabs do not run requestAnimationFrame, so a block that finishes
   * while hidden is painted when the tab returns.
   */
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

  /**
   * A write held back by the fast-path budget needs a wake-up of its own: if the decoder
   * stalls, no later chunk queues a paint and decoded text would stay hidden past the
   * budget. A timer, rather than only a frame, also runs in a background tab.
   */
  private scheduleFastFlush(item: Live): void {
    if (item.fastFlushTimer !== undefined) return;
    const generation = this.paintGeneration;
    const age = performance.now() - (item.fastFlushAt ?? item.firstPieceAt ?? performance.now());
    item.fastFlushTimer = (this.doc.defaultView ?? globalThis).setTimeout(
      () => {
        item.fastFlushTimer = undefined;
        if (generation !== this.paintGeneration || !this.active) return;
        if (item.state !== 'running' && item.state !== 'queued') return;
        this.paint(item, true);
      },
      Math.max(0, FAST_FLUSH_MS - age),
    );
  }

  private cancelFastFlush(item: Live): void {
    if (item.fastFlushTimer === undefined) return;
    clearTimeout(item.fastFlushTimer);
    item.fastFlushTimer = undefined;
  }

  /**
   * `direct` writes a finished translation at once. It is for text the reader has already
   * seen, such as a repaint after the display mode changed.
   */
  private paint(item: Live, partial: boolean, direct = false): void {
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
    if (!direct && this.prefs.reveal === 'sentence') {
      const instant = this.firstOnScreen(item);
      if (partial && this.fastVisible(item)) {
        // On screen the reader is watching the block. Write decoded text into its
        // reserved box at clause boundaries (or on the decode budget) instead of waiting
        // for a sentence terminator: a long first sentence made the first visible word
        // slower than stream mode. We are already in a paint frame here, so no extra
        // frame stands before first paint.
        this.paintVisibleTokens(item, model, bilingual);
        return;
      }
      if (partial) {
        if (this.paintSentences(item, model, bilingual)) return;
      } else if (item.streamed) {
        // Sentence writes create the bilingual line while the reader is already
        // reading it. Fading the block at the final settle would fade that line
        // through its ancestor, so release the reservation and write without a
        // focus animation. Only a line created by this final write is new.
        const hadLine = bilingual && model.block.querySelector(':scope > sakutto-line') !== null;
        const added = bilingual
          ? () => model.block.querySelector(':scope > sakutto-line')
          : undefined;
        const fast = this.fastVisible(item);
        // The first body paragraph has already painted many times into its reservation.
        // Dropping its motion entirely would make settle() measure and glide the whole
        // screen; keep the cheap in-place fade. Other first blocks keep the instant settle.
        const motion =
          (bilingual && hadLine) || (instant && !fast)
            ? undefined
            : {
                kind: revealKind(item),
                ...(added ? { added } : {}),
                // The above-fold path only needs a cheap fade at the end. It has
                // already painted many times, so no glide/blur is worth the cost.
                ...(fast ? { cheap: true } : {}),
              };
        this.revealer.settle(
          model.block,
          () => this.write(item, model, text, false, bilingual),
          motion,
        );
        return;
      } else if (!instant && this.shown.get(model.block) !== shownAs(text, bilingual)) {
        this.offerReveal(item, model, text, bilingual);
        return;
      }
    } else if (!direct && this.prefs.reveal === 'smooth') {
      if (partial) {
        if (!item.streamed) {
          // The block keeps its source until its translation is finished, unless that takes
          // so long that the reader would be left without any sign of progress.
          if (this.holdsBack(item)) return;
          if (!bilingual) {
            this.offerStream(item, model);
            return;
          }
        }
      } else if (item.streamed) {
        if (!bilingual) {
          this.revealer.settle(model.block, () => {
            this.write(item, model, text, false, false);
          });
          return;
        }
      } else if (this.shown.get(model.block) !== shownAs(text, bilingual)) {
        this.offerReveal(item, model, text, bilingual);
        return;
      }
    }
    this.write(item, model, text, partial, bilingual);
  }

  /**
   * Whether a page block is body copy inside the viewport and can show text as it decodes.
   * A heading is 'prose' to the segment builder, but it is not a paragraph a reader waits
   * to read: counting it here used to spend the whole two-block budget on a title and a
   * byline, leaving a long first paragraph in sentence mode. Below the fold sentence mode
   * still writes one finished sentence at a time, so a scroll never reveals a half-written
   * sentence.
   */
  private fastVisible(item: Live): boolean {
    if (item.role !== 'page' || item.band !== 'visible' || item.kind !== 'prose' || item.heading) {
      return false;
    }
    let ahead = 0;
    for (const other of this.live.values()) {
      if (other === item || other.role !== 'page' || other.band !== 'visible') continue;
      if (other.kind !== 'prose' || other.heading || other.index >= item.index) continue;
      ahead += 1;
      if (ahead >= FAST_VISIBLE_BLOCKS) return false;
    }
    return true;
  }

  /**
   * Writes partial text decoded so far into a visible block, without waiting for its first
   * sentence to end. The height was reserved when the request started, so the text under
   * the block stays where it was. This is called from a paint frame, the same frame stream
   * mode uses for its first write.
   *
   * The first text of a block is never held back. After that, a write waits for a clause
   * boundary, a short decode budget or a character budget: a model that emits one token
   * per frame must not make the reserved box relayout on every token, but a long first
   * sentence must not keep the reader waiting for its terminator either.
   */
  private paintVisibleTokens(item: Live, model: SegmentModel, bilingual: boolean): void {
    // Unlike partialText(), which drops empty pieces, this reads pieces in order and
    // stops at the first one that has not started: a later piece may never appear
    // before the one before it. Unfinished text is kept, so the first visible tokens
    // still arrive as early as stream mode's.
    const parts = visiblePartialParts(item);
    const advanced = extendShownParts(parts, item.sentenceShownParts);
    if (advanced === null) return;
    const text = joinTranslatedSentences(advanced.parts, this.prefs.targetLanguage);
    if (text.trim().length === 0) return;
    if (item.streamed && !this.fastFlushDue(item, text)) {
      this.scheduleFastFlush(item);
      return;
    }
    this.cancelFastFlush(item);
    if (!item.streamed) {
      this.claim(item, model);
      this.revealer.reserve(model.block);
    }
    // Only advance the high-water mark when the text really goes to the page. A write
    // held back by the budget is recomputed from the pieces on the next paint frame.
    item.sentenceShownParts = advanced.shown;
    item.fastFlushAt = performance.now();
    item.fastFlushLength = text.length;
    this.write(item, model, text, true, bilingual);
  }

  /** Whether a held-back fast-path write is due now. */
  private fastFlushDue(item: Live, text: string): boolean {
    if (endsOnClause(text)) return true;
    const now = performance.now();
    if (now - (item.fastFlushAt ?? item.firstPieceAt ?? now) >= FAST_FLUSH_MS) return true;
    return text.length - (item.fastFlushLength ?? 0) >= FAST_FLUSH_CHARS;
  }

  /**
   * Whether this is the first readable page block on the screen at the moment. A heading
   * above the lead paragraph must not give it the full settle motion: on a page with a
   * headline in the header that glide moved a screenful of markers and pushed CLS up.
   */
  private firstOnScreen(item: Live): boolean {
    if (item.role !== 'page' || item.band !== 'visible') return false;
    for (const other of this.live.values()) {
      if (
        other !== item &&
        other.role === 'page' &&
        other.band === 'visible' &&
        !other.heading &&
        other.index < item.index
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Sentence mode: writes the sentences of `text` that are finished, one frame at a time.
   * The block keeps its height from the first sentence until the final settle, so nothing
   * under it moves while the reader watches the translation arrive. Returns true when this
   * chunk has been dealt with.
   */
  private paintSentences(item: Live, model: SegmentModel, bilingual: boolean): boolean {
    // Split each piece on its own: a terminator in a later piece may not close an
    // unfinished sentence in an earlier one, and a piece that has not started yet may
    // not be skipped. Pieces are translated in order and must appear in that order.
    const parts = finishedSentenceParts(
      item.partText.map((part) => stripPlaceholderTokens(part)),
      item.partFinal,
      this.prefs.targetLanguage,
    );
    // Once a sentence is on the page, an unfinished tail must not be written over it.
    // Neither may a restart's shorter prefix replace sentences already shown: each
    // piece keeps the longest prefix the reader has seen until the final settle.
    const advanced = extendShownParts(parts, item.sentenceShownParts);
    if (advanced === null) return true;
    const ready = joinTranslatedSentences(advanced.parts, this.prefs.targetLanguage);
    if (ready.length === 0) return true;
    if (item.sentenceShownParts === undefined) {
      this.claim(item, model);
      this.revealer.reserve(model.block);
    }
    item.sentenceShownParts = advanced.shown;
    const generation = this.paintGeneration;
    const write = (): void => {
      if (generation !== this.paintGeneration || !this.active) return;
      if (item.model !== model || !model.block.isConnected) return;
      if (item.state !== 'running' && item.state !== 'queued') return;
      if (ready.trim().length === 0) return;
      this.write(item, model, ready, true, bilingual);
    };
    // The paragraph the reader is looking at first is written at once. The rest share the
    // next frame, as the other page writes do.
    if (this.firstOnScreen(item)) write();
    else {
      this.revealer.offer({
        block: model.block,
        kind: revealKind(item),
        keepHeight: true,
        instant: true,
        apply: write,
      });
    }
    return true;
  }

  /** Whether an unfinished translation of this block stays unseen for now. */
  private holdsBack(item: Live): boolean {
    if (this.prefs.reveal !== 'smooth' || item.role !== 'page' || item.streamed) return false;
    // A line under the source is added when it is finished, however long that takes: the
    // source stays readable meanwhile, and a line that grows moves the page under it.
    if (this.prefs.display === 'bilingual' && this.keepsOriginalVisible(item)) return true;
    return !decodesSlowly(
      item,
      this.outputRatio ?? this.usualOutputRatio(item),
      this.pace,
      this.decodesAlone(item),
    );
  }

  /**
   * Whether no other block has got text since this one got its first: one request is decoded
   * at a time, or nothing else is left. Nothing else on the screen changes meanwhile, and
   * the block's text comes steadily.
   */
  private decodesAlone(item: Live): boolean {
    if (item.firstPieceAt === null) return false;
    const other = this.pieceFor === item ? this.otherPieceAt : this.pieceAt;
    return other < item.firstPieceAt;
  }

  /**
   * Short lines share a request, and the request answers for all of them when it ends. The
   * text of a line is whole before that, though: as soon as the next line begins. With the
   * source kept until a translation is finished, a line would otherwise wait for every line
   * after it in the request, and the reader would see a screen of labels change all at once
   * where the text came line by line.
   */
  private endLineBefore(batch: readonly Live[], item: Live, token: number): void {
    if (this.prefs.reveal !== 'smooth' && this.prefs.reveal !== 'sentence') {
      return;
    }
    if (item.partAlone[0] === true) return;
    const line = batch[batch.indexOf(item) - 1];
    if (!line || line.role !== 'page' || line.state !== 'running' || line.batchToken !== token) {
      return;
    }
    if (line.partText.length !== 1 || line.partAlone[0] === true || line.partFinal[0] === true) {
      return;
    }
    if ((line.partText[0] ?? '').trim().length === 0) return;
    line.partFinal[0] = true;
    this.endedEarly.set(line, token);
    this.notePace(line);
    this.complete(line);
  }

  /** Takes the request's own answer for a line that `endLineBefore` finished. */
  private correctLine(
    item: Live,
    final: string,
    failed: boolean,
    token: number,
    signal: AbortSignal,
  ): void {
    if (this.endedEarly.get(item) !== token) return;
    this.endedEarly.delete(item);
    if (!this.active || item.state !== 'done' || item.batchToken !== token) return;
    // The page may have replaced this block while the old request was still open.
    if (!this.ownsBlock(item)) return;
    const previous = item.partText[0] ?? '';
    if (failed) {
      // An error final carries fallback text, not a translation: honour it instead of
      // leaving the optimistic early text on the page.
      item.partText[0] = final;
      item.partFinal[0] = true;
      item.partError[0] = true;
      this.markUntranslated(item, signal);
      return;
    }
    if (final.trim() === previous.trim()) return;
    item.partText[0] = final;
    this.complete(item);
  }

  /** Whether this item still owns the block its request is painting. */
  private ownsBlock(item: Live): boolean {
    return !item.model || this.liveByBlock.get(item.model.block) === item;
  }

  /** How fast text comes, learned from a block that has just finished. */
  private notePace(item: Live): void {
    if (item.role !== 'page' || item.partText.length !== 1 || item.firstPieceAt === null) return;
    const span = item.lastPieceAt - item.firstPieceAt;
    const length = item.partText[0]?.length ?? 0;
    if (span < PACE_MIN_SPAN_MS || length === 0) return;
    const pace = length / span;
    this.pace = this.pace === null ? pace : this.pace * 0.7 + pace * 0.3;
  }

  /** Japanese, Chinese and Korean say in about half the letters what English says. */
  private usualOutputRatio(item: Live): number {
    const dense = /^(?:ja|zh|ko)\b/iu;
    const from = dense.test(item.lang ?? '');
    const to = dense.test(this.prefs.targetLanguage);
    return from === to ? 1 : to ? 0.5 : 2;
  }

  private offerReveal(item: Live, model: SegmentModel, text: string, bilingual: boolean): void {
    const generation = this.paintGeneration;
    this.claim(item, model);
    this.revealer.offer({
      block: model.block,
      kind: revealKind(item),
      apply: () => {
        if (generation !== this.paintGeneration || !this.active) return;
        if (item.state !== 'done' || item.model !== model || !model.block.isConnected) return;
        if (!this.ownsBlock(item)) return;
        this.write(item, model, text, false, bilingual);
      },
      ...(bilingual ? { added: () => model.block.querySelector(':scope > sakutto-line') } : {}),
      ...(this.endsPage(item) ? { last: true } : {}),
    });
  }

  /** Whether no other block of the page is waiting for its translation. */
  private endsPage(item: Live): boolean {
    for (const other of this.live.values()) {
      if (other === item || other.role !== 'page') continue;
      if (other.state === 'queued' || other.state === 'running') return false;
    }
    return true;
  }

  /**
   * A block that decodes slowly shows what there is so far and fills in from there. It keeps
   * its height meanwhile, so the page under it stays where it is until the text is finished.
   */
  private offerStream(item: Live, model: SegmentModel): void {
    const generation = this.paintGeneration;
    this.claim(item, model);
    this.revealer.offer({
      block: model.block,
      kind: revealKind(item),
      keepHeight: true,
      apply: () => {
        if (generation !== this.paintGeneration || !this.active) return;
        if (item.model !== model || !model.block.isConnected) return;
        // Finished or given up meanwhile: what is on the page now is newer than these pieces.
        if (item.state !== 'running' && item.state !== 'queued') return;
        const text = stripPlaceholderTokens(partialText(item, this.prefs.targetLanguage));
        if (text.trim().length === 0) return;
        this.write(item, model, text, true, false);
      },
    });
  }

  /**
   * Marks a block whose translation waits to be shown as one of ours, as the first streamed
   * piece used to. A change the page makes to it meanwhile is then noticed.
   */
  private claim(item: Live, model: SegmentModel): void {
    if (model.block.getAttribute('data-sakutto-id') === item.id) return;
    this.editDom(() => {
      model.block.setAttribute('data-sakutto-id', item.id);
    });
  }

  private write(
    item: Live,
    model: SegmentModel,
    text: string,
    partial: boolean,
    bilingual: boolean,
  ): void {
    if (item.role === 'page' && this.firstDomWriteAt === null) {
      this.firstDomWriteAt = performance.now();
      this.writePerf();
    }
    this.editDom(() => {
      model.block.setAttribute('data-sakutto-id', item.id);
      if (item.engine) model.block.setAttribute('data-sakutto-engine', item.engine);

      if (bilingual) {
        showBilingual(model, text, item.created);
        const line = model.block.querySelector(LINE_TAG);
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
    if (partial) {
      item.streamed = true;
      this.shown.delete(model.block);
    } else {
      this.shown.set(model.block, shownAs(text, bilingual));
    }
  }

  private repaintAll(): void {
    this.changingReveal(() => {
      this.revealer.clear();
      for (const item of this.live.values()) {
        if (!item.translation) {
          // A display switch removes the old partial paint and starts the hold over:
          // a block that streamed in replace mode must not grow a bilingual line.
          if (item.model) this.resetLive(item);
          continue;
        }
        this.paint(item, false, true);
      }
    });
  }

  private retranslate(): void {
    this.changingReveal(() => this.retranslateNow());
  }

  private retranslateNow(): void {
    this.revealer.clear();
    // What was learned about speed and length belongs to the language it was learned in.
    this.outputRatio = null;
    this.pace = null;
    this.invalidatePaints();
    this.abortRunning(false);
    const target = isPlamoOnlyTarget(this.prefs.targetLanguage)
      ? null
      : canonicalPageLanguage(this.prefs.targetLanguage);
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
      item.partError = [];
      item.state = 'idle';
      this.enqueue(item, true);
    }
    this.pump();
  }

  private resetLive(item: Live): void {
    this.changingReveal(() => {
      if (!item.model) return;
      const model = item.model;
      const block = model.block;
      this.revealer.forget(block);
      this.shown.delete(block);
      item.streamed = false;
      delete item.sentenceShownParts;
      delete item.fastFlushAt;
      delete item.fastFlushLength;
      this.cancelFastFlush(item);
      this.editDom(() => {
        restoreSegment(model, item.created);
        removeTranslationUi(block);
        for (const node of item.originalChildren) {
          if (node.parentNode === block) block.appendChild(node);
        }
        this.remember(model, item.created);
      });
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

  private abortBatches(match: (batch: InflightBatch) => boolean, requeue: boolean): void {
    let released = false;
    for (const batch of [...this.inflightBatches]) {
      if (!match(batch)) continue;
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
        item.partError = [];
        // Every piece is requested again after this abort. No mark from the interrupted
        // attempt may block the replacement partials, and no stale flush may fire later.
        this.keepFinalShownParts(item);
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
    this.changingReveal(() => {
      if (item.model) {
        if (restore) this.resetLive(item);
        else {
          this.revealer.forget(item.model.block);
          this.shown.delete(item.model.block);
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
    });
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
    if (this.modelMissingFault) return this.labels.modelMissing ?? this.labels.barLabel;
    if (this.folderPermissionFault && view.pending === 0) {
      if (!this.overlay.folderEnableVisible()) this.beginFolderGrantWait();
      return this.labels.barLabel;
    }
    if (this.serverFault && this.labels.engineFailed && view.pending === 0) {
      return this.labels.engineFailed;
    }
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
    this.ensurePerf();
    this.writePerf();
  }

  /** The perf hook is created once per session and reused across retranslations. */
  private ensurePerf(): void {
    if (this.perf) return;
    this.perf = this.doc.createElement('sakutto-perf');
    this.perf.hidden = true;
    this.perf.setAttribute('translate', 'no');
    this.doc.documentElement.append(this.perf);
  }

  /**
   * Rewrites the `sakutto-perf` payload. This also runs after a batch's engine time is
   * added, because `noteTiming` is reached from the last `complete()` inside the batch —
   * one statement before that time is counted — so the final batch of every page used to
   * be missing from `engineMs`, which on a single-block page is the whole cost. The three
   * first-* timestamps are absolute (`performance.now`) so the bench can lay the request,
   * token and paint milestones over the harness clock; the *Ms fields are already
   * relative to `startedAt` and add up to the time to the first painted word.
   */
  private writePerf(): void {
    if (!this.perf) return;
    const rates = this.rates();
    const { firstRequestAt, firstTokenAt, firstDomWriteAt } = this;
    this.perf.textContent = JSON.stringify({
      startedAt: this.startedAt,
      firstTextAt: this.firstTextAt,
      firstRequestAt,
      firstTokenAt,
      firstDomWriteAt,
      requestMs: firstRequestAt === null ? null : Math.round(firstRequestAt - this.startedAt),
      ttfbMs:
        firstTokenAt === null || firstRequestAt === null
          ? null
          : Math.round(firstTokenAt - firstRequestAt),
      paintMs:
        firstDomWriteAt === null || firstTokenAt === null
          ? null
          : Math.round(firstDomWriteAt - firstTokenAt),
      domWriteMs: firstDomWriteAt === null ? null : Math.round(firstDomWriteAt - this.startedAt),
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

  private shouldPrefetchRange(range: Range): boolean {
    const root = range.commonAncestorContainer;
    if (root.nodeType === Node.TEXT_NODE) return !this.isRenderedText(root as Text);

    const { startContainer, startOffset, endContainer, endOffset } = range;
    const first =
      startContainer.nodeType === Node.TEXT_NODE
        ? startContainer
        : (startContainer.childNodes[startOffset] ?? nextAfterSubtree(startContainer, root));
    const after = endContainer.childNodes[endOffset] ?? nextAfterSubtree(endContainer, root);

    let inspected = 0;
    let foundText = false;
    for (
      let node = first;
      node && node !== after;
      node = node.firstChild ?? nextAfterSubtree(node, root)
    ) {
      // Oversized ranges keep the pre-scan prefetch instead of paying for a full walk.
      if (++inspected > MAX_SELECTION_SCAN_NODES) return true;
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const text = node as Text;
      const start = text === startContainer ? startOffset : 0;
      const end = text === endContainer ? endOffset : text.length;
      if (text.data.slice(start, end).trim() === '') continue;
      if (!this.isRenderedText(text)) return true;
      foundText = true;
    }
    return !foundText;
  }

  private isRenderedText(text: Text): boolean {
    const block = this.blockOf(text);
    const item = block ? this.liveByBlock.get(block) : undefined;
    if (!item || item.state !== 'done' || item.translation.trim() === '') return false;

    if (this.prefs.display === 'bilingual' && this.keepsOriginalVisible(item)) {
      const line = text.parentElement;
      return line?.localName === LINE_TAG && line.parentElement === block;
    }
    // Only text nodes that the renderer touched are recorded, including inline slots.
    return this.expected.get(text) === text.data;
  }

  private refreshBlock(block: Element): void {
    const existing = this.liveByBlock.get(block);
    if (!existing || existing.state === 'running') return;
    const model = buildSegment(block);
    if (model && model.source === existing.source) return;
    const index = existing.index;
    // Dropping the old reveal reports it settled. Keep that report back until the
    // replacement is queued, or whenIdle() would see an idle page in between.
    this.changingReveal(() => {
      this.forgetLive(existing, false);
      this.addBlock(block, index);
    });
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
    // A finished translation that waits to be shown is written now: its block counts as done
    // and nothing would translate it again.
    try {
      this.revealer.flush();
    } finally {
      this.paintGeneration += 1;
      this.dirty.clear();
      this.frameQueued = false;
      for (const item of this.live.values()) this.cancelFastFlush(item);
    }
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
    const screens = lookaheadScreens(this.prefs.tier, this.prefs.pace, this.prefs.engineSource);
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
      this.revealer.size === 0 &&
      this.scanTimer === null &&
      this.selectionTimer === null &&
      this.pendingScans === 0
    );
  }

  /**
   * Reveal removal reports `settled` before the replacement work is registered. Hold that
   * report until the caller is done: an `whenIdle()` waiter must still see the new work.
   */
  private changingReveal<T>(change: () => T): T {
    this.revealChanging += 1;
    try {
      return change();
    } finally {
      this.revealChanging -= 1;
      if (this.revealChanging === 0 && this.revealSettled) {
        this.revealSettled = false;
        this.resolveIdle();
      }
    }
  }

  private resolveIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

/** The next node in document order after all descendants, within the range's root. */
function nextAfterSubtree(node: Node, root: Node): Node | null {
  for (let current: Node | null = node; current && current !== root; current = current.parentNode) {
    if (current.nextSibling) return current.nextSibling;
  }
  return null;
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
    if (isFrozenInline(child) && !isSubSuperscript(child)) continue;
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

/**
 * A few words are short enough that going out of focus would read as a flicker. The limit is
 * in Latin letters; a character of a wide script counts as two.
 */
const REVEAL_LABEL_MAX_WIDTH = 28;

function revealKind(item: Live): RevealKind {
  if (item.heading) return 'heading';
  let width = 0;
  for (const character of item.plain) {
    width += (character.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
    if (width > REVEAL_LABEL_MAX_WIDTH) return 'body';
  }
  return 'label';
}

/** What `shown` remembers for a finished translation: the text, and how it was put there. */
function shownAs(text: string, bilingual: boolean): string {
  return `${bilingual ? 'line' : 'text'}:${text}`;
}

/** A block's speed can be told this long after its first piece. */
const REVEAL_FORECAST_AFTER_MS = 250;
/** A block that took less than this says too little about the speed. */
const PACE_MIN_SPAN_MS = 25;
/** Less text than this says too little about the speed. */
const REVEAL_FORECAST_MIN_CHARS = 8;
/**
 * Pieces of one block that are decoded side by side have all started this long after the
 * first of them. A piece that has not is waiting for its turn.
 */
const REVEAL_PIECES_START_MS = 1200;
/**
 * A block that is decoded by itself is streamed when it takes longer than this: no other
 * block is swapped in meanwhile, so the screen would show no sign of progress.
 */
const REVEAL_STREAM_ALONE_MS = 3000;

/**
 * Whether the block is taking, or will take, longer than a reader should look at the source
 * without a sign of progress. `ratio` is how long a translation is for its source on this
 * page, `pace` how many letters a millisecond its finished blocks came at (null before the
 * first one has finished), `alone` whether no other block has got text beside it.
 */
function decodesSlowly(item: Live, ratio: number, pace: number | null, alone: boolean): boolean {
  if (item.firstPieceAt === null) return false;
  const elapsed = performance.now() - item.firstPieceAt;
  // While other blocks are swapped in around it, a block can keep its source for longer than
  // on a screen where nothing else happens.
  const limit = alone ? REVEAL_STREAM_ALONE_MS : REVEAL_STREAM_AFTER_MS;
  if (elapsed > limit) return true;
  if (elapsed < REVEAL_FORECAST_AFTER_MS) return false;
  let have = 0;
  for (const part of item.partText) have += part.length;
  const expected = item.source.length * ratio;
  if (have >= expected) return false;
  // Blocks are decoded many at a time: one often gets a few letters, waits while others are
  // started, and then comes quickly. Its own first pieces would say it takes far longer than
  // it does. The speed at which finished blocks came on this page has those waits in it.
  // A block that is decoded by itself has no such waits, and its own speed says more than
  // that of the blocks before it, which may have been much shorter.
  if (pace !== null && !alone) {
    // A long block is sent as several pieces. Where many requests are decoded at a time the
    // pieces come side by side, and the block is finished when the piece that lacks the most
    // is. Where one is decoded at a time they come one after another, and the block takes
    // the sum of them. Which it is shows in the pieces themselves: side by side they have
    // all started soon after the first one.
    let most = 0;
    let all = 0;
    let started = 0;
    let waiting = 0;
    for (let index = 0; index < item.partSource.length; index += 1) {
      if (item.partFinal[index] === true) continue;
      const got = item.partText[index]?.length ?? 0;
      const part = Math.max(0, (item.partSource[index] ?? 0) * ratio - got);
      most = Math.max(most, part);
      all += part;
      if (got > 0) started += 1;
      else waiting += 1;
    }
    const inTurn = waiting > 0 && elapsed >= REVEAL_PIECES_START_MS;
    const lacking = inTurn ? Math.max(most, all / Math.max(1, started)) : most;
    return elapsed + lacking / pace > REVEAL_STREAM_AFTER_MS;
  }
  // Decoded by itself, or nothing has finished on this page yet: the block's own speed.
  if (have < REVEAL_FORECAST_MIN_CHARS) return false;
  return (elapsed * expected) / have > limit;
}

function partialText(item: Live, target: string): string {
  const parts = item.partText.filter((part) => part.trim().length > 0);
  if (parts.length === 0) return '';
  return joinTranslatedSentences(parts, target);
}

/**
 * The decoded text of a visible block, piece by piece. A piece that has not started yet
 * stops the read, so a later piece is never shown before the one before it — filtering
 * empty pieces away, as partialText() does for the other paths, would show it alone.
 * Indexes line up with partText so the high-water can be applied before joining.
 */
function visiblePartialParts(item: Live): string[] {
  const parts: string[] = [];
  for (const part of item.partText) {
    const stripped = stripPlaceholderTokens(part).trim();
    if (stripped.length === 0) break;
    parts.push(stripped);
  }
  return parts;
}

/**
 * Clause marks where a partial translation reads well on its own. Commas, semicolons and
 * colons are the early ones in both scripts; a sentence terminator is a clause boundary
 * too, but the fast path never has to wait for one.
 */
const CLAUSE_MARKS: ReadonlySet<string> = new Set([
  ',',
  '、',
  ';',
  '；',
  ':',
  '：',
  '.',
  '。',
  '!',
  '！',
  '?',
  '？',
  '…',
]);
const CLAUSE_CLOSERS: ReadonlySet<string> = new Set([
  '"',
  "'",
  '”',
  '’',
  ')',
  ']',
  '}',
  '）',
  '］',
  '】',
  '」',
  '』',
  '〉',
  '》',
]);

function endsOnClause(text: string): boolean {
  const trimmed = text.trimEnd();
  let end = trimmed.length - 1;
  while (end >= 0 && CLAUSE_CLOSERS.has(trimmed[end] ?? '')) end -= 1;
  return end >= 0 && CLAUSE_MARKS.has(trimmed[end] ?? '');
}

/**
 * The finished sentences of each piece of a decoded translation, indexed by piece. A
 * piece is still being decoded unless it ends on a sentence boundary (or has its final
 * answer), so its last span stays behind — and every later piece waits for it, because
 * a terminator in a later piece says nothing about where the earlier one ended.
 */
function finishedSentenceParts(
  parts: readonly string[],
  final: readonly boolean[],
  target: string,
): string[] {
  const ready: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]?.trim() ?? '';
    if (part.length === 0) break;
    const spans = sentenceSpans(part);
    const done = spans.filter((span) => hasSentenceTerminator(span.text)).map((span) => span.text);
    if (final[index] === true && spans.length > done.length) {
      // A finished piece needs no terminator: its whole text is ready.
      const tail = spans.at(-1);
      if (tail) done.push(tail.text);
    }
    ready[index] = joinTranslatedSentences(done, target);
    if (final[index] !== true && done.length < spans.length) break;
  }
  return ready;
}

/**
 * High-water mark per piece of the text already written to the page. A restart may shorten
 * one piece while a later piece grows: the joined text is then longer than before although
 * a sentence the reader already saw has vanished. Only a candidate that continues a
 * piece's mark may replace it, so every partial paint extends the text on the page; a
 * corrected answer takes over at the final settle, which bypasses this guard. Returns the
 * text to join and the new marks, or null when no piece grew.
 */
function extendShownParts(
  candidates: readonly string[],
  shown: readonly string[] | undefined,
): { parts: string[]; shown: string[] } | null {
  const count = Math.max(candidates.length, shown?.length ?? 0);
  const parts: string[] = [];
  let grew = false;
  for (let index = 0; index < count; index += 1) {
    const mark = shown?.[index] ?? '';
    const candidate = candidates[index] ?? '';
    const next = candidate.length > mark.length && candidate.startsWith(mark) ? candidate : mark;
    parts.push(next);
    if (next !== mark) grew = true;
  }
  return grew ? { parts, shown: parts } : null;
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
