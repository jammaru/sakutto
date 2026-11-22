import type { CaptionCue } from './cues';
import type { CaptionTranslateOptions } from './engine';

export const VOD_PLAYHEAD_PRIORITY = 1;
export const VOD_URGENT_PRIORITY = 2;
export const VOD_WINDOW_PRIORITY = 24;

export type VodPrefetchPriority =
  typeof VOD_PLAYHEAD_PRIORITY | typeof VOD_URGENT_PRIORITY | typeof VOD_WINDOW_PRIORITY;

export interface VodPrefetchPolicy {
  /** Maximum translation promises owned by this controller at once. */
  maxOutstanding: number;
  /** Wall-clock horizon inside which upcoming work is eager. */
  urgentHorizonMs: number;
  /** Wall-clock horizon inside which upcoming work is background prefetch. */
  lookaheadHorizonMs: number;
  /** Always keep this many ordered next cues eager, even beyond the time horizon. */
  urgentCueCount: number;
}

export const DEFAULT_VOD_PREFETCH_POLICY: Readonly<VodPrefetchPolicy> = Object.freeze({
  maxOutstanding: 2,
  urgentHorizonMs: 4_000,
  lookaheadHorizonMs: 30_000,
  urgentCueCount: 2,
});

export interface VodPlayhead {
  timeMs: number;
  playbackRate: number;
}

/** A far cue has priority null: it remains in the plan but is not submitted. */
export interface VodPlannedCue extends VodPlayhead {
  cue: CaptionCue;
  index: number;
  horizonMs: number;
  priority: VodPrefetchPriority | null;
}

/**
 * The structural subset of CaptionTranslator used by VOD prefetch. In particular,
 * translateCue must reuse/promote an existing request for the same cue and options.
 */
export interface VodCaptionTranslationAdapter {
  getCached(text: string, options: CaptionTranslateOptions): string | undefined;
  translateCue(
    cue: CaptionCue,
    options: CaptionTranslateOptions,
    priority: number,
  ): Promise<string | null>;
  cancelText(text: string, options: CaptionTranslateOptions): void;
}

export type VodSchedulerReason = 'load' | 'tick' | 'seek' | 'rate' | 'completion';
export type VodDebugReason = VodSchedulerReason | 'stale' | 'dispose';
export type VodDebugEventType =
  'cached' | 'submit' | 'promote' | 'retain' | 'cancel' | 'complete' | 'error' | 'ignore';

export interface VodDebugEvent {
  type: VodDebugEventType;
  cueId: string;
  index: number;
  oldPriority: VodPrefetchPriority | null;
  newPriority: VodPrefetchPriority | null;
  generation: number;
  reason: VodDebugReason;
  horizonMs: number | null;
}

export interface VodOutstandingWork {
  cueId: string;
  index: number;
  priority: VodPrefetchPriority;
  generation: number;
}

export interface VodPrefetchSnapshot extends VodPlayhead {
  generation: number;
  disposed: boolean;
  plan: readonly VodPlannedCue[];
  queue: readonly VodPlannedCue[];
  outstanding: readonly VodOutstandingWork[];
  completedCueIds: readonly string[];
}

export interface VodPrefetchControllerInit {
  cues: readonly CaptionCue[];
  adapter: VodCaptionTranslationAdapter;
  options: CaptionTranslateOptions;
  policy?: Partial<VodPrefetchPolicy> | undefined;
  timeMs?: number | undefined;
  playbackRate?: number | undefined;
  onDebug?: ((event: VodDebugEvent) => void) | undefined;
}

interface OutstandingEntry extends VodOutstandingWork {
  cue: CaptionCue;
  options: CaptionTranslateOptions;
}

export function sanitizeVodPlaybackRate(playbackRate: number): number {
  return Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
}

export function vodWallHorizonMs(cue: CaptionCue, timeMs: number, playbackRate = 1): number {
  const time = Number.isFinite(timeMs) ? timeMs : 0;
  return (cue.startMs - time) / sanitizeVodPlaybackRate(playbackRate);
}

/** The exact previous source cue, shared by prefetch and display cache lookups. */
export function previousVodCueContext(
  cues: readonly CaptionCue[],
  index: number,
): string | undefined {
  return Number.isInteger(index) && index > 0 ? cues[index - 1]?.text : undefined;
}

/** Never inherit a caller-supplied stale context: cue zero explicitly has none. */
export function vodCueTranslateOptions(
  cues: readonly CaptionCue[],
  index: number,
  options: CaptionTranslateOptions,
): CaptionTranslateOptions {
  return { ...options, context: previousVodCueContext(cues, index) };
}

export function resolveVodPrefetchPolicy(
  overrides: Partial<VodPrefetchPolicy> = {},
): VodPrefetchPolicy {
  const nonNegative = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
  const integer = (value: number | undefined, fallback: number): number =>
    Math.floor(nonNegative(value, fallback));
  return {
    maxOutstanding: integer(overrides.maxOutstanding, DEFAULT_VOD_PREFETCH_POLICY.maxOutstanding),
    urgentHorizonMs: nonNegative(
      overrides.urgentHorizonMs,
      DEFAULT_VOD_PREFETCH_POLICY.urgentHorizonMs,
    ),
    lookaheadHorizonMs: nonNegative(
      overrides.lookaheadHorizonMs,
      DEFAULT_VOD_PREFETCH_POLICY.lookaheadHorizonMs,
    ),
    urgentCueCount: integer(overrides.urgentCueCount, DEFAULT_VOD_PREFETCH_POLICY.urgentCueCount),
  };
}

/**
 * Classify the immutable whole track without submitting work. Only the latest
 * started/overlapping display cues are playhead work; arbitrary old cues stay far.
 */
export function planVodPrefetch(
  cues: readonly CaptionCue[],
  playhead: VodPlayhead,
  policyOverrides: Partial<VodPrefetchPolicy> = {},
): VodPlannedCue[] {
  const policy = resolveVodPrefetchPolicy(policyOverrides);
  const timeMs = Number.isFinite(playhead.timeMs) ? playhead.timeMs : 0;
  const playbackRate = sanitizeVodPlaybackRate(playhead.playbackRate);
  let latestStarted = -1;
  for (let index = 0; index < cues.length; index += 1) {
    if ((cues[index]?.startMs ?? Number.POSITIVE_INFINITY) <= timeMs) latestStarted = index;
  }

  let upcomingRank = 0;
  return cues.map((cue, index) => {
    const horizonMs = (cue.startMs - timeMs) / playbackRate;
    const active = cue.startMs <= timeMs && cue.endMs >= timeMs;
    let priority: VodPrefetchPriority | null = null;
    if (index === latestStarted || active) {
      priority = VOD_PLAYHEAD_PRIORITY;
    } else if (cue.startMs <= timeMs) {
      // An uncached earlier cue may still own the display FIFO. Keep overdue
      // backlog ahead of future prefetch rather than silently starving it.
      priority = VOD_URGENT_PRIORITY;
    } else if (cue.startMs > timeMs) {
      const rank = upcomingRank;
      upcomingRank += 1;
      if (horizonMs <= policy.urgentHorizonMs || rank < policy.urgentCueCount) {
        priority = VOD_URGENT_PRIORITY;
      } else if (horizonMs <= policy.lookaheadHorizonMs) {
        priority = VOD_WINDOW_PRIORITY;
      }
    }
    return { cue, index, timeMs, playbackRate, horizonMs, priority };
  });
}

/** Stable engine order: priority, wall deadline, then immutable timeline order. */
export function vodPrefetchQueue(plan: readonly VodPlannedCue[]): VodPlannedCue[] {
  return plan
    .filter((item) => item.priority !== null)
    .sort(
      (left, right) =>
        (left.priority ?? VOD_WINDOW_PRIORITY) - (right.priority ?? VOD_WINDOW_PRIORITY) ||
        left.horizonMs - right.horizonMs ||
        left.index - right.index,
    );
}

/**
 * Owns only translation scheduling. It never reads a player/DOM, fetches a track,
 * paints a cue, or clears adapter cache entries on a scheduling generation change.
 */
export class VodPrefetchController {
  private readonly cues: readonly CaptionCue[];
  private readonly adapter: VodCaptionTranslationAdapter;
  private readonly policy: VodPrefetchPolicy;
  private readonly requestOptions: readonly CaptionTranslateOptions[];
  private readonly onDebug: ((event: VodDebugEvent) => void) | undefined;
  private readonly outstanding = new Map<number, OutstandingEntry>();
  private readonly completed = new Set<number>();
  private readonly failed = new Set<number>();
  private readonly seekExcluded = new Set<number>();
  private generation = 0;
  private timeMs: number;
  private playbackRate: number;
  private disposed = false;

  constructor(init: VodPrefetchControllerInit) {
    this.cues = init.cues;
    this.adapter = init.adapter;
    this.policy = resolveVodPrefetchPolicy(init.policy);
    this.requestOptions = init.cues.map((_cue, index) =>
      vodCueTranslateOptions(init.cues, index, init.options),
    );
    this.onDebug = init.onDebug;
    this.timeMs = Number.isFinite(init.timeMs) ? (init.timeMs ?? 0) : 0;
    this.playbackRate = sanitizeVodPlaybackRate(init.playbackRate ?? 1);
    this.excludeSkippedBeforeSeek(this.timeMs);
    this.reconcileInternal('load');
  }

  reconcile(
    timeMs = this.timeMs,
    playbackRate = this.playbackRate,
    reason: Exclude<VodSchedulerReason, 'completion'> = 'tick',
  ): VodPrefetchSnapshot {
    return this.reconcileInternal(reason, timeMs, playbackRate);
  }

  seek(timeMs: number, playbackRate = this.playbackRate): VodPrefetchSnapshot {
    this.excludeSkippedBeforeSeek(timeMs);
    return this.reconcileInternal('seek', timeMs, playbackRate);
  }

  setPlaybackRate(playbackRate: number, timeMs = this.timeMs): VodPrefetchSnapshot {
    return this.reconcileInternal('rate', timeMs, playbackRate);
  }

  optionsForCue(index: number): CaptionTranslateOptions | undefined {
    return this.requestOptions[index];
  }

  cachedTranslation(index: number): string | undefined {
    const cue = this.cues[index];
    const options = this.requestOptions[index];
    return cue && options ? this.adapter.getCached(cue.text, options) : undefined;
  }

  getState(): VodPrefetchSnapshot {
    const plan = this.currentPlan();
    return {
      timeMs: this.timeMs,
      playbackRate: this.playbackRate,
      generation: this.generation,
      disposed: this.disposed,
      plan,
      queue: vodPrefetchQueue(plan),
      outstanding: [...this.outstanding.values()]
        .map(({ cueId, index, priority, generation }) => ({ cueId, index, priority, generation }))
        .sort((left, right) => left.index - right.index),
      completedCueIds: [...this.completed]
        .sort((left, right) => left - right)
        .map((index) => this.cues[index]?.id)
        .filter((id): id is string => id !== undefined),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const entry of [...this.outstanding.values()]) this.cancel(entry, 'dispose');
  }

  private reconcileInternal(
    reason: Exclude<VodSchedulerReason, 'completion'> | 'completion',
    timeMs = this.timeMs,
    playbackRate = this.playbackRate,
  ): VodPrefetchSnapshot {
    if (this.disposed) return this.getState();
    if (reason === 'seek' || reason === 'rate') this.failed.clear();
    if (reason === 'seek' || reason === 'rate') this.generation += 1;
    this.timeMs = Number.isFinite(timeMs) ? timeMs : 0;
    this.playbackRate = sanitizeVodPlaybackRate(playbackRate);

    const plan = this.currentPlan();
    for (const item of plan) {
      if (this.completed.has(item.index)) continue;
      const options = this.requestOptions[item.index];
      if (options && this.adapter.getCached(item.cue.text, options) !== undefined) {
        this.completed.add(item.index);
        this.emit('cached', item, null, null, reason);
      }
    }

    const planned = new Map(plan.map((item) => [item.index, item]));
    if (reason === 'seek' || reason === 'rate') {
      for (const entry of [...this.outstanding.values()]) {
        if (planned.get(entry.index)?.priority === null) this.cancel(entry, reason);
      }
    }

    const queue = vodPrefetchQueue(plan);
    for (const item of queue) {
      const priority = item.priority;
      if (priority === null) continue;
      const entry = this.outstanding.get(item.index);
      if (!entry) continue;
      if (priority < entry.priority) {
        this.start(item, priority, reason, entry);
      } else {
        const oldPriority = entry.priority;
        entry.priority = priority;
        entry.generation = this.generation;
        if (oldPriority !== priority) this.emit('retain', item, oldPriority, priority, reason);
      }
    }

    for (const item of queue) {
      if (this.outstanding.size >= this.policy.maxOutstanding) break;
      if (
        item.priority === null ||
        this.completed.has(item.index) ||
        this.failed.has(item.index) ||
        this.outstanding.has(item.index)
      ) {
        continue;
      }
      this.start(item, item.priority, reason);
    }
    return this.getState();
  }

  private currentPlan(): VodPlannedCue[] {
    return planVodPrefetch(
      this.cues,
      { timeMs: this.timeMs, playbackRate: this.playbackRate },
      this.policy,
    ).map((item) => (this.seekExcluded.has(item.index) ? { ...item, priority: null } : item));
  }

  /** User-skipped ranges are not ordinary playback backlog and are never fetched. */
  private excludeSkippedBeforeSeek(timeMs: number): void {
    this.seekExcluded.clear();
    let latestStarted = -1;
    for (let index = 0; index < this.cues.length; index += 1) {
      if ((this.cues[index]?.startMs ?? Number.POSITIVE_INFINITY) <= timeMs) latestStarted = index;
    }
    for (let index = 0; index < latestStarted; index += 1) this.seekExcluded.add(index);
  }

  private start(
    item: VodPlannedCue,
    priority: VodPrefetchPriority,
    reason: VodSchedulerReason,
    previous?: OutstandingEntry,
  ): void {
    const options = this.requestOptions[item.index];
    if (!options) return;
    let promise: Promise<string | null>;
    try {
      promise = this.adapter.translateCue(item.cue, options, priority);
    } catch (error) {
      promise = Promise.reject(error);
    }
    const entry: OutstandingEntry = {
      cueId: item.cue.id,
      index: item.index,
      cue: item.cue,
      options,
      priority,
      generation: this.generation,
    };
    this.outstanding.set(item.index, entry);
    this.emit(previous ? 'promote' : 'submit', item, previous?.priority ?? null, priority, reason);
    void promise.then(
      (translation) => this.finish(entry, item, translation, null),
      () => this.finish(entry, item, null, new Error('caption translation failed')),
    );
  }

  private finish(
    entry: OutstandingEntry,
    item: VodPlannedCue,
    translation: string | null,
    error: Error | null,
  ): void {
    if (this.outstanding.get(entry.index) !== entry) {
      this.emit('ignore', item, entry.priority, null, 'stale');
      return;
    }
    this.outstanding.delete(entry.index);
    if (error || translation === null) {
      this.failed.add(entry.index);
      this.emit('error', item, entry.priority, null, 'completion');
    } else {
      this.completed.add(entry.index);
      this.emit('complete', item, entry.priority, null, 'completion');
    }
    this.reconcileInternal('completion');
  }

  private cancel(entry: OutstandingEntry, reason: 'seek' | 'rate' | 'dispose'): void {
    this.outstanding.delete(entry.index);
    this.adapter.cancelText(entry.cue.text, entry.options);
    this.emit('cancel', this.itemFor(entry.index), entry.priority, null, reason);
  }

  private itemFor(index: number): VodPlannedCue {
    const cue = this.cues[index];
    if (!cue) throw new Error(`Unknown VOD cue index ${index}`);
    return {
      cue,
      index,
      timeMs: this.timeMs,
      playbackRate: this.playbackRate,
      horizonMs: vodWallHorizonMs(cue, this.timeMs, this.playbackRate),
      priority: this.outstanding.get(index)?.priority ?? null,
    };
  }

  private emit(
    type: VodDebugEventType,
    item: VodPlannedCue,
    oldPriority: VodPrefetchPriority | null,
    newPriority: VodPrefetchPriority | null,
    reason: VodDebugReason,
  ): void {
    this.onDebug?.({
      type,
      cueId: item.cue.id,
      index: item.index,
      oldPriority,
      newPriority,
      generation: this.generation,
      reason,
      horizonMs: item.horizonMs,
    });
  }
}
