import type { Formality } from '@/shared/settings';
import { verticalWriting, type LayoutBlock } from './layout';
import { layoutPage } from './layout';
import { COVER_PAD_TOP_EM, HINTING_PAD_PX, coverPaintLayout, drawnBox } from './place';
import { coverStyle, READER_STYLE, TextMeasurer } from './render';
import { extractPage, renderPage, type PdfDocument } from './extract';
import type { TextLine } from './lines';
import { PdfSession, traitsOf, type BlockState, type PdfEngine } from './session';
/**
 * Page geometry, known before a page's text is parsed: a page's size comes from the document's
 * own page tree, and the reader needs it to reserve space and to place the placeholder before
 * the text arrives.
 */
export interface PageGeometry {
  index: number;
  width: number;
  height: number;
}

export interface ReaderLabels {
  translate: string;
  restore: string;
  translating: string;
  translated: string;
  progress: (done: number, total: number) => string;
  emptyPage: string;
  /** Shown on a page whose canvas could not be drawn. */
  renderFailed: string;
  noText: string;
  scanning: (page: number, of: number) => string;
  failed: string;
  /** Shown in the panel while a selection's translation is being produced. */
  selectionTranslating: string;
  /** Shown when a selection could not be translated. */
  selectionFailed: string;
  /** Accessible name for the marker that opens a translation that did not fit in place. */
  overflowOpen: string;
  /** Caption on the original pane in side-by-side compare. */
  compareOriginal: string;
  /** Caption on the translated pane in side-by-side compare. */
  compareTranslated: string;
}

export interface ReaderOptions {
  document: PdfDocument;
  engine: PdfEngine;
  labels: ReaderLabels;
  targetLanguage: string;
  form: Formality;
  /**
   * pdf.js's operator codes, so a page's drawing areas can be read. Empty when the module
   * does not expose them; the reader then translates the page as it did before that rule.
   */
  ops?: Record<string, number> | undefined;
  /**
   * Blocks kept in flight. The page passes the engine's own number once it has asked the
   * engine which backend it is on, because a GPU run can hold many more at once than a CPU
   * one and that is the difference between a long document finishing and not.
   */
  concurrency?: number | undefined;
  glossary?: readonly { source: string; target: string }[] | undefined;
  /**
   * Pages to work on, or every page when absent.
   *
   * A long document is 40 pages and a reader checks the first few; without a limit the reader
   * keeps drawing, parsing and translating the whole file, and the main thread never gets a
   * quiet moment to answer anything else. The limit is also what the bench uses to measure a
   * representative slice of a long file.
   */
  pageLimit?: number | undefined;
  /** Reports progress to the page's toolbar. */
  onProgress: (state: ReaderProgress) => void;
}

export interface ReaderProgress {
  done: number;
  total: number;
  pending: number;
  /** Pages whose text has been parsed, out of the document's total. */
  parsed: number;
  pages: number;
  /** The last page whose text arrived without a text layer. */
  emptyPages: number;
  /** Live translation speed, the same numbers the page translator reports. */
  tokensPerSecond: number | null;
  segmentsPerSecond: number | null;
  /** Blocks the reader left in the page's own typesetting, for the toolbar's note. */
  keptAsIs: number;
  /** Translations that did not fit in place and are offered on a marker instead. */
  overflowed: number;
  /** Blocks whose translation stream failed, counted apart from ones that did not fit. */
  failed: number;
}

/**
 * Page whose box covers the most of the actual viewport, or `null` when none does.
 *
 * Used for translation focus. Nearby pages in a parse/draw margin are ignored on purpose.
 */
export function focusedPdfPage(
  pages: readonly { index: number; top: number; bottom: number }[],
  viewHeight: number,
): number | null {
  if (viewHeight <= 0) return null;
  let best: number | null = null;
  let bestVisible = 0;
  let bestTop = Infinity;
  for (const page of pages) {
    const visible = Math.min(page.bottom, viewHeight) - Math.max(page.top, 0);
    if (visible <= 0) continue;
    const top = Math.abs(page.top);
    if (visible > bestVisible + 1 || (Math.abs(visible - bestVisible) <= 1 && top < bestTop)) {
      bestVisible = visible;
      bestTop = top;
      best = page.index;
    }
  }
  return best;
}

/**
 * Renders a PDF as page images with translated text laid over them.
 *
 * The page image is the page's own appearance, drawn once by pdf.js, and the translation is
 * absolutely positioned boxes on top. Nothing reflows: the layout a reader remembers from the
 * original is still there underneath, which is the whole point of reading a paper this way.
 *
 * Pages are drawn and parsed lazily. A 40-page report is 40 canvases and 40 text extractions,
 * and a reader who opens it at page 30 should not wait for 29 pages of work. The page nearest
 * the viewport is drawn, parsed and translated first; everything else follows when it comes
 * near.
 */
export class PdfReader {
  private readonly root: HTMLElement;
  private readonly document: PdfDocument;
  private readonly labels: ReaderLabels;
  private readonly onProgress: (state: ReaderProgress) => void;
  private readonly measurer = new TextMeasurer();
  private readonly session: PdfSession;
  /** The engine, kept so a selection can be translated on its own. */
  private readonly engine: PdfEngine;
  private glossary: readonly { source: string; target: string }[];
  private selectionController: AbortController | null = null;
  private selectionPopover: HTMLElement | null = null;
  private overflowNote: { element: PageElement; state: BlockState } | null = null;
  private readonly onDocumentClick = (event: MouseEvent) => this.closeOverflowNote(event);
  private readonly pageElements = new Map<number, PageElement>();
  private readonly observer: IntersectionObserver;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly geometries: PageGeometry[];
  private readonly geometryByIndex: ReadonlyMap<number, PageGeometry>;
  private readonly pageLimit: number | null;
  private readonly ops: Record<string, number> | null;
  private readonly parsed = new Set<number>();
  private parsing: Promise<void> | null = null;
  private visible = true;
  private scale = 1;
  private focus = 0;
  private compare = false;
  private emptyPages = 0;
  /** Blocks left in the page's own typesetting: equations and the text inside figures. */
  private skippedBlocks = 0;
  private coverageSweepPass = 0;
  private target: string;
  private form: Formality;
  private style: HTMLStyleElement | null = null;
  private destroyed = false;

  constructor(root: HTMLElement, geometries: readonly PageGeometry[], options: ReaderOptions) {
    this.root = root;
    this.root.dataset.compare = 'false';
    this.document = options.document;
    this.labels = options.labels;
    this.onProgress = options.onProgress;
    this.geometries = [...geometries];
    this.geometryByIndex = new Map(geometries.map((geometry) => [geometry.index, geometry]));
    this.pageLimit =
      options.pageLimit !== undefined && options.pageLimit > 0 ? options.pageLimit : null;
    this.ops = options.ops ?? null;
    this.target = options.targetLanguage;
    this.form = options.form;
    this.engine = options.engine;
    this.glossary = options.glossary ?? [];

    this.session = new PdfSession({
      engine: options.engine,
      targetLanguage: options.targetLanguage,
      form: options.form,
      ...(options.glossary ? { glossary: options.glossary } : {}),
      onChange: () => this.paint(),
      measure: (text, size, traits) =>
        this.measurer.measure(text, size, traits, scriptOf(this.target)),
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    });
    this.installStyle();
    this.buildPages();
    this.scale = this.fitScale();
    this.applyScale();

    this.observer = new IntersectionObserver(
      (entries) => this.onIntersect(entries),
      // `root: null` is the viewport. `#pages` does not scroll — its overflow is visible and
      // the window is the scroller — so using it as root never fires on scroll, never updates
      // focus, never releases far canvases, and draws every page at once.
      { root: null, rootMargin: '120% 0px 120% 0px', threshold: 0 },
    );
    for (const element of this.pageElements.values()) this.observer.observe(element.host);

    this.resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.refit());
    this.resizeObserver?.observe(this.root);
    document.addEventListener('click', this.onDocumentClick);
  }

  /** Starts parsing and translating. Called when the reader is ready to show anything. */
  start(): void {
    void this.parseNext();
  }

  /** Re-queues blocks that never got a translation, once the model is ready. */
  retryUntranslated(): void {
    this.session.retryUntranslated();
  }

  /** Re-queues blocks whose stream failed or was cut off, so a retry can finish them. */
  retryFailed(): void {
    this.session.retryFailed();
  }

  /** True when the reader is showing original and translation side by side. */
  isCompare(): boolean {
    return this.compare;
  }

  /**
   * Shows the original page on the left and the translated page on the right, or the single
   * translated view. Scroll and scale stay shared: each row is one page in both columns.
   */
  setCompare(on: boolean): void {
    if (this.compare === on) return;
    this.compare = on;
    this.root.dataset.compare = on ? 'true' : 'false';
    if (on) {
      for (const element of this.pageElements.values()) {
        if (element.drawn) copyOriginalCanvas(element, true);
      }
    } else {
      for (const element of this.pageElements.values()) copyOriginalCanvas(element, false);
    }
    this.applyScale();
  }

  /**
   * Translates whatever the reader has selected, and shows the result beside it.
   *
   * Selection is the one way to read a paper that needs no layout decisions: the reader chose
   * the words, so the translation can be shown as a panel rather than fitted into a box. It
   * is also the answer for a part the automatic pass deliberately leaves alone — an equation's
   * caption, a figure's axis labels — where "select it and ask" respects the drawing instead of
   * painting over it.
   */
  async translateSelection(): Promise<boolean> {
    const selection = globalThis.getSelection?.() ?? null;
    const text = selection?.toString().replace(/\s+/gu, ' ').trim() ?? '';
    if (text.length === 0) return false;

    const host = this.pageHostFor(selection);
    if (!host) return false;

    const controller = new AbortController();
    this.selectionController?.abort();
    this.selectionController = controller;

    const popover = this.popoverFor(host);
    popover.hidden = false;
    popover.dataset.state = 'running';
    popover.textContent = this.labels.selectionTranslating;

    try {
      let translated = '';
      for await (const chunk of this.engine.translate([{ id: 'selection', text }], {
        tgt: this.target,
        form: this.form,
        priority: 0,
        signal: controller.signal,
        ...(this.glossary.length > 0 ? { glossary: this.glossary } : {}),
      })) {
        if (controller.signal.aborted) return false;
        if (chunk.error === true) {
          translated = '';
          break;
        }
        if (chunk.textDelta !== undefined) {
          translated = chunk.restart === true ? chunk.textDelta : translated + chunk.textDelta;
        }
        if (chunk.final !== undefined) translated = chunk.final;
        popover.textContent = translated;
        this.placePopover(popover, host);
      }
      const done = translated.trim().length > 0;
      popover.dataset.state = done ? 'done' : 'failed';
      if (!done) popover.textContent = this.labels.selectionFailed;
      this.placePopover(popover, host);
      this.selectionPopover = popover;
      return done;
    } catch {
      popover.dataset.state = 'failed';
      popover.textContent = this.labels.selectionFailed;
      this.selectionPopover = popover;
      return false;
    }
  }

  /** Hides the panel a selection's translation was shown in. */
  clearSelectionTranslation(): void {
    this.selectionController?.abort();
    this.selectionController = null;
    if (this.selectionPopover) this.selectionPopover.hidden = true;
    this.selectionPopover = null;
  }

  /** The page element a selection starts in, which decides where the panel goes. */
  private pageHostFor(selection: Selection | null): HTMLElement | null {
    const node = selection?.anchorNode ?? null;
    const element =
      node === null ? null : node.nodeType === 1 ? (node as Element) : node.parentElement;
    const host = element?.closest('.sakutto-page');
    return host instanceof HTMLElement ? host : null;
  }

  private popoverFor(host: HTMLElement): HTMLElement {
    for (const element of this.pageElements.values()) {
      if (element.host === host) return element.popover;
    }
    return (
      host.querySelector<HTMLElement>('.sakutto-select') ??
      host.appendChild(
        Object.assign(document.createElement('div'), { className: 'sakutto-select' }),
      )
    );
  }

  /**
   * Puts the panel at the selection, under it when there is room and above it otherwise.
   *
   * The panel is inside the page element, so its position is in the page's own scaled
   * coordinates and scrolls with the page.
   */
  private placePopover(popover: HTMLElement, host: HTMLElement): void {
    const selection = globalThis.getSelection?.() ?? null;
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0).getBoundingClientRect();
    const origin = popover.offsetParent instanceof HTMLElement ? popover.offsetParent : host;
    const page = origin.getBoundingClientRect();
    if (range.width === 0 && range.height === 0) return;

    const width = Math.min(420, Math.max(220, page.width - 24));
    const left = Math.min(Math.max(8, range.left - page.left), Math.max(8, page.width - width - 8));
    popover.style.width = `${width.toFixed(0)}px`;
    popover.style.left = `${left.toFixed(0)}px`;

    // Measured after the text is in, so the panel knows how tall it will be before deciding
    // which side of the selection fits.
    const height = popover.offsetHeight || 60;
    const below = range.bottom - page.top + 8;
    const above = range.top - page.top - height - 8;
    popover.style.top = `${(below + height < page.height - 8 || above < 8 ? below : above).toFixed(0)}px`;
  }

  setTargetLanguage(language: string, form: Formality = this.form): void {
    if (language === this.target && form === this.form) return;
    this.target = language;
    this.form = form;
    this.session.setTargetLanguage(language, form);
    this.paint();
  }

  setGlossary(glossary: readonly { source: string; target: string }[]): void {
    this.glossary = glossary;
    this.session.setGlossary(glossary);
  }

  /** Pauses translating while the tab is hidden, and resumes when it is shown again. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) void this.parseNext();
  }

  destroy(): void {
    this.destroyed = true;
    this.observer.disconnect();
    this.resizeObserver?.disconnect();
    document.removeEventListener('click', this.onDocumentClick);
    this.session.dispose();
    this.style?.remove();
    this.style = null;
    this.root.replaceChildren();
    void this.document.destroy().catch(() => undefined);
  }

  private installStyle(): void {
    const style = document.createElement('style');
    style.textContent = READER_STYLE;
    document.head.append(style);
    this.style = style;
  }

  /**
   * Builds one element per page, at the page's own size scaled to the reader's width.
   *
   * Every page is created up front so the scrollbar describes the whole document from the
   * first paint; only the visible ones get a canvas.
   */
  private buildPages(): void {
    for (const geometry of this.geometries) {
      const host = document.createElement('div');
      host.className = 'sakutto-page';
      host.dataset.page = String(geometry.index);
      host.style.aspectRatio = `${String(geometry.width)} / ${String(geometry.height)}`;

      const originalPane = document.createElement('div');
      originalPane.className = 'sakutto-page__pane sakutto-page__pane--original';
      const originalCaption = document.createElement('div');
      originalCaption.className = 'sakutto-page__caption';
      originalCaption.textContent = this.labels.compareOriginal;
      const originalStage = document.createElement('div');
      originalStage.className = 'sakutto-page__stage';
      const originalCanvas = document.createElement('canvas');
      originalCanvas.className = 'sakutto-page__canvas sakutto-page__canvas--original';
      originalCanvas.setAttribute('aria-hidden', 'true');
      originalStage.append(originalCanvas);
      originalPane.append(originalCaption, originalStage);

      const translatedPane = document.createElement('div');
      translatedPane.className = 'sakutto-page__pane sakutto-page__pane--translated';
      const translatedCaption = document.createElement('div');
      translatedCaption.className = 'sakutto-page__caption';
      translatedCaption.textContent = this.labels.compareTranslated;
      const translatedStage = document.createElement('div');
      translatedStage.className = 'sakutto-page__stage';

      const canvas = document.createElement('canvas');
      canvas.className = 'sakutto-page__canvas';
      canvas.setAttribute('aria-hidden', 'true');

      // The text layer sits above the translation, not below it. Its glyphs are transparent
      // and it exists so a reader can select the source text — to copy a phrase, or to
      // translate only that part. Under the covers it would be unreachable: a translated box
      // paints the paper colour over its own block, and a selection cannot start inside an
      // element that is covered by another.
      const text = document.createElement('div');
      text.className = 'sakutto-page__text';
      text.setAttribute('aria-hidden', 'true');

      const layer = document.createElement('div');
      layer.className = 'sakutto-page__layer';

      const missing = document.createElement('div');
      missing.className = 'sakutto-page__missing';
      missing.textContent = this.labels.emptyPage;
      const broken = document.createElement('div');
      broken.className = 'sakutto-page__render-failed';
      broken.textContent = this.labels.renderFailed;

      // The selection's own translation, shown beside the selection rather than over it: a
      // reader who asks for one paragraph wants to compare it with the original, and a box
      // drawn over the selection would hide the words they chose.
      const popover = document.createElement('div');
      popover.className = 'sakutto-select';
      popover.hidden = true;
      const note = document.createElement('div');
      note.className = 'sakutto-select sakutto-note';
      note.hidden = true;

      translatedStage.append(canvas, layer, text, missing, broken, popover, note);
      translatedPane.append(translatedCaption, translatedStage);
      host.append(originalPane, translatedPane);
      this.root.append(host);
      this.pageElements.set(geometry.index, {
        host,
        originalPane,
        translatedPane,
        originalStage,
        translatedStage,
        originalCanvas,
        canvas,
        text,
        layer,
        missing,
        popover,
        note,
        drawn: false,
        drawGeneration: 0,
        covers: new Map(),
        markers: new Map(),
      });
    }
  }

  /** Scale that makes the widest page fill the reader, capped so a wide window does not blur. */
  private fitScale(): number {
    const gap = this.compare ? 12 : 0;
    const columns = this.compare ? 2 : 1;
    const width = (this.root.clientWidth - 36 - gap) / columns;
    const widest = Math.max(...this.geometries.map((geometry) => geometry.width), 1);
    // 1.6× is about 115 dpi on an A4 page: legible at a normal reading distance without
    // making the canvas cost grow with the window.
    const scale = width > 0 ? width / widest : 1;
    return Math.min(Math.max(scale, 0.4), 1.6);
  }

  private refit(): void {
    const next = this.fitScale();
    if (Math.abs(next - this.scale) < 0.01) return;
    this.scale = next;
    this.applyScale();
  }

  private applyScale(): void {
    for (const [index, element] of this.pageElements) {
      const geometry = this.geometryByIndex.get(index);
      if (!geometry) continue;
      const pageWidth = geometry.width * this.scale;
      const pageHeight = geometry.height * this.scale;
      element.host.style.width = this.compare
        ? `${(pageWidth * 2 + 12).toFixed(2)}px`
        : `${pageWidth.toFixed(2)}px`;
      element.host.style.height = this.compare ? '' : `${pageHeight.toFixed(2)}px`;
      element.translatedPane.style.width = `${pageWidth.toFixed(2)}px`;
      element.originalPane.style.width = `${pageWidth.toFixed(2)}px`;
      element.translatedStage.style.height = `${pageHeight.toFixed(2)}px`;
      element.originalStage.style.height = `${pageHeight.toFixed(2)}px`;
      // A canvas drawn at the old scale has the wrong size for the new one. Cancelling
      // bumps the draw generation so the abandoned render cannot mark this as a failure.
      element.drawn = false;
      cancelPageDraw(element);
    }
    this.paint();
    this.redrawVisiblePages();
    this.updateFocus();
    void this.parseNext();
  }

  /** True when a page host sits in or near the window, so a resize can redraw it. */
  private pageNearViewport(host: HTMLElement): boolean {
    const rect = host.getBoundingClientRect();
    const view = globalThis.innerHeight || 0;
    const margin = view * 1.2;
    return rect.bottom >= -margin && rect.top <= view + margin;
  }

  /**
   * IntersectionObserver only fires when a page *crosses* the viewport. A window resize
   * changes the canvas CSS size without that crossing, so visible pages have to be redrawn
   * here or they keep the bitmap from the previous width.
   */
  private redrawVisiblePages(): void {
    for (const [index, element] of this.pageElements) {
      if (!this.pageNearViewport(element.host)) continue;
      void this.drawPage(index);
    }
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const index = Number((entry.target as HTMLElement).dataset.page);
      if (!Number.isFinite(index)) continue;
      void this.drawPage(index);
      void this.parseNext();
    }
    this.updateFocus();
  }

  /**
   * Translation focus follows the page that actually covers the viewport.
   *
   * The observer's 120% margin is only for drawing and parsing nearby pages. A page that
   * merely entered that band must not steal the queue: IntersectionObserver callbacks list
   * only the pages that crossed, so a far page would otherwise become `focus` while the
   * page on screen still has untranslated paragraphs.
   */
  private updateFocus(): void {
    const view = globalThis.innerHeight || this.root.clientHeight || 0;
    const pages: { index: number; top: number; bottom: number }[] = [];
    for (const [index, element] of this.pageElements) {
      const rect = element.host.getBoundingClientRect();
      pages.push({ index, top: rect.top, bottom: rect.bottom });
    }
    const nearest = focusedPdfPage(pages, view);
    if (nearest === null || nearest === this.focus) return;
    this.focus = nearest;
    this.session.focusPage(nearest);
    this.releaseFarPages();
  }

  /**
   * Drops the bitmap of a page that is several screens away, so a long document does not
   * keep every canvas resident. The element stays, so the scrollbar still describes the
   * whole file; the page is redrawn when it comes near again.
   */
  private releaseFarPages(): void {
    for (const [index, element] of this.pageElements) {
      if (Math.abs(index - this.focus) <= 4) continue;
      if (!element.drawn && element.renderTask === undefined) continue;
      cancelPageDraw(element);
      // The cancelled task, if any, still owns the detached canvas. This one is unused.
      element.canvas.width = 0;
      element.canvas.height = 0;
      copyOriginalCanvas(element, false);
      element.drawn = false;
    }
  }

  private async drawPage(index: number, attempt = 0): Promise<void> {
    const element = this.pageElements.get(index);
    if (!element || this.destroyed) return;
    if (element.drawn) return;

    // Capture the generation *after* cancelling so an in-flight draw from a previous
    // call cannot share this number and write `data-render-failed` when it is dropped.
    cancelPageDraw(element);
    const generation = element.drawGeneration;

    try {
      const page = await this.document.getPage(index + 1);
      if (this.destroyed || element.drawGeneration !== generation) return;
      const task = renderPage(page, this.scale, element.canvas);
      element.renderTask = task;
      await task.promise;
      if (this.destroyed || element.drawGeneration !== generation) return;
      element.drawn = true;
      delete element.renderTask;
      element.host.removeAttribute('data-render-failed');
      copyOriginalCanvas(element, this.compare);
    } catch (error) {
      if (this.destroyed || element.drawGeneration !== generation) return;
      delete element.renderTask;
      if (isRenderCancelled(error)) return;
      if (attempt < 1) {
        void this.drawPage(index, attempt + 1);
        return;
      }
      element.host.dataset.renderFailed = 'true';
    }
  }

  /**
   * Parses one page's text, nearest the reader first.
   *
   * Only one page is parsed at a time. Extracting a page's text costs a content-stream parse,
   * and doing several at once competes with the model for the main thread — which is what a
   * reader would feel as the page stuttering while it translates.
   */
  private async parseNext(): Promise<void> {
    if (this.parsing || this.destroyed || !this.visible) return;
    const next = this.nextPageToParse();
    if (next === null) return;

    this.parsing = (async () => {
      try {
        const page = await this.document.getPage(next + 1);
        const extracted = await extractPage(page, next, this.ops);
        if (this.destroyed) return;
        this.parsed.add(next);
        const element = this.pageElements.get(next);

        if (extracted.empty) {
          this.emptyPages += 1;
          if (element) element.host.dataset.pageEmpty = 'true';
          this.session.addPage(
            next,
            {
              blocks: [],
              bodySize: 0,
              lineHeight: 0,
              skipped: [],
              pageHeight: extracted.height,
              pageWidth: extracted.width,
              pageIndex: next,
              obstacles: extracted.figures.images ?? [],
            },
            extracted.height,
          );
        } else {
          const layout = layoutPage(extracted.lines, extracted.figures, {
            width: extracted.width,
            height: extracted.height,
            index: next,
          });
          this.skippedBlocks += layout.skipped.length;
          this.session.addPage(next, layout, extracted.height);
        }
        if (element) this.paintTextLayer(element, extracted.lines);
        this.session.focusPage(this.focus);
        this.report();
      } catch {
        this.parsed.add(next);
      } finally {
        this.parsing = null;
        void this.parseNext();
      }
    })();
  }

  /** The page nearest the reader that has not been parsed. */
  private nextPageToParse(): number | null {
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const geometry of this.geometries) {
      if (this.parsed.has(geometry.index)) continue;
      if (this.pageLimit !== null && this.parsed.size >= this.pageLimit) {
        if (!this.parsed.has(this.focus)) continue;
        // Only pages near the reader may exceed the limit, so a reader who scrolls far past it
        // still gets the page in front of them.
        if (Math.abs(geometry.index - this.focus) > 1) continue;
      }
      const distance = Math.abs(geometry.index - this.focus);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = geometry.index;
      }
    }
    return best;
  }

  /**
   * Draws every translated block of every parsed page.
   *
   * A paint is a diff against what is already on screen: a block whose translation has not
   * changed keeps its element, so streaming text updates only the boxes that grew. Recreating
   * a page's boxes on every delta is what makes a streaming translation feel like it flickers.
   */
  private paint(): void {
    if (this.destroyed) return;
    for (const [index, element] of this.pageElements) {
      if (!this.parsed.has(index)) continue;
      const states = this.session.pageBlocks(index);
      const live = new Set<BlockState>();
      const marked = new Set<BlockState>();

      for (const state of states) {
        if (state.paint && state.fit?.fits === true && state.translation.trim().length > 0) {
          live.add(state);
          this.paintBlock(element, state, index);
          continue;
        }
        if (state.overflow) {
          marked.add(state);
          this.paintMarker(element, state);
        }
      }

      for (const [key, node] of element.covers) {
        if (live.has(key)) continue;
        node.remove();
        element.covers.delete(key);
      }
      for (const [key, node] of element.markers) {
        if (marked.has(key)) continue;
        node.remove();
        element.markers.delete(key);
      }
    }
    this.runCoverageSweep();
    this.report();
  }

  private runCoverageSweep(): void {
    if (this.coverageSweepPass >= 3) return;
    const progress = this.session.progress();
    if (progress.pending > 0) return;
    const requeued = this.session.sweepIncompleteBlocks();
    if (requeued > 0) this.coverageSweepPass += 1;
  }

  private paintBlock(element: PageElement, state: BlockState, pageIndex: number): void {
    const fit = state.fit;
    if (!fit) return;

    let node = element.covers.get(state);
    if (!node) {
      node = document.createElement('div');
      node.className = 'sakutto-cover';
      node.setAttribute('translate', 'no');
      element.layer.append(node);
      element.covers.set(state, node);
    }

    const block = state.block;
    const traits = traitsOf(block);
    const scale = this.scale;
    const visible = fit.lines;
    const pageWidth = this.geometryByIndex.get(pageIndex)?.width ?? 0;
    const drawn = drawnBox(block, fit, fit.width, pageWidth);
    const padTop = block.fontSize * COVER_PAD_TOP_EM * scale;
    const painted = coverPaintLayout(block, fit.width, drawn, scale, pageWidth);

    // Layout wraps to `HINTING_WRAP` of `fit.width` so canvas measure at the source point
    // size and CSS at `fontSize * scale` px can disagree by a hair. The cover is at least
    // that wrap, plus `HINTING_PAD_PX`, with centre/right alignment kept on the source box.
    // Height follows `drawnBox` so descender padding is not stacked on a grown translation.
    const along = Math.max(block.advance, fit.width, drawn.height) * scale + HINTING_PAD_PX;
    const box = verticalWriting(block)
      ? {
          x:
            (block.writing === 270
              ? block.box.x
              : block.box.x + Math.max(block.box.width, fit.height)) *
              scale -
            padTop,
          y:
            (block.writing === 270
              ? block.box.y + Math.max(block.box.height, block.advance)
              : block.box.y) *
              scale -
            padTop,
          width: along,
          height: drawn.width * scale,
        }
      : {
          x: painted.x * scale,
          y: drawn.y * scale - padTop,
          width: painted.width * scale,
          height: drawn.height * scale + padTop,
        };

    node.dataset.fitWidth = fit.width.toFixed(2);
    node.textContent = visible.join('\n');
    node.style.cssText = coverStyle(
      box,
      fit.fontSize * scale,
      fit.lineHeight * scale,
      traits,
      block.align,
      scriptOf(this.target),
    );
    if (verticalWriting(block)) {
      node.style.height = `${(drawn.width * scale).toFixed(2)}px`;
      node.style.transformOrigin = '0 0';
      node.style.transform = block.writing === 270 ? 'rotate(-90deg)' : 'rotate(90deg)';
    } else {
      node.style.height = `${box.height.toFixed(2)}px`;
      node.style.transform = '';
    }
    node.dataset.state = state.state === 'done' ? 'done' : 'running';
    node.dataset.clipped = 'false';
    // The source box, in page units, so a test can check the geometry without re-parsing.
    node.dataset.source = [block.box.x, block.box.y, block.box.width, block.box.height]
      .map((value) => value.toFixed(2))
      .join(',');
    node.setAttribute('lang', this.target);
    node.dir = 'auto';
  }

  /**
   * A small marker on a source box whose translation did not fit. Opening it shows the full
   * text in a panel; the page itself keeps the original typesetting, so nothing is cut short.
   */
  private paintMarker(element: PageElement, state: BlockState): void {
    let node = element.markers.get(state);
    if (!node) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sakutto-overflow';
      button.setAttribute('aria-label', this.labels.overflowOpen);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.toggleOverflowNote(element, state, button);
      });
      element.host.append(button);
      element.markers.set(state, button);
      node = button;
    }

    const scale = this.scale;
    const box = state.block.box;
    const size = Math.max(12, Math.min(16, Math.max(box.height * scale * 0.4, 12)));
    node.style.left = `${((box.x + box.width) * scale - size / 2).toFixed(2)}px`;
    node.style.top = `${(box.y * scale - size / 2).toFixed(2)}px`;
    node.style.width = `${size.toFixed(2)}px`;
    node.style.height = `${size.toFixed(2)}px`;
    node.setAttribute(
      'aria-expanded',
      this.overflowNote?.state === state && this.overflowNote.element === element
        ? 'true'
        : 'false',
    );
  }

  private toggleOverflowNote(element: PageElement, state: BlockState, marker: HTMLElement): void {
    if (this.overflowNote?.state === state && this.overflowNote.element === element) {
      this.hideOverflowNote();
      return;
    }
    this.hideOverflowNote();
    element.note.hidden = false;
    element.note.textContent =
      state.translation.trim().length > 0 ? state.translation : this.labels.failed;
    const host = element.host.getBoundingClientRect();
    const mark = marker.getBoundingClientRect();
    const width = Math.min(360, Math.max(200, host.width - 24));
    const left = Math.min(
      Math.max(8, mark.left - host.left - 8),
      Math.max(8, host.width - width - 8),
    );
    element.note.style.width = `${width.toFixed(0)}px`;
    element.note.style.left = `${left.toFixed(0)}px`;
    const height = element.note.offsetHeight || 60;
    const below = mark.bottom - host.top + 6;
    const above = mark.top - host.top - height - 6;
    element.note.style.top = `${(below + height < host.height - 8 || above < 8 ? below : above).toFixed(0)}px`;
    this.overflowNote = { element, state };
  }

  private hideOverflowNote(): void {
    if (!this.overflowNote) return;
    this.overflowNote.element.note.hidden = true;
    this.overflowNote = null;
  }

  private closeOverflowNote(event: MouseEvent): void {
    if (!this.overflowNote) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.overflowNote.element.note.contains(target)) return;
    if ([...this.overflowNote.element.markers.values()].some((node) => node.contains(target))) {
      return;
    }
    this.hideOverflowNote();
  }

  /**
   * Draws the invisible text a reader can select.
   *
   * One span per source line, positioned where the line sits and set at its own size, so a
   * drag that crosses a line selects the same characters it appears to. The glyphs are
   * transparent rather than hidden: `visibility: hidden` and `display: none` both take a span
   * out of selection entirely, which is the one thing this layer exists for.
   */
  private paintTextLayer(element: PageElement, lines: readonly TextLine[]): void {
    const scale = this.scale;
    const nodes: HTMLElement[] = [];
    for (const line of lines) {
      if (line.text.trim().length === 0) continue;
      const span = document.createElement('span');
      span.textContent = line.text;
      span.style.left = `${(line.box.x * scale).toFixed(2)}px`;
      span.style.top = `${(line.box.y * scale).toFixed(2)}px`;
      span.style.fontSize = `${Math.max(1, line.height * scale).toFixed(2)}px`;
      span.style.lineHeight = `${Math.max(1, line.box.height * scale).toFixed(2)}px`;
      span.style.width = `${Math.max(1, line.box.width * scale).toFixed(2)}px`;
      // A translated page draws its translation over the source, so the selectable text has
      // to be invisible but still laid out. `color: transparent` keeps it selectable.
      nodes.push(span);
    }
    element.text.replaceChildren(...nodes);
  }

  private report(): void {
    const progress = this.session.progress();
    const rates = this.session.ratesNow();
    this.onProgress({
      ...progress,
      parsed: this.parsed.size,
      pages: this.geometries.length,
      emptyPages: this.emptyPages,
      tokensPerSecond: rates.tokensPerSecond,
      segmentsPerSecond: rates.segmentsPerSecond,
      keptAsIs: this.skippedBlocks,
      overflowed: progress.overflowed,
      failed: progress.failed,
    });
  }

  /** The measured text of one block, for a caller that wants to check the fit. */
  measureBlock(block: LayoutBlock, text: string, fontSize: number): number {
    return this.measurer.measure(text, fontSize, traitsOf(block), scriptOf(this.target));
  }

  /**
   * What a page currently shows, for a test to check the geometry rather than the pixels.
   *
   * Each entry pairs the box the source text occupied with the box drawn over it, so a test
   * can assert that every block the layout found is covered, and that the text drawn on a
   * block was fitted to the room the block has.
   */
  coverage(page: number): CoverageEntry[] {
    const element = this.pageElements.get(page);
    if (!element) return [];
    const entries: CoverageEntry[] = [];
    for (const state of this.session.pageBlocks(page)) {
      const node = element.covers.get(state);
      entries.push({
        role: state.block.role,
        state: state.state,
        source: state.block.box,
        sourceText: state.block.text,
        translation: state.translation,
        fontSize: state.block.fontSize,
        fittedSize: state.fit?.fontSize ?? null,
        fits: state.paint && state.fit?.fits === true,
        overflow: state.overflow,
        lines: state.fit
          ? state.fit.fits
            ? state.fit.lines.length
            : state.fit.visibleLines.length
          : 0,
        drawn: node
          ? {
              left: Number.parseFloat(node.style.left),
              top: Number.parseFloat(node.style.top),
              width: Number.parseFloat(node.style.width),
              height: Number.parseFloat(node.style.height),
            }
          : null,
      });
    }
    return entries;
  }

  /** Pages whose text has been parsed so far. */
  parsedPages(): number[] {
    return [...this.parsed].sort((left, right) => left - right);
  }
}

export interface CoverageEntry {
  role: string;
  state: string;
  /** The box the source text occupied, in page points. */
  source: { x: number; y: number; width: number; height: number };
  sourceText: string;
  translation: string;
  fontSize: number;
  fittedSize: number | null;
  fits: boolean | null;
  overflow: boolean;
  lines: number;
  /** The box drawn over it, in rendered pixels; null when the block paints nothing. */
  drawn: { left: number; top: number; width: number; height: number } | null;
}

interface PageElement {
  host: HTMLElement;
  originalPane: HTMLElement;
  translatedPane: HTMLElement;
  originalStage: HTMLElement;
  translatedStage: HTMLElement;
  originalCanvas: HTMLCanvasElement;
  canvas: HTMLCanvasElement;
  /** Transparent glyphs a reader can select; the visible text is a canvas or a cover. */
  text: HTMLElement;
  layer: HTMLElement;
  missing: HTMLElement;
  /** The box a selection's translation is shown in. */
  popover: HTMLElement;
  /** The box a marker's translation is shown in. */
  note: HTMLElement;
  drawn: boolean;
  /** Bumped when a newer draw replaces an in-flight one, so the stale render is ignored. */
  drawGeneration: number;
  renderTask?: { promise: Promise<void>; cancel?: () => void };
  covers: Map<BlockState, HTMLElement>;
  markers: Map<BlockState, HTMLButtonElement>;
}

function copyOriginalCanvas(element: PageElement, compare: boolean): void {
  const target = element.originalCanvas;
  if (!compare) {
    if (target.width !== 0 || target.height !== 0) {
      target.width = 0;
      target.height = 0;
    }
    return;
  }
  const source = element.canvas;
  if (source.width === 0 || source.height === 0) return;
  target.width = source.width;
  target.height = source.height;
  const context = target.getContext('2d');
  if (context && typeof context.drawImage === 'function') context.drawImage(source, 0, 0);
}

function cancelPageDraw(element: PageElement): void {
  element.drawGeneration += 1;
  const task = element.renderTask;
  if (!task) return;
  task.cancel?.();
  delete element.renderTask;
  // pdf.js may still write to the canvas until the cancelled promise settles. Detach it
  // so shrinking the bitmap or starting a new draw cannot race with that write.
  const next = document.createElement('canvas');
  next.className = element.canvas.className;
  next.setAttribute('aria-hidden', 'true');
  element.canvas.replaceWith(next);
  element.canvas = next;
  void task.promise.catch(() => undefined);
}

function isRenderCancelled(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = 'name' in error ? String(error.name) : '';
  return name === 'RenderingCancelledException' || name === 'AbortException';
}

function scriptOf(target: string): 'ja' | 'en' | 'other' {
  if (target === 'ja') return 'ja';
  if (target === 'en') return 'en';
  return 'other';
}
