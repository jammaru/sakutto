import { describe, expect, it } from 'vitest';
import type { CaptionCue } from '@/captions/cues';
import type { CaptionTranslateOptions } from '@/captions/engine';
import {
  planVodPrefetch,
  previousVodCueContext,
  sanitizeVodPlaybackRate,
  VodPrefetchController,
  vodCueTranslateOptions,
  vodPrefetchQueue,
  vodWallHorizonMs,
  type VodCaptionTranslationAdapter,
  type VodDebugEvent,
} from '@/captions/vod-prefetch';

const baseOptions: CaptionTranslateOptions = {
  tgt: 'ja',
  form: 'plain',
  src: 'en',
  context: 'caller context must not leak',
};

function cuesAt(...startsMs: number[]): CaptionCue[] {
  return startsMs.map((startMs, index) => ({
    id: `c${index}`,
    startMs,
    endMs: startMs + 800,
    text: `source ${index}`,
  }));
}

interface FakeCall {
  cue: CaptionCue;
  options: CaptionTranslateOptions;
  priority: number;
  promise: Promise<string | null>;
  resolve: (value: string | null) => void;
  settled: boolean;
}

class FakeTranslator implements VodCaptionTranslationAdapter {
  readonly calls: FakeCall[] = [];
  readonly cancelled: { text: string; options: CaptionTranslateOptions }[] = [];
  private readonly cache = new Map<string, string>();

  private key(text: string, options: CaptionTranslateOptions): string {
    return JSON.stringify([
      text,
      options.tgt,
      options.form,
      options.src,
      options.context,
      options.asr,
    ]);
  }

  getCached(text: string, options: CaptionTranslateOptions): string | undefined {
    return this.cache.get(this.key(text, options));
  }

  translateCue(
    cue: CaptionCue,
    options: CaptionTranslateOptions,
    priority: number,
  ): Promise<string | null> {
    const previous = this.calls.find(
      (call) =>
        !call.settled &&
        call.cue.id === cue.id &&
        this.key(call.cue.text, call.options) === this.key(cue.text, options),
    );
    if (previous && priority < previous.priority) {
      // CaptionTranslator aborts the old warmer and returns null to that caller.
      previous.settled = true;
      previous.resolve(null);
    }

    let resolve!: (value: string | null) => void;
    const promise = new Promise<string | null>((accept) => {
      resolve = accept;
    });
    const call: FakeCall = { cue, options, priority, promise, resolve, settled: false };
    this.calls.push(call);
    return promise;
  }

  cancelText(text: string, options: CaptionTranslateOptions): void {
    // Deliberately leave the promise pending so tests can deliver a hostile late result.
    this.cancelled.push({ text, options });
  }

  finish(call: FakeCall, translation: string | null = `ja ${call.cue.id}`): void {
    call.settled = true;
    if (translation !== null) this.cache.set(this.key(call.cue.text, call.options), translation);
    call.resolve(translation);
  }

  seed(cue: CaptionCue, options: CaptionTranslateOptions, translation: string): void {
    this.cache.set(this.key(cue.text, options), translation);
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('pure VOD deadline planning', () => {
  it('uses sanitized wall-clock horizons', () => {
    const [cue] = cuesAt(5_000);
    expect(cue && vodWallHorizonMs(cue, 1_000, 2)).toBe(2_000);
    expect(cue && vodWallHorizonMs(cue, 6_000, 1)).toBe(-1_000);
    expect(sanitizeVodPlaybackRate(0)).toBe(1);
    expect(sanitizeVodPlaybackRate(Number.NaN)).toBe(1);
    expect(sanitizeVodPlaybackRate(-2)).toBe(1);
  });

  it('classifies current/overdue, urgent, window, and retained far cues in deadline order', () => {
    const cues = cuesAt(0, 1_000, 3_000, 10_000, 40_000);
    const plan = planVodPrefetch(
      cues,
      { timeMs: 1_500, playbackRate: 2 },
      { urgentHorizonMs: 1_000, lookaheadHorizonMs: 10_000, urgentCueCount: 1 },
    );
    expect(plan.map(({ cue, priority }) => [cue.id, priority])).toEqual([
      ['c0', 2],
      ['c1', 1],
      ['c2', 2],
      ['c3', 24],
      ['c4', null],
    ]);
    expect(plan.map(({ horizonMs }) => horizonMs)).toEqual([-750, -250, 750, 4_250, 19_250]);
    expect(vodPrefetchQueue(plan).map(({ cue }) => cue.id)).toEqual(['c1', 'c0', 'c2', 'c3']);
  });

  it('keeps the ordered next backlog eager even beyond its time horizon', () => {
    const plan = planVodPrefetch(
      cuesAt(10_000, 20_000, 30_000),
      { timeMs: 0, playbackRate: 1 },
      { urgentHorizonMs: 100, lookaheadHorizonMs: 200, urgentCueCount: 2 },
    );
    expect(plan.map(({ priority }) => priority)).toEqual([2, 2, null]);
  });

  it('derives one stable previous-source context for prefetch and paint', () => {
    const cues = cuesAt(0, 1_000);
    expect(previousVodCueContext(cues, 0)).toBeUndefined();
    expect(previousVodCueContext(cues, 1)).toBe('source 0');
    expect(previousVodCueContext(cues, -1)).toBeUndefined();
    const first = vodCueTranslateOptions(cues, 0, baseOptions);
    const second = vodCueTranslateOptions(cues, 1, baseOptions);
    expect(first.context).toBeUndefined();
    expect(second.context).toBe('source 0');
    expect(vodCueTranslateOptions(cues, 1, baseOptions)).toEqual(second);
  });
});

describe('VodPrefetchController', () => {
  it('does not burst a long track and advances only as work completes', async () => {
    const adapter = new FakeTranslator();
    const events: VodDebugEvent[] = [];
    const controller = new VodPrefetchController({
      cues: Array.from({ length: 100 }, (_value, index) => ({
        id: `c${index}`,
        startMs: index * 10_000,
        endMs: index * 10_000 + 800,
        text: `source ${index}`,
      })),
      adapter,
      options: baseOptions,
      policy: { maxOutstanding: 2, urgentCueCount: 20, lookaheadHorizonMs: 1_000_000 },
      onDebug: (event) => events.push(event),
    });

    expect(adapter.calls.map(({ cue }) => cue.id)).toEqual(['c0', 'c1']);
    expect(controller.getState().outstanding).toHaveLength(2);
    expect(controller.getState().plan).toHaveLength(100);

    adapter.finish(adapter.calls[0]!);
    await flush();
    expect(adapter.calls.map(({ cue }) => cue.id)).toEqual(['c0', 'c1', 'c2']);
    expect(controller.getState().outstanding.map(({ cueId }) => cueId)).toEqual(['c1', 'c2']);

    adapter.finish(adapter.calls[1]!);
    await flush();
    expect(adapter.calls.map(({ cue }) => cue.id)).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(controller.getState().completedCueIds).toEqual(['c0', 'c1']);
    expect(events.some((event) => event.type === 'complete' && event.reason === 'completion')).toBe(
      true,
    );
  });

  it('promotes an existing window request once and reuses identical context options', async () => {
    const adapter = new FakeTranslator();
    const events: VodDebugEvent[] = [];
    const controller = new VodPrefetchController({
      cues: cuesAt(0, 20_000, 40_000),
      adapter,
      options: baseOptions,
      policy: {
        maxOutstanding: 2,
        urgentHorizonMs: 1_000,
        lookaheadHorizonMs: 30_000,
        urgentCueCount: 0,
      },
      onDebug: (event) => events.push(event),
    });
    expect(adapter.calls.map(({ priority }) => priority)).toEqual([1, 24]);

    controller.setPlaybackRate(20);
    await flush();
    expect(adapter.calls).toHaveLength(3);
    expect(adapter.calls[2]?.cue.id).toBe('c1');
    expect(adapter.calls[2]?.priority).toBe(2);
    expect(adapter.calls[2]?.options).toBe(adapter.calls[1]?.options);
    expect(adapter.calls[2]?.options.context).toBe('source 0');
    expect(adapter.cancelled).toEqual([]);
    expect(controller.getState().generation).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'promote', cueId: 'c1', oldPriority: 24, newPriority: 2 }),
    );

    controller.reconcile();
    expect(adapter.calls).toHaveLength(3);
  });

  it('preempts lower-priority outstanding work for a new current cue', () => {
    const adapter = new FakeTranslator();
    const events: VodDebugEvent[] = [];
    const controller = new VodPrefetchController({
      cues: cuesAt(0, 10_000, 20_000, 30_000),
      adapter,
      options: baseOptions,
      policy: { maxOutstanding: 2, urgentCueCount: 2, lookaheadHorizonMs: 30_000 },
      onDebug: (event) => events.push(event),
    });
    expect(adapter.calls.map(({ cue }) => cue.id)).toEqual(['c0', 'c1']);

    controller.reconcile(20_000, 1);

    expect(adapter.cancelled.map(({ text }) => text)).toEqual(['source 1']);
    expect(adapter.calls.map(({ cue }) => cue.id)).toEqual(['c0', 'c1', 'c2']);
    expect(adapter.calls[2]?.priority).toBe(1);
    expect(controller.getState().outstanding).toEqual([
      { cueId: 'c0', index: 0, priority: 2, generation: 0 },
      { cueId: 'c2', index: 2, priority: 1, generation: 0 },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'cancel', cueId: 'c1', reason: 'preempt' }),
    );
  });

  it('cancels work that becomes far on a rate change without restarting retained work', () => {
    const adapter = new FakeTranslator();
    const controller = new VodPrefetchController({
      cues: cuesAt(0, 20_000),
      adapter,
      options: baseOptions,
      policy: {
        maxOutstanding: 2,
        urgentHorizonMs: 1_000,
        lookaheadHorizonMs: 30_000,
        urgentCueCount: 0,
      },
    });
    controller.setPlaybackRate(0.25);

    expect(adapter.cancelled.map(({ text }) => text)).toEqual(['source 1']);
    expect(adapter.calls).toHaveLength(2);
    expect(controller.getState().outstanding).toEqual([
      { cueId: 'c0', index: 0, priority: 1, generation: 1 },
    ]);
    expect(controller.getState().plan[1]?.priority).toBeNull();
  });

  it('invalidates stale seek results and reuses completed cache on rewind', async () => {
    const adapter = new FakeTranslator();
    const events: VodDebugEvent[] = [];
    const controller = new VodPrefetchController({
      cues: cuesAt(0, 10_000, 100_000, 110_000),
      adapter,
      options: baseOptions,
      policy: {
        maxOutstanding: 3,
        urgentHorizonMs: 1_000,
        lookaheadHorizonMs: 20_000,
        urgentCueCount: 0,
      },
      onDebug: (event) => events.push(event),
    });
    expect(adapter.calls.map(({ cue }) => cue.id)).toEqual(['c0', 'c1']);

    controller.seek(100_000);
    expect(adapter.cancelled.map(({ text }) => text)).toEqual(['source 0', 'source 1']);
    expect(adapter.calls.map(({ cue }) => cue.id)).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(controller.getState().generation).toBe(1);

    adapter.finish(adapter.calls[0]!, 'cached before rewind');
    await flush();
    expect(adapter.calls).toHaveLength(4);
    expect(events).toContainEqual(expect.objectContaining({ type: 'ignore', cueId: 'c0' }));

    controller.seek(0);
    expect(adapter.calls.filter(({ cue }) => cue.id === 'c0')).toHaveLength(1);
    expect(controller.cachedTranslation(0)).toBe('cached before rewind');
    expect(controller.getState().generation).toBe(2);
    expect(
      events.filter((event) => event.type === 'cancel' && event.generation === 1),
    ).toHaveLength(2);
  });

  it('uses the shared context key for warm cache hits at construction and paint', () => {
    const adapter = new FakeTranslator();
    const cues = cuesAt(0, 1_000);
    const paintOptions = vodCueTranslateOptions(cues, 1, baseOptions);
    adapter.seed(cues[1]!, paintOptions, 'already translated');

    const controller = new VodPrefetchController({
      cues,
      adapter,
      options: baseOptions,
      policy: { maxOutstanding: 2 },
    });
    expect(adapter.calls.map(({ cue }) => cue.id)).toEqual(['c0']);
    expect(controller.optionsForCue(1)).toEqual(paintOptions);
    expect(controller.cachedTranslation(1)).toBe('already translated');
    expect(controller.getState().completedCueIds).toEqual(['c1']);
  });

  it('keeps failed work terminal until an intentional seek retries it', async () => {
    const adapter = new FakeTranslator();
    const controller = new VodPrefetchController({
      cues: cuesAt(0),
      adapter,
      options: baseOptions,
      policy: { maxOutstanding: 1 },
    });
    adapter.finish(adapter.calls[0]!, null);
    await flush();
    await flush();
    expect(adapter.calls).toHaveLength(1);
    expect(controller.hasFailed('c0')).toBe(true);
    expect(controller.getState().failedCueIds).toEqual(['c0']);

    controller.reconcile();
    expect(adapter.calls).toHaveLength(1);
    controller.seek(0);
    expect(adapter.calls).toHaveLength(2);
    expect(controller.hasFailed('c0')).toBe(false);
  });
});
