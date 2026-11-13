import { PriorityQueue } from '@/engine/queue/priority-queue';
import { chunkForTranslation } from '@/engine/text/sentences';
import { estimateTokens } from '@/engine/text/tokens';
import type { EngineKind, GlossaryEntry, TranslateOptions, TranslationChunk } from '@/engine/types';
import { MAX_PRIORITY } from '@/engine/offscreen/protocol';
import { glossaryEquals } from '@/shared/glossary';
import { canonicalLanguage, isTargetLanguage } from '@/shared/languages';
import type { Formality } from '@/shared/settings';
import { pageRates, type ThroughputSample } from '@/dom/throughput';
import { translationConcurrencyFor } from '@/dom/priority';
import { fitText, type FitResult } from './fit';
import { verticalWriting, type AnyBlockRole, type LayoutBlock, type PageLayout } from './layout';
import {
  drawnBox,
  exceedsPage,
  fitBox,
  lineOverflows,
  pageGrowBudget,
  resolveOverlaps,
  wrapWidth,
} from './place';
import { isSameLanguage, pdfPageLanguage } from './language';
import { protectInlineMath, restoreInlineMath, shouldSkipInlineMath } from './protect';

/** What the reader shows about how fast the document is being translated. */
export interface PdfRates {
  tokensPerSecond: number | null;
  segmentsPerSecond: number | null;
}

/** What the reader knows about one block: where it is, and what it became. */
export interface BlockState {
  block: LayoutBlock;
  state: 'idle' | 'queued' | 'running' | 'done' | 'failed';
  translation: string;
  engine: EngineKind | null;
  /** The layout the renderer draws, once a translation exists. */
  fit: FitResult | null;
  /**
   * False when a fitted translation must not be drawn: it did not fit, it would cover
   * another block, or restoring an inline formula failed. The original stays visible.
   */
  paint: boolean;
  /**
   * True when a translation exists but is not painted in place. The reader shows a marker
   * that opens the full text rather than leaving the source silently untranslated.
   */
  overflow: boolean;
}

export function isTranslated(state: BlockState): boolean {
  return state.paint && state.translation.trim().length > 0 && state.fit !== null;
}

/**
 * True when a block will not change again: translated, deliberately left as drawn, or failed.
 *
 * Same-language and math-heavy blocks finish as `done` with empty text. A harness that only
 * counts non-empty translations waits forever on those.
 */
export function isPdfBlockSettled(entry: { state: string }): boolean {
  return entry.state === 'done' || entry.state === 'failed';
}

const PDF_PRIORITY_KIND = {
  heading: 10,
  prose: 10,
  caption: 30,
  cell: 50,
  label: 50,
  equation: 50,
  'figure-label': 50,
  code: 50,
  furniture: 50,
  identity: 50,
} as const satisfies Record<AnyBlockRole, number>;

/** Roles a PDF request can carry; used to pin every generated priority inside the protocol. */
export const PDF_PRIORITY_ROLES: readonly AnyBlockRole[] = Object.keys(
  PDF_PRIORITY_KIND,
) as AnyBlockRole[];

/**
 * Queue priority for one PDF block. Lower runs first.
 *
 * Distance to the focused page dominates; kind only orders work on the same page. The value
 * must stay inside `0..MAX_PRIORITY` or the offscreen host silently drops the request.
 */
export function pdfRequestPriority(distance: number, role: AnyBlockRole): number {
  const kind = PDF_PRIORITY_KIND[role] ?? 50;
  const steps = Number.isFinite(distance)
    ? Math.min(9, Math.max(0, Math.abs(Math.trunc(distance))))
    : 0;
  const rank = Math.min(9, Math.floor(kind / 10));
  return Math.min(MAX_PRIORITY, steps * 10 + rank);
}

export interface PdfEngine {
  translate(
    segments: readonly { id: string; text: string }[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk>;
}

/** What the renderer needs to know about a block's type to measure and draw it. */
export interface BlockTraits {
  family: 'serif' | 'sans-serif' | 'monospace';
  bold: boolean;
  italic: boolean;
  /** Always false for a block the reader draws: an equation is never translated. */
  math?: boolean | undefined;
}

export interface PdfSessionOptions {
  engine: PdfEngine;
  targetLanguage: string;
  form: Formality;
  glossary?: readonly GlossaryEntry[] | undefined;
  /** Called when a block's state or translation changed, at most once per frame. */
  onChange: () => void;
  /** Measures a string's width at a font size, in points. */
  measure: (text: string, fontSize: number, traits: BlockTraits) => number;
  /**
   * Blocks allowed in flight at once.
   *
   * The engine batches a request's segments into one packed prompt, so a block per request
   * means the model decodes a batch of one. The page translator sends whole groups of blocks
   * and reaches 32 in flight on the GPU; a PDF that sent two was measured at roughly a sixth
   * of that throughput, and a long document could take many minutes and still not finish.
   */
  concurrency?: number;
}

const NO_SPACE_TARGETS: ReadonlySet<string> = new Set(['ja', 'zh-hans', 'zh-hant', 'th']);

/**
 * Blocks this session keeps in flight when nobody says otherwise.
 *
 * The engine packs every segment of one request into a single prompt and decodes the batch
 * together, so the number of requests in flight *is* the batch size. Two was chosen when the
 * engine had two sequences; it now runs many more, and a document measured at two requests was
 * about six times slower than the same work sent as the page translator sends it. Eight is
 * still well under the page translator's GPU ceiling of 32, because a PDF block is a whole
 * paragraph and each request has to finish before its box can be drawn.
 */
export const DEFAULT_PDF_CONCURRENCY = 8;

/**
 * Blocks in flight for the engine this reader is talking to.
 *
 * The page translator already answers this question — 32 on the GPU, two on the CPU, sixteen
 * for a local server — and a PDF should not answer it differently. A CPU run keeps two
 * because the runtime has two sequences there and more requests only queue inside it; a GPU
 * run takes the page translator's own ceiling.
 */
export function pdfConcurrencyFor(
  tier: 'g' | 'c8' | 'c4' | 'c1' | null,
  engineSource: 'in-browser' | 'local-server' | undefined,
  parallel?: number,
): number {
  return translationConcurrencyFor(tier, engineSource, parallel);
}

/**
 * Translates one document page by page and keeps the result for the renderer.
 *
 * The extension's page session translates DOM blocks and paints into them; a PDF has no DOM
 * to paint into, so this keeps each block's translation and its fitted layout and the reader
 * draws it. What the two share is the engine and the priority rule: the page a reader is
 * looking at is translated first, and a block that finished is never translated again.
 */
export class PdfSession {
  private readonly engine: PdfEngine;
  private readonly measure: PdfSessionOptions['measure'];
  private readonly onChange: () => void;
  private readonly concurrency: number;
  private readonly pages = new Map<number, BlockState[]>();
  /** Blocks per page that the reader leaves in the page's own typesetting. */
  private readonly skipped = new Map<number, readonly LayoutBlock[]>();
  /** Page height in points, used as the floor a last paragraph must not grow past. */
  private readonly pageHeights = new Map<number, number>();
  /** Page width in points, used when a paragraph may wrap into unused space on its right. */
  private readonly pageWidths = new Map<number, number>();
  /** Drawn areas that occupy space even when they hold no text: figure images. */
  private readonly obstacles = new Map<
    number,
    readonly { x: number; y: number; width: number; height: number }[]
  >();
  private readonly queue = new PriorityQueue<Job>();
  private running = 0;
  /**
   * Bumped on every `stop()` / `retranslateAll()`. An aborted run's `finally` must not
   * decrement `running` or mark blocks idle after a newer round has already started.
   */
  private generation = 0;
  private controller = new AbortController();
  /** Pages whose painted boxes still need an overlap pass, coalesced to one run per frame. */
  private overlapDirty = new Set<number>();
  private target: string;
  private form: Formality;
  private glossary: readonly GlossaryEntry[];
  private nextJob = 0;
  /** Page the reader is looking at, which decides the priority of everything else. */
  private focus = 0;
  private notifyQueued = false;
  /**
   * Output counted as it arrives, so the reader can show the same tok/s and seg/s the page
   * translator shows. A reader deciding whether to wait for a 40-page paper is asking how
   * fast it is going, and the page feature already answers that for a web page.
   */
  private readonly throughputSamples: ThroughputSample[] = [];
  private tokensSoFar = 0;
  private segmentsSoFar = 0;
  private rates: PdfRates = { tokensPerSecond: null, segmentsPerSecond: null };
  /** Detected language of each page's prose, used to skip same-language rewriting. */
  private readonly pageLanguages = new Map<number, string | null>();

  constructor(options: PdfSessionOptions) {
    this.engine = options.engine;
    this.measure = options.measure;
    this.onChange = options.onChange;
    this.concurrency = options.concurrency ?? DEFAULT_PDF_CONCURRENCY;
    this.target = options.targetLanguage;
    this.form = options.form;
    this.glossary = options.glossary ?? [];
  }

  /**
   * Registers one page's layout. Called as pages are parsed, which may be before or after the
   * reader has scrolled to them.
   */
  addPage(index: number, layout: PageLayout, pageHeight = 0): void {
    if (this.pages.has(index)) return;
    this.skipped.set(index, layout.skipped);
    const height = pageHeight > 0 ? pageHeight : layout.pageHeight;
    if (height > 0) this.pageHeights.set(index, height);
    if ((layout.pageWidth ?? 0) > 0) this.pageWidths.set(index, layout.pageWidth);
    this.obstacles.set(index, layout.obstacles ?? []);
    this.pageLanguages.set(index, pdfPageLanguage(layout.blocks));
    const states: BlockState[] = layout.blocks.map((block) => ({
      block,
      state: 'idle',
      translation: '',
      engine: null,
      fit: null,
      paint: false,
      overflow: false,
    }));
    this.pages.set(index, states);
    for (const state of states) this.enqueue(state, index);
    this.pump();
  }

  /**
   * Raises the priority of the page the reader can see.
   *
   * Everything is queued when its page is parsed, so this only re-ranks. Re-ranking matters
   * on a long document: without it the whole paper is translated in page order, and a reader
   * who opens a report at page 30 waits for 29 pages of work before seeing a word.
   */
  focusPage(index: number): void {
    if (this.focus === index) return;
    this.focus = index;
    // Re-queue everything still waiting so the new distance is applied. The queue is a heap
    // with no decrease-key, and the number of waiting blocks is small enough that rebuilding
    // it is cheaper than reasoning about which entries to move.
    const waiting: { state: BlockState; page: number }[] = [];
    this.queue.remove((job) => {
      if (job.state.state !== 'queued') return false;
      job.state.state = 'idle';
      waiting.push({ state: job.state, page: job.page });
      return true;
    });
    for (const entry of waiting) this.enqueue(entry.state, entry.page);
    this.pump();
  }

  /** Blocks belonging to one page, in reading order. */
  pageBlocks(index: number): readonly BlockState[] {
    return this.pages.get(index) ?? [];
  }

  progress(): {
    done: number;
    total: number;
    pending: number;
    overflowed: number;
    failed: number;
  } {
    let done = 0;
    let total = 0;
    let pending = 0;
    let overflowed = 0;
    let failed = 0;
    for (const states of this.pages.values()) {
      for (const state of states) {
        total += 1;
        if (state.state === 'done') done += 1;
        else if (state.state === 'queued' || state.state === 'running') pending += 1;
        else if (state.state === 'failed') failed += 1;
        if (state.overflow) overflowed += 1;
      }
    }
    return { done, total, pending, overflowed, failed };
  }

  /** Live rates, computed from the output that has arrived rather than a whole-run average. */
  ratesNow(): PdfRates {
    return this.rates;
  }

  /**
   * Records output as it lands. The sample is taken per completed translation piece, which is
   * the same unit the page session counts, so the two numbers are comparable.
   */
  private noteOutput(translated: string, segments: number): void {
    if (translated.length === 0) return;
    this.tokensSoFar += estimateTokens(translated);
    this.segmentsSoFar += segments;
    const now = globalThis.performance?.now?.() ?? Date.now();
    this.throughputSamples.push({
      atMs: now,
      tokens: this.tokensSoFar,
      segments: this.segmentsSoFar,
    });
    // Keep the window short: the rate is about the last few seconds, not the whole document.
    const cutoff = now - 15_000;
    while (this.throughputSamples.length > 2 && (this.throughputSamples[0]?.atMs ?? 0) < cutoff) {
      this.throughputSamples.shift();
    }
    this.rates = pageRates({
      active: true,
      nowMs: now,
      samples: this.throughputSamples,
    });
  }

  setTargetLanguage(language: string, form: Formality): void {
    if (!isTargetLanguage(language)) return;
    if (language === this.target && form === this.form) return;
    this.target = language;
    this.form = form;
    this.retranslateAll();
  }

  setGlossary(glossary: readonly GlossaryEntry[]): void {
    if (glossaryEquals(this.glossary, glossary)) return;
    this.glossary = glossary;
    this.retranslateAll();
  }

  /** Re-queues blocks that could not be translated, e.g. because the model was loading. */
  retryFailed(): void {
    for (const [page, states] of this.pages) {
      for (const state of states) {
        if (state.state !== 'failed' && state.state !== 'idle') continue;
        state.state = 'idle';
        this.enqueue(state, page);
      }
    }
    this.pump();
  }

  /** Re-queues a block that never got a translation, when the model becomes ready. */
  retryUntranslated(): void {
    for (const [page, states] of this.pages) {
      for (const state of states) {
        if (state.state === 'done' || state.state === 'running') continue;
        if (state.translation.trim().length > 0) continue;
        state.state = 'idle';
        this.enqueue(state, page);
      }
    }
    this.pump();
  }

  /** Drops every in-flight request and returns the finished blocks to the queue. */
  stop(): void {
    this.generation += 1;
    this.controller.abort();
    this.controller = new AbortController();
    this.queue.clear();
    this.running = 0;
    this.overlapDirty.clear();
    for (const states of this.pages.values()) {
      for (const state of states) {
        if (state.state === 'running' || state.state === 'queued') state.state = 'idle';
      }
    }
    this.onChange();
  }

  dispose(): void {
    this.controller.abort();
    this.queue.clear();
    this.pages.clear();
  }

  private retranslateAll(): void {
    this.stop();
    for (const [page, states] of this.pages) {
      for (const state of states) {
        // Keep the previous cover until the new text arrives. Blanking it first flashes
        // the source glyphs through a box the reader already trusted.
        state.engine = null;
        this.enqueue(state, page);
      }
    }
    this.pump();
  }

  private enqueue(state: BlockState, page: number): void {
    if (state.state === 'running' || state.state === 'queued') return;
    this.nextJob += 1;
    state.state = 'queued';
    this.queue.enqueue({ state, id: this.nextJob, page }, this.priorityOf(state.block, page));
  }

  /**
   * Lower runs first. Distance to the page the reader can see dominates: a label on the
   * focused page must beat a paragraph two pages away, or a 30-character heading sits
   * `running` while later pages finish. Kind only orders work on the same page.
   */
  private priorityOf(block: LayoutBlock, page: number): number {
    return pdfRequestPriority(page - this.focus, block.role);
  }

  private pump(): void {
    const signal = this.controller.signal;
    const generation = this.generation;
    while (this.running < this.concurrency) {
      const next = this.queue.dequeue();
      if (!next) break;
      const job = next;
      if (job.state.state !== 'queued') continue;
      job.state.state = 'running';
      this.running += 1;
      void this.run(job, signal, generation).finally(() => {
        if (this.generation !== generation) return;
        this.running = Math.max(0, this.running - 1);
        this.pump();
        this.scheduleNotify();
      });
    }
    this.scheduleNotify();
  }

  private stale(generation: number, signal: AbortSignal): boolean {
    return this.generation !== generation || signal.aborted;
  }

  private failBlock(state: BlockState): void {
    state.translation = '';
    state.fit = null;
    state.paint = false;
    state.overflow = false;
    state.state = 'failed';
  }

  /** Leave the source typesetting: same-language text, or a sentence that is mostly formula. */
  private keepOriginal(state: BlockState): void {
    state.translation = '';
    state.fit = null;
    state.paint = false;
    state.overflow = false;
    state.state = 'done';
  }

  private async run(job: Job, signal: AbortSignal, generation: number): Promise<void> {
    const { state } = job;
    const pageLanguage = this.pageLanguages.get(job.page) ?? null;
    if (isSameLanguage(state.block.text, this.target, pageLanguage)) {
      this.keepOriginal(state);
      return;
    }
    // Inline mathematics is replaced with the same numbered placeholders the page translator
    // uses, so a variable comes back exactly. A translation that drops a placeholder is
    // refused below and the source stays on the page.
    const protectedText = protectInlineMath(state.block);
    if (shouldSkipInlineMath(protectedText, state.block.text)) {
      this.keepOriginal(state);
      return;
    }
    // A block longer than a paragraph is chunked here rather than in the engine, so a long
    // paragraph shows its first sentences while the rest is still decoding.
    const pieces = chunkForTranslation(protectedText.text);
    if (pieces.length === 0) {
      this.failBlock(state);
      return;
    }
    const id = `b${String(job.id)}`;
    const segments = pieces.map((text, index) => ({
      id: pieces.length === 1 ? id : `${id}#${String(index)}`,
      text,
    }));
    const parts: string[] = Array.from({ length: pieces.length }, () => '');
    const finals = Array.from({ length: pieces.length }, () => false);
    const errors = Array.from({ length: pieces.length }, () => false);

    try {
      for await (const chunk of this.engine.translate(segments, {
        tgt: this.target,
        form: this.form,
        priority: this.priorityOf(state.block, job.page),
        signal,
        eager: job.page === this.focus,
        preempt: job.page === this.focus,
        ...(this.glossary.length > 0 ? { glossary: this.glossary } : {}),
      })) {
        if (this.stale(generation, signal)) return;
        if (chunk.engine) state.engine = chunk.engine;
        const index = pieceIndex(chunk.id);
        if (index < 0 || index >= pieces.length) continue;
        if (chunk.textDelta !== undefined) {
          const before = chunk.restart === true ? '' : (parts[index] ?? '');
          parts[index] = before + chunk.textDelta;
        } else if (chunk.final !== undefined) {
          finals[index] = true;
          if (chunk.error === true) {
            // `final` on an error chunk is the source text. It must not be shown as a
            // translation or cached; the original stays on the page.
            errors[index] = true;
            parts[index] = '';
            continue;
          }
          parts[index] = chunk.final;
        } else {
          continue;
        }
        const joined = joinParts(parts, this.target);
        const restored = restoreInlineMath(joined, protectedText.slots);
        if (restored === null) {
          // The model dropped a formula. Showing the hole would be a wrong translation.
          state.translation = '';
          state.fit = null;
          state.paint = false;
          state.overflow = false;
          continue;
        }
        state.translation = restored;
        this.layout(state, job.page);
        this.noteOutput(chunk.final ?? chunk.textDelta ?? '', 1);
        this.scheduleNotify();
      }
    } catch {
      if (this.stale(generation, signal)) return;
      this.failBlock(state);
      return;
    }

    if (this.stale(generation, signal)) return;
    const allFinal = pieces.length === 0 || finals.every(Boolean);
    const anyError = errors.some(Boolean);
    if (!allFinal || anyError) {
      this.failBlock(state);
      return;
    }
    state.state = state.translation.trim().length > 0 ? 'done' : 'failed';
    if (state.state === 'failed') {
      this.failBlock(state);
      return;
    }
    this.layout(state, job.page);
  }

  /** Recomputes the layout the renderer draws for a block. */
  private layout(state: BlockState, page: number): void {
    if (state.translation.trim().length === 0) {
      state.fit = null;
      state.paint = false;
      state.overflow = false;
      return;
    }
    const block = state.block;
    const obstacles = this.neighbourBoxes(state, page);
    const pageWidth = this.pageWidths.get(page) ?? 0;
    const width = wrapWidth(block, obstacles, pageWidth);
    const measureAt = (text: string, size: number) => this.measure(text, size, traitsOf(block));
    state.fit = fitText(
      {
        box: fitBox(block, width),
        growBudget: verticalWriting(block) ? 0 : this.growBudget(state, page),
        fontSize: block.fontSize,
        lineHeight: block.lineHeight,
        width,
        measure: measureAt,
        role: block.role,
      },
      state.translation,
      targetScript(this.target),
    );
    const pageHeight = this.pageHeights.get(page) ?? 0;
    const tooWide = lineOverflows(state.fit, width, (text) =>
      measureAt(text, state.fit?.fontSize ?? block.fontSize),
    );
    const drawn =
      state.fit.fits === true && !tooWide
        ? drawnBox(state.block, state.fit, width, pageWidth)
        : null;
    state.paint =
      state.fit.fits && !tooWide && drawn !== null && !exceedsPage(drawn, pageWidth, pageHeight);
    state.overflow = !state.paint;
    this.overlapDirty.add(page);
  }

  /**
   * Room below a block, in points.
   *
   * A paragraph may grow into the space between itself and the next block in its column and
   * no further: the next block is either translated or about to be, and covering it would
   * hide text the reader wants. `pageGrowBudget` walks the boxes to find that neighbour.
   *
   * Two things count as a neighbour, and both were missing before. A block the reader skipped
   * — an equation, a figure's label — still occupies its place on the page: it is drawn by the
   * page's own canvas, and a paragraph that grew over it would cover the formula this reader
   * exists to preserve. And a block on another page is never a neighbour, however close its
   * coordinates happen to be, because the two are drawn in different page elements.
   *
   * The floor of the page is the page's own height, not the highest other block. Using the
   * smallest neighbouring bottom as a ceiling (the previous rule) forbade every paragraph
   * from growing at all, because some heading above it always sat higher on the page.
   */
  private growBudget(state: BlockState, page: number): number {
    const block = state.block;
    const below = this.neighbourBoxes(state, page);
    return pageGrowBudget(block, below, this.pageHeights.get(page) ?? 0);
  }

  private neighbourBoxes(
    state: BlockState,
    page: number,
  ): { x: number; y: number; width: number; height: number }[] {
    const below: { x: number; y: number; width: number; height: number }[] = [];
    for (const other of this.pages.get(page) ?? []) {
      if (other === state) continue;
      below.push(other.block.box);
    }
    for (const kept of this.skipped.get(page) ?? []) below.push(kept.box);
    for (const obstacle of this.obstacles.get(page) ?? []) below.push(obstacle);
    return below;
  }

  /**
   * After a block is fitted, drop any painted box that now covers another on the same page.
   * The original typesetting of the dropped block stays visible; that is better than two
   * translations printed over each other.
   *
   * Called once per notify rather than on every streamed delta: a page of N blocks is
   * quadratic in N, and a token-by-token pass would redo that work dozens of times per
   * paragraph.
   */
  private resolvePageOverlaps(page: number): void {
    const states = this.pages.get(page);
    if (!states) return;
    const pageWidth = this.pageWidths.get(page) ?? 0;
    const pageHeight = this.pageHeights.get(page) ?? 0;
    const placed = states.map((entry) => {
      const obstacles = this.neighbourBoxes(entry, page);
      const candidate =
        entry.paint && entry.fit?.fits === true && entry.fit
          ? drawnBox(
              entry.block,
              entry.fit,
              wrapWidth(entry.block, obstacles, pageWidth),
              pageWidth,
            )
          : null;
      const onPage = candidate !== null && !exceedsPage(candidate, pageWidth, pageHeight);
      return {
        block: entry.block,
        translation: entry.translation,
        fit: entry.fit,
        paint: onPage,
        overflow: entry.overflow || (entry.translation.trim().length > 0 && !onPage),
        drawn: onPage ? candidate : null,
      };
    });
    const resolved = resolveOverlaps(placed);
    for (const [index, entry] of resolved.entries()) {
      const state = states[index];
      if (!state) continue;
      state.paint = entry.paint;
      state.overflow = entry.overflow;
    }
  }

  private scheduleNotify(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      if (this.overlapDirty.size > 0) {
        const pages = [...this.overlapDirty];
        this.overlapDirty.clear();
        for (const page of pages) this.resolvePageOverlaps(page);
      }
      this.onChange();
    });
  }
}

interface Job {
  state: BlockState;
  id: number;
  page: number;
}

function pieceIndex(id: string): number {
  const marker = id.lastIndexOf('#');
  if (marker === -1) return 0;
  const value = Number(id.slice(marker + 1));
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function joinParts(parts: readonly string[], target: string): string {
  const separator = NO_SPACE_TARGETS.has(target) ? '' : ' ';
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(separator);
}

/**
 * Which leading to use. Japanese set from English wants a little more line height than the
 * Latin original had, because its glyphs fill the em box.
 */
export function targetScript(target: string): 'ja' | 'en' | 'other' {
  const canonical = canonicalLanguage(target);
  if (canonical === null) return 'other';
  if (canonical === 'ja') return 'ja';
  if (canonical === 'en') return 'en';
  return 'other';
}

export function traitsOf(block: LayoutBlock): BlockTraits {
  const piece = block.lines[0]?.pieces[0];
  const family = piece?.family;
  return {
    family: family === 'sans-serif' || family === 'monospace' ? family : 'serif',
    bold: block.bold,
    italic: block.italic,
  };
}
