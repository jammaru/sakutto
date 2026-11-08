import type { Page } from '@playwright/test';

/**
 * Marks a fixture block the bench follows. `prose` is body copy, `heading` a section or
 * page title, `ui` navigation/labels/metadata, `code` literal text that must not change.
 */
export type BenchKind = 'prose' | 'heading' | 'ui' | 'code';

export interface BlockCounts {
  total: number;
  prose: number;
  headings: number;
  ui: number;
  code: number;
  visibleProse: number;
  /** Blocks with a finished translation at the end of the run. */
  finished: number;
}

/** One observation of how far the page had got, in milliseconds since the run started. */
export interface TimelineSample {
  atMs: number;
  done: number;
  total: number;
  state: string | null;
}

/** The `sakutto-perf` payload the content script already writes for the e2e suite. */
export interface PerfPayload {
  startedAt: number;
  firstTextAt: number | null;
  tokensPerSecond: number | null;
  segmentsPerSecond: number | null;
  segments: { id: string; ms: number }[];
  /** Scheduling counters added for the page bench: how the page drove the engine. */
  batches?: number;
  pieces?: number;
  engineMs?: number;
}

export interface RecordedPage {
  /** Harness command to the first changed block of any kind. */
  firstTextMs: number | null;
  /** Same, restricted to prose that was on screen when the recorder first saw it. */
  firstVisibleTextMs: number | null;
  /** Every prose block that was on screen when first seen has a finished translation. */
  viewportDoneMs: number | null;
  /** Every tracked block finished translating. Null when some block never finished. */
  fullPageMs: number | null;
  /** `translated`, `partial`, or whatever the page was showing when the run stopped. */
  state: string | null;
  progress: string | null;
  rate: string | null;
  blocks: BlockCounts;
  /** Marked blocks the extension never finished, by id. Empty on a clean run. */
  unfinished: string[];
  /** Blocks that entered the DOM after the run started, e.g. a client-rendered feed. */
  lateBlocks: number;
  /** How many tracked blocks carry each `data-sakutto-engine` value. */
  engines: Record<string, number>;
  /** True when literal `code` blocks kept their exact source text. */
  codeUntouched: boolean | null;
  timeline: TimelineSample[];
  perf: PerfPayload | null;
  timedOut: boolean;
}

interface RecorderInput {
  settleMs: number;
  timeoutMs: number;
}

/**
 * Installs the recorder in the page. It only reads the DOM; the extension does all the
 * work through its normal content script, so a recorded run is a real user-visible run.
 */
function installRecorder(input: RecorderInput): void {
  interface Tracked {
    el: Element;
    id: string;
    kind: string;
    original: string;
    visible: boolean;
    firstChangeMs: number | null;
    doneMs: number | null;
  }

  interface RecorderState {
    startedAt: number;
    tracked: Tracked[];
    seen: Set<string>;
    timeline: TimelineSample[];
    lastDone: number;
    lastState: string | null;
    /** When the last tracked block finished; null while any is unfinished. */
    allDoneAt: number | null;
    timedOut: boolean;
    finishedAt: number | null;
    lateBlocks: number;
    timer: ReturnType<typeof setInterval> | null;
  }

  const tracker = globalThis as unknown as {
    __sakuttoBenchRecorder?: RecorderState;
    __sakuttoBenchStart?: () => void;
    __sakuttoBenchRead?: () => RecordedPage;
  };

  const textOf = (el: Element): string => (el.textContent ?? '').trim();
  const viewport = (): number => window.innerHeight || 800;

  /**
   * Whether the element is painted at all. `checkVisibility` covers `display:none`,
   * `visibility:hidden` and `content-visibility:hidden`; a `display: contents` wrapper
   * generates no box but its children paint, so only the element's own style decides.
   */
  const isRendered = (el: Element): boolean => {
    const check = el.checkVisibility?.bind(el);
    if (check?.({ visibilityProperty: true, contentVisibilityAuto: false })) return true;
    const view = el.ownerDocument.defaultView;
    const own = view?.getComputedStyle(el);
    if (own && own.display === 'contents') {
      return own.visibility !== 'hidden' && own.visibility !== 'collapse';
    }
    return false;
  };

  const isVisible = (el: Element): boolean => {
    if (!isRendered(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect.bottom > 0 && rect.top < viewport();
    // A `display: contents` element has no box of its own; ask its children instead.
    for (const child of el.children) {
      const box = child.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) return box.bottom > 0 && box.top < viewport();
    }
    return false;
  };

  /**
   * The element the extension actually marks. A fixture marker may sit on an inline child
   * of the block that was translated (a label inside a row), so the engine attributes have
   * to be read from the nearest ancestor that carries them.
   */
  const owning = (el: Element): Element => el.closest('[data-sakutto-id]') ?? el;

  const collect = (state: RecorderState): void => {
    for (const el of document.querySelectorAll('[data-bench-id]')) {
      const id = el.getAttribute('data-bench-id') ?? '';
      if (id.length === 0 || state.seen.has(id)) continue;
      // A hidden block is not tracked yet: the extension skips hidden regions, so waiting
      // for one to finish would never end. It is picked up on the first tick after its
      // region becomes visible, which is also when a client-rendered feed appears.
      if (!isRendered(el)) continue;
      state.seen.add(id);
      if (state.startedAt > 0) state.lateBlocks += 1;
      state.tracked.push({
        el,
        id,
        kind: el.getAttribute('data-bench') ?? 'ui',
        original: textOf(el),
        visible: isVisible(el),
        firstChangeMs: null,
        doneMs: null,
      });
    }
  };

  const engineCounts = (state: RecorderState): Record<string, number> => {
    const by: Record<string, number> = {};
    for (const item of state.tracked) {
      if (item.kind === 'code') continue;
      const engine = owning(item.el).getAttribute('data-sakutto-engine');
      if (engine !== null) by[engine] = (by[engine] ?? 0) + 1;
    }
    return by;
  };

  /**
   * Updates every tracked block. A block is finished when the extension marked it with an
   * engine and is no longer streaming into it, which is exactly what the overlay shows.
   */
  const measure = (state: RecorderState, atMs: number): number => {
    let done = 0;
    let total = 0;
    for (const item of state.tracked) {
      if (item.kind === 'code') continue;
      total += 1;
      // A block the page removed can never finish; counting it would stall the run until
      // the timeout. Its removal is part of what the page did, not a pending translation.
      if (!item.el.isConnected) {
        done += 1;
        continue;
      }
      const text = textOf(item.el);
      if (text.length > 0 && text !== item.original && item.firstChangeMs === null) {
        item.firstChangeMs = atMs;
      }
      const block = owning(item.el);
      const engine = block.getAttribute('data-sakutto-engine');
      const pending = block.hasAttribute('data-sakutto-pending');
      // A name, a version or a unit translates to itself ("Pro", "BF16"), so an unchanged
      // text cannot mean unfinished. The engine mark without the pending mark is the finish.
      if (text.length > 0 && engine !== null && !pending) {
        if (item.doneMs === null) item.doneMs = atMs;
        done += 1;
      }
    }
    // A page that mounts more content after finishing must not keep its earlier finish
    // time: the new blocks push the total up, so the completion marker is withdrawn.
    if (total > 0 && done >= total) {
      if (state.allDoneAt === null) state.allDoneAt = atMs;
    } else {
      state.allDoneAt = null;
    }
    return done;
  };

  /** A fixture can ask for a longer quiet window, e.g. a page that mounts content late. */
  const settleWindow = (): number => {
    const hinted = Number(document.documentElement.dataset.benchSettle ?? '');
    return Number.isFinite(hinted) && hinted > 0
      ? Math.max(hinted, input.settleMs)
      : input.settleMs;
  };

  const tick = (): void => {
    const state = tracker.__sakuttoBenchRecorder;
    if (!state || state.startedAt === 0 || state.finishedAt !== null) return;
    const atMs = performance.now() - state.startedAt;
    collect(state);
    const done = measure(state, atMs);
    const total = state.tracked.filter((item) => item.kind !== 'code').length;
    const current = document.documentElement.dataset.sakuttoState ?? null;

    if (done !== state.lastDone || current !== state.lastState) {
      state.timeline.push({ atMs: Math.round(atMs), done, total, state: current });
      state.lastDone = done;
      state.lastState = current;
    }

    // The settle window only starts once every marked block has finished, so a run ends
    // after the last paint rather than after the overlay first says "translated".
    if (state.allDoneAt !== null && atMs - state.allDoneAt >= settleWindow()) {
      state.finishedAt = atMs;
      if (state.timer !== null) clearInterval(state.timer);
      return;
    }

    if (atMs > input.timeoutMs) {
      state.timedOut = true;
      state.finishedAt = atMs;
      if (state.timer !== null) clearInterval(state.timer);
    }
  };

  tracker.__sakuttoBenchRecorder = {
    startedAt: 0,
    tracked: [],
    seen: new Set<string>(),
    timeline: [],
    lastDone: -1,
    lastState: null,
    allDoneAt: null,
    timedOut: false,
    finishedAt: null,
    lateBlocks: 0,
    timer: null,
  };

  tracker.__sakuttoBenchStart = (): void => {
    const state = tracker.__sakuttoBenchRecorder;
    if (!state) return;
    collect(state);
    state.startedAt = performance.now();
    state.timer = setInterval(tick, 25);
    tick();
  };

  tracker.__sakuttoBenchRead = (): RecordedPage => {
    const state = tracker.__sakuttoBenchRecorder;
    if (!state) throw new Error('the bench recorder was not installed');
    const atMs = state.startedAt === 0 ? 0 : performance.now() - state.startedAt;
    measure(state, atMs);

    const blocks: BlockCounts = {
      total: 0,
      prose: 0,
      headings: 0,
      ui: 0,
      code: 0,
      visibleProse: 0,
      finished: 0,
    };
    const unfinished: string[] = [];
    for (const item of state.tracked) {
      blocks.total += 1;
      if (item.kind === 'code') {
        blocks.code += 1;
        continue;
      }
      if (item.doneMs !== null) blocks.finished += 1;
      else unfinished.push(item.id);
      if (item.kind === 'prose') {
        blocks.prose += 1;
        if (item.visible) blocks.visibleProse += 1;
      } else if (item.kind === 'heading') blocks.headings += 1;
      else blocks.ui += 1;
    }

    const firstChangeOf = (filter: (item: Tracked) => boolean): number | null => {
      let best: number | null = null;
      for (const item of state.tracked) {
        if (!filter(item) || item.firstChangeMs === null) continue;
        if (best === null || item.firstChangeMs < best) best = item.firstChangeMs;
      }
      return best === null ? null : Math.round(best);
    };

    let viewportDone: number | null = null;
    for (const item of state.tracked) {
      if (item.kind !== 'prose' || !item.visible) continue;
      if (item.doneMs === null) {
        viewportDone = null;
        break;
      }
      viewportDone = Math.max(viewportDone ?? 0, item.doneMs);
    }

    const codeItems = state.tracked.filter((item) => item.kind === 'code');
    const codeUntouched =
      codeItems.length === 0 ? null : codeItems.every((item) => textOf(item.el) === item.original);

    const root = document.documentElement;
    const perfRaw = document.querySelector('sakutto-perf')?.textContent ?? null;
    let perf: PerfPayload | null = null;
    if (perfRaw) {
      try {
        perf = JSON.parse(perfRaw) as PerfPayload;
      } catch {
        perf = null;
      }
    }

    return {
      firstTextMs: firstChangeOf(() => true),
      firstVisibleTextMs: firstChangeOf((item) => item.kind === 'prose' && item.visible),
      viewportDoneMs: viewportDone === null ? null : Math.round(viewportDone),
      fullPageMs: state.timedOut
        ? null
        : state.allDoneAt === null
          ? null
          : Math.round(state.allDoneAt),
      state: root.dataset.sakuttoState ?? null,
      progress: root.dataset.sakuttoProgress ?? null,
      rate: root.dataset.sakuttoRate ?? null,
      blocks,
      unfinished,
      lateBlocks: state.lateBlocks,
      engines: engineCounts(state),
      codeUntouched,
      timeline: state.timeline,
      perf,
      timedOut: state.timedOut,
    };
  };
}

export const PAGE_TIMEOUT_MS = 3 * 60 * 1000;
export const SETTLE_MS = 1200;
/** Mock runs should never need the full live budget; a stall there is a harness bug. */
export const MOCK_TIMEOUT_MS = 25 * 1000;

/**
 * Deterministic synthetic engine cost for mock mode. Roughly a tenth of a real CPU run,
 * but proportional to text length, so batching, packing, chunk splitting and repaint
 * costs still change the clock. Fixed numbers keep mock runs comparable with each other.
 */
export const MOCK_PACE = { ttfbMs: 12, msPerChar: 0.35, deltas: 3 };

export async function installMockPace(page: Page): Promise<void> {
  await page.evaluate((pace) => {
    document.documentElement.setAttribute('data-bench-pace', JSON.stringify(pace));
  }, MOCK_PACE);
}

export async function installPageRecorder(page: Page, timeoutMs = PAGE_TIMEOUT_MS): Promise<void> {
  await page.evaluate(installRecorder, { settleMs: SETTLE_MS, timeoutMs });
}

/** Marks the start of the run, immediately before the harness asks for a translation. */
export async function startPageRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const start = (globalThis as unknown as { __sakuttoBenchStart?: () => void })
      .__sakuttoBenchStart;
    if (!start) throw new Error('the bench recorder was not installed');
    start();
  });
}

export async function readPageRecorder(page: Page): Promise<RecordedPage> {
  const value = await page.evaluate(() =>
    (globalThis as unknown as { __sakuttoBenchRead?: () => RecordedPage }).__sakuttoBenchRead?.(),
  );
  if (!value) throw new Error('the bench recorder was not installed');
  return value;
}

/** Waits for the recorder to settle, then reads its final numbers. */
export async function waitForPageRecorder(
  page: Page,
  timeoutMs = PAGE_TIMEOUT_MS,
): Promise<RecordedPage> {
  await page.waitForFunction(
    () => {
      const state = (
        globalThis as unknown as { __sakuttoBenchRecorder?: { finishedAt: number | null } }
      ).__sakuttoBenchRecorder;
      return state !== undefined && state.finishedAt !== null;
    },
    undefined,
    { timeout: timeoutMs + 20_000 },
  );
  return readPageRecorder(page);
}

/**
 * Blocks finished per second between the first painted text and the last. Comparable
 * across commits even in mock mode, where a token rate would only describe the stub.
 */
export function commitRatePerSecond(recorded: RecordedPage): number | null {
  const first = recorded.firstTextMs;
  const end = recorded.fullPageMs;
  if (first === null || end === null || end <= first) return null;
  let steps = 0;
  let last = 0;
  for (const sample of recorded.timeline) {
    if (sample.atMs < first) {
      last = sample.done;
      continue;
    }
    if (sample.done > last) {
      steps += sample.done - last;
      last = sample.done;
    }
  }
  if (steps === 0) return null;
  return Math.round((steps / ((end - first) / 1000)) * 10) / 10;
}
