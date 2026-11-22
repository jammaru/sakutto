import type { Page } from '@playwright/test';

export const JSON3_THRESHOLDS = {
  sampleIntervalMs: 50,
  medianCueLagMs: 300,
  p95CueLagMs: 1_000,
  minimumDwellMs: 1_200,
  minimumCueCount: 9,
  maximumOutstanding: 4,
  maximumInitialRequests: 4,
} as const;

export interface Json3Segment {
  utf8: string;
  tOffsetMs?: number;
}

export interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Segment[];
}

export interface Json3Track {
  events?: Json3Event[];
}

export interface ExpectedJson3Cue {
  id: string;
  source: string;
  startMs: number;
  endMs: number;
  expectedJa: string;
  numericLexemes: string[];
}

export interface ExpectedJson3Manifest {
  schemaVersion: number;
  scenarioId: string;
  fixture: string;
  language: string;
  targetLanguage: string;
  synthetic: boolean;
  minimumCueCount: number;
  cues: ExpectedJson3Cue[];
}

export interface FixtureAudit {
  failures: string[];
  eventCount: number;
  segmentCount: number;
  offsetSegmentCount: number;
  distinctOffsetCount: number;
  uniqueWordCount: number;
  repeatedRollingInstanceCount: number;
  pauseCount: number;
  shortCueCount: number;
}

export interface Json3Sample {
  atMs: number;
  mediaMs: number;
  rate: number;
  paused: boolean;
  phase: string;
  epoch: number;
  caption: string;
  original: string;
  visible: boolean;
  pending: boolean;
  nativeText: string;
}

export interface DisplayTransition extends Json3Sample {
  reason: 'initial' | 'mutation' | 'sample' | 'mark' | 'stop';
  censored: boolean;
}

export interface CaptionRequestTrace {
  action: 'start' | 'abort' | 'finish' | 'cache-hit';
  cueId: string;
  sourceText: string;
  generation: number;
  priority: number;
  mode: 'vod-json3' | 'live-incremental' | 'cue-list';
  reason: string;
  atMs: number;
  mediaMs: number;
  phase: string;
  epoch: number;
  /** Page point captured alongside the request event, when available. */
  caption?: string;
  visible?: boolean;
}

export interface SchedulerTrace {
  generation: number;
  reason: string;
  mode: 'vod-json3' | 'live-incremental' | 'cue-list';
  type?: string;
  cueId?: string;
  oldPriority?: number | null;
  newPriority?: number | null;
  cueCount?: number;
  outstanding?: number | readonly unknown[];
  atMs: number;
  mediaMs: number;
  phase: string;
  epoch: number;
}

export interface Json3Recording {
  samples: Json3Sample[];
  transitions: DisplayTransition[];
  requests: CaptionRequestTrace[];
  scheduler: SchedulerTrace[];
}

export interface NetworkRequestCounts {
  json3: number;
  vtt: number;
}

export interface CueLagDetail {
  cueId: string;
  crossingAtMs: number | null;
  paintedAtMs: number | null;
  lagMs: number;
  earlyPaint: boolean;
}

export interface DwellInterval {
  cueId: string;
  shownAtMs: number;
  hiddenAtMs: number;
  dwellMs: number;
  censored: boolean;
}

export interface ContentAudit {
  missingJaIds: string[];
  missingSourceIds: string[];
  duplicatedJaIds: string[];
  duplicatedSourceIds: string[];
  reorderedJaIds: string[];
  reorderedSourceIds: boolean;
  unexpectedTranslations: string[];
  unexpectedSources: string[];
  observedJaOrder: string[];
  observedSourceOrder: string[];
}

export interface NumericMismatch {
  cueId: string;
  expected: string[];
  actual: string[];
  forbiddenForms: string[];
}

export interface SchedulerAudit {
  translationStarts: number;
  cacheHits: number;
  aborted: number;
  finished: number;
  maxOutstanding: number;
  initialRequests: number;
  activeAfterFar: string[];
  decoyTranslations: string[];
  liveVodSchedulerEvents: number;
  instrumentationPresent: boolean;
}

export interface Json3QualityReport {
  scenarioId: string;
  phase: string;
  sampleCount: number;
  fixtureSha256?: string;
  lag: {
    medianMs: number;
    p95Ms: number;
    worstMs: number;
    details: CueLagDetail[];
  };
  dwell: {
    minimumMs: number;
    shortestMs: number;
    intervals: DwellInterval[];
    belowMinimum: DwellInterval[];
  };
  content: ContentAudit;
  numericMismatches: NumericMismatch[];
  requests: NetworkRequestCounts;
  scheduler: SchedulerAudit;
  failures: string[];
}

export interface Json3ReplayStep {
  phase: string;
  seekMs?: number;
  rate?: number;
  pause?: boolean;
  play?: boolean;
  untilMediaMs?: number;
  dwellMs?: number;
}

export function normalizeJson3Caption(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Numbers are source spans, not numeric values: spelling and order must survive unchanged. */
export function numericLexemes(text: string): string[] {
  return text.match(/\d[\d,]*(?:\.\d+)*/gu) ?? [];
}

/** Linear interpolation over the sorted sample, including Infinity for missing cues. */
export function linearPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? Number.POSITIVE_INFINITY;
  const high = sorted[upper] ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return Number.POSITIVE_INFINITY;
  return low + (high - low) * (position - lower);
}

function sameOrder(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

/**
 * Audits fixture vectors only. The expected strings and boundaries come from the independently
 * authored manifest; this routine never calls the production parser or manufactures an oracle.
 */
export function auditJson3Fixture(raw: Json3Track, expected: ExpectedJson3Manifest): FixtureAudit {
  const failures: string[] = [];
  const events = raw.events ?? [];
  const segments = events.flatMap((event) => event.segs ?? []);
  const offsetSegments = segments.filter((segment) => segment.tOffsetMs !== undefined);
  const distinctOffsets = new Set(offsetSegments.map((segment) => segment.tOffsetMs));
  const unique = new Map<string, { startMs: number; text: string; endMs: number }>();

  if (!expected.synthetic) failures.push('fixture manifest must identify the synthetic track');
  if (expected.cues.length < expected.minimumCueCount) failures.push('manifest is vacuous');
  if (events.length < 12) failures.push('not enough rolling events');
  if (offsetSegments.length !== segments.length)
    failures.push('every source segment needs an offset');
  if (distinctOffsets.size < 10) failures.push('meaningful non-zero segment offsets are missing');

  events.forEach((event, eventIndex) => {
    if (
      typeof event.tStartMs !== 'number' ||
      !Number.isFinite(event.tStartMs) ||
      event.tStartMs < 0 ||
      typeof event.dDurationMs !== 'number' ||
      !Number.isFinite(event.dDurationMs) ||
      event.dDurationMs <= 0
    ) {
      failures.push('invalid event timing at ' + eventIndex);
      return;
    }
    for (const segment of event.segs ?? []) {
      if (
        typeof segment.tOffsetMs !== 'number' ||
        !Number.isFinite(segment.tOffsetMs) ||
        segment.tOffsetMs < 0 ||
        segment.tOffsetMs >= event.dDurationMs
      ) {
        failures.push('invalid segment interval at event ' + eventIndex);
        continue;
      }
      const startMs = event.tStartMs + segment.tOffsetMs;
      const text = segment.utf8.trim();
      const key = startMs + '\0' + text;
      const endMs = event.tStartMs + event.dDurationMs;
      const previous = unique.get(key);
      if (!previous || endMs > previous.endMs) unique.set(key, { startMs, text, endMs });
    }
  });

  const words = [...unique.values()].sort((left, right) => left.startMs - right.startMs);
  const reconstructed = words
    .map((word) => word.text)
    .join(' ')
    .replace(/ (\.\d+)/gu, '$1');
  const independent = expected.cues.map((cue) => cue.source).join(' ');
  if (normalizeJson3Caption(reconstructed) !== normalizeJson3Caption(independent)) {
    failures.push('independent transcript does not cover deduplicated source words exactly');
  }

  expected.cues.forEach((cue, index) => {
    if (cue.expectedJa !== '§ja§' + cue.source)
      failures.push(cue.id + ': fake-engine oracle mismatch');
    if (!sameOrder(numericLexemes(cue.source), cue.numericLexemes)) {
      failures.push(cue.id + ': manifest numeric lexemes mismatch');
    }
    const nextStart = expected.cues[index + 1]?.startMs ?? Number.POSITIVE_INFINITY;
    const owned = words.filter((word) => word.startMs >= cue.startMs && word.startMs < nextStart);
    if (owned[0]?.startMs !== cue.startMs) failures.push(cue.id + ': source start mismatch');
    const last = owned.at(-1);
    if (!last || last.endMs !== cue.endMs) failures.push(cue.id + ': source end mismatch');
    if (/^[.,!?;:]/u.test(cue.source) || /[A-Za-z0-9]\s+[.,!?;:]/u.test(cue.source)) {
      failures.push(cue.id + ': suspicious token boundary');
    }
  });

  const pauses = expected.cues.slice(1).filter((cue, index) => {
    const previous = expected.cues[index];
    return previous !== undefined && cue.startMs - previous.endMs >= 700;
  }).length;
  const shortCues = expected.cues.filter((cue) => cue.endMs - cue.startMs <= 1_200).length;
  if (pauses < 3) failures.push('fixture lacks real inter-cue pauses');
  if (shortCues < 3) failures.push('fixture lacks short dwell-stress cues');
  if (!expected.cues.some((cue) => /[,.?]/u.test(cue.source)))
    failures.push('punctuation is missing');
  for (const decimal of ['5.5', '5.2', '4.5']) {
    if (!expected.cues.some((cue) => cue.numericLexemes.includes(decimal))) {
      failures.push('required decimal ' + decimal + ' is missing');
    }
  }
  if (segments.length <= unique.size) failures.push('rolling overlap is missing');

  return {
    failures,
    eventCount: events.length,
    segmentCount: segments.length,
    offsetSegmentCount: offsetSegments.length,
    distinctOffsetCount: distinctOffsets.size,
    uniqueWordCount: unique.size,
    repeatedRollingInstanceCount: segments.length - unique.size,
    pauseCount: pauses,
    shortCueCount: shortCues,
  };
}

/** Installs page-local 50ms sampling plus mutation-accurate overlay and scheduler traces. */
export async function installJson3Recorder(page: Page): Promise<void> {
  await page.evaluate((intervalMs) => {
    interface Point {
      atMs: number;
      mediaMs: number;
      rate: number;
      paused: boolean;
      phase: string;
      epoch: number;
      caption: string;
      original: string;
      visible: boolean;
      pending: boolean;
      nativeText: string;
    }
    interface Recorder {
      samples: Point[];
      transitions: Array<Point & { reason: string; censored: boolean }>;
      requests: CaptionRequestTrace[];
      scheduler: SchedulerTrace[];
      phase: string;
      epoch: number;
      timer: number;
      observer: MutationObserver;
      lastKey: string;
      mark(phase: string, censored: boolean): void;
      anchor(): void;
      read(): Json3Recording;
      stop(): void;
    }
    const state = globalThis as unknown as { __captionJson3Recorder?: Recorder };
    state.__captionJson3Recorder?.stop();
    const samples: Point[] = [];
    const transitions: Array<Point & { reason: string; censored: boolean }> = [];
    const requests: CaptionRequestTrace[] = [];
    const scheduler: SchedulerTrace[] = [];
    let phase = 'load';
    let epoch = 0;
    let lastKey = '';

    const point = (): Point => {
      const video = document.querySelector('#player') as HTMLVideoElement | null;
      const host = document.querySelector('sakutto-captions') as HTMLElement | null;
      const native = document.querySelector('.ytp-caption-window-container');
      return {
        atMs: performance.now(),
        mediaMs: Math.round((video?.currentTime ?? 0) * 1_000),
        rate: video?.playbackRate ?? 1,
        paused: video?.paused ?? true,
        phase,
        epoch,
        caption: host?.getAttribute('data-sakutto-caption') ?? '',
        original: host?.getAttribute('data-sakutto-original') ?? '',
        visible: Boolean(host && !host.hidden),
        pending: host?.getAttribute('data-sakutto-pending') === '1',
        nativeText: native?.textContent?.trim() ?? '',
      };
    };
    const record = (reason: string, censored = false, force = false): void => {
      const current = point();
      const key = [current.epoch, current.caption, current.original, current.visible].join('\0');
      if (force || key !== lastKey || censored) {
        transitions.push({ ...current, reason, censored });
        lastKey = key;
      }
    };
    const observer = new MutationObserver(() => record('mutation'));
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'data-sakutto-caption',
        'data-sakutto-original',
        'data-sakutto-pending',
        'hidden',
      ],
    });
    document.addEventListener('sakutto:caption-request', (event) => {
      const detail = (
        event as CustomEvent<Omit<CaptionRequestTrace, 'atMs' | 'mediaMs' | 'phase' | 'epoch'>>
      ).detail;
      requests.push({ ...detail, ...point() });
    });
    document.addEventListener('sakutto:vod-scheduler', (event) => {
      const detail = (
        event as CustomEvent<Omit<SchedulerTrace, 'atMs' | 'mediaMs' | 'phase' | 'epoch'>>
      ).detail;
      scheduler.push({ ...detail, ...point() });
    });
    const timer = window.setInterval(() => {
      samples.push(point());
      record('sample');
    }, intervalMs);
    const recorder: Recorder = {
      samples,
      transitions,
      requests,
      scheduler,
      get phase() {
        return phase;
      },
      set phase(value: string) {
        phase = value;
      },
      get epoch() {
        return epoch;
      },
      set epoch(value: number) {
        epoch = value;
      },
      timer,
      observer,
      lastKey,
      mark(nextPhase: string, censored: boolean): void {
        record('mark', censored, true);
        phase = nextPhase;
        epoch += 1;
        lastKey = '';
        samples.push(point());
        record('mark', censored, true);
      },
      anchor(): void {
        samples.push(point());
      },
      read(): Json3Recording {
        return {
          samples: samples.map((sample) => ({ ...sample })),
          transitions: transitions.map((transition) => ({
            ...transition,
            reason: transition.reason as DisplayTransition['reason'],
          })),
          requests: requests.map((request) => ({ ...request })),
          scheduler: scheduler.map((entry) => ({ ...entry })),
        };
      },
      stop(): void {
        window.clearInterval(timer);
        observer.disconnect();
      },
    };
    state.__captionJson3Recorder = recorder;
    samples.push(point());
    record('initial', false, true);
  }, JSON3_THRESHOLDS.sampleIntervalMs);
}

export async function markJson3Phase(page: Page, phase: string, censored = false): Promise<void> {
  await page.evaluate(
    ({ nextPhase, censor }) => {
      const state = globalThis as unknown as {
        __captionJson3Recorder?: { mark(phase: string, censored: boolean): void };
      };
      state.__captionJson3Recorder?.mark(nextPhase, censor);
    },
    { nextPhase: phase, censor: censored },
  );
}

export async function prepareJson3Player(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const fixture = (
      globalThis as unknown as {
        __captionJson3?: { videoReady?: Promise<void> };
      }
    ).__captionJson3;
    await fixture?.videoReady;
    const video = document.querySelector('#player') as HTMLVideoElement | null;
    if (!video || video.readyState < 1) throw new Error('json3 fixture media is not ready');
    video.muted = true;
    await video.play().catch(() => undefined);
    video.pause();
    video.currentTime = 0;
  });
}

/** Drives real media; fixed dwells only control input, never establish that a caption painted. */
export async function driveJson3Replay(
  page: Page,
  steps: readonly Json3ReplayStep[],
): Promise<void> {
  for (const step of steps) {
    await markJson3Phase(page, step.phase, step.seekMs !== undefined || step.rate !== undefined);
    await page.locator('#player').evaluate(async (element, current) => {
      const video = element as HTMLVideoElement;
      if (current.rate !== undefined) video.playbackRate = current.rate;
      if (current.seekMs !== undefined) video.currentTime = current.seekMs / 1_000;
      if (current.pause === true) video.pause();
      if (current.play === true) await video.play();
    }, step);
    if (step.seekMs !== undefined) {
      await page.waitForFunction(
        (target) =>
          Math.abs(
            (document.querySelector('#player') as HTMLVideoElement).currentTime * 1_000 - target,
          ) < 180,
        step.seekMs,
      );
    }
    await page.evaluate(() => {
      const state = globalThis as unknown as { __captionJson3Recorder?: { anchor(): void } };
      state.__captionJson3Recorder?.anchor();
    });
    if (step.untilMediaMs !== undefined) {
      await page.waitForFunction(
        (target) =>
          (document.querySelector('#player') as HTMLVideoElement).currentTime * 1_000 >= target,
        step.untilMediaMs,
        { timeout: Math.max(15_000, step.untilMediaMs + 10_000) },
      );
    }
    if (step.dwellMs !== undefined) await page.waitForTimeout(step.dwellMs);
  }
}

export async function readJson3Recording(page: Page): Promise<Json3Recording> {
  return page.evaluate(() => {
    const state = globalThis as unknown as {
      __captionJson3Recorder?: {
        read(): Json3Recording;
        stop(): void;
        mark(phase: string, censored: boolean): void;
      };
    };
    const recorder = state.__captionJson3Recorder;
    if (!recorder) throw new Error('json3 recorder is not installed');
    recorder.mark('stopped', false);
    recorder.stop();
    return recorder.read();
  });
}

type Json3PlayheadPoint = Pick<Json3Sample, 'atMs' | 'mediaMs' | 'phase' | 'epoch'>;

function crossingForCue(
  cue: ExpectedJson3Cue,
  samples: readonly Json3PlayheadPoint[],
  phase: string,
): { atMs: number; epoch: number } | null {
  const phased = samples.filter((sample) => sample.phase === phase);
  // A seek can cross the exact destination before the next 50ms sample. The
  // post-seek anchor is a closer wall-time estimate than discarding that cue.
  const anchored = phased.find(
    (sample) => sample.mediaMs >= cue.startMs && sample.mediaMs <= cue.startMs + 180,
  );
  if (anchored) return { atMs: anchored.atMs, epoch: anchored.epoch };
  for (let index = 1; index < phased.length; index += 1) {
    const before = phased[index - 1];
    const after = phased[index];
    if (!before || !after || before.epoch !== after.epoch) continue;
    if (before.mediaMs > cue.startMs || after.mediaMs < cue.startMs) continue;
    if (after.mediaMs < before.mediaMs || after.atMs - before.atMs > 1_000) continue;
    const mediaDelta = after.mediaMs - before.mediaMs;
    const fraction = mediaDelta === 0 ? 0 : (cue.startMs - before.mediaMs) / mediaDelta;
    return {
      atMs: before.atMs + (after.atMs - before.atMs) * fraction,
      epoch: before.epoch,
    };
  }
  return null;
}

function firstAppearanceOrder(
  manifest: ExpectedJson3Manifest,
  intervals: readonly DwellInterval[],
): string[] {
  const expected = new Map(manifest.cues.map((cue) => [cue.expectedJa, cue.id]));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const interval of [...intervals].sort((left, right) => left.shownAtMs - right.shownAtMs)) {
    if (
      !seen.has(interval.cueId) &&
      expected.has(manifest.cues.find((cue) => cue.id === interval.cueId)?.expectedJa ?? '')
    ) {
      seen.add(interval.cueId);
      order.push(interval.cueId);
    }
  }
  return order;
}

function visibilityIntervals(
  manifest: ExpectedJson3Manifest,
  recording: Json3Recording,
  phase: string,
  field: 'caption' | 'original',
  idPrefix = '',
): DwellInterval[] {
  const expected = manifest.cues;
  const intervals: DwellInterval[] = [];
  const active = new Map<string, { shownAtMs: number; epoch: number }>();
  const close = (cueId: string, atMs: number, censored: boolean): void => {
    const started = active.get(cueId);
    if (!started) return;
    intervals.push({
      cueId: idPrefix + cueId,
      shownAtMs: started.shownAtMs,
      hiddenAtMs: atMs,
      dwellMs: Math.max(0, atMs - started.shownAtMs),
      censored,
    });
    active.delete(cueId);
  };
  for (const transition of recording.transitions) {
    for (const cueId of [...active.keys()]) {
      const started = active.get(cueId);
      if (transition.censored || transition.epoch !== started?.epoch) {
        close(cueId, transition.atMs, transition.censored || transition.phase !== 'stopped');
      }
    }
    if (transition.phase !== phase) continue;
    const text = normalizeJson3Caption(transition[field]);
    const matched = expected.find(
      (cue) => normalizeJson3Caption(field === 'caption' ? cue.expectedJa : cue.source) === text,
    );
    for (const cue of expected) {
      if (cue.id === matched?.id || !active.has(cue.id)) continue;
      close(cue.id, transition.atMs, transition.censored);
    }
    if (matched && transition.visible && !transition.censored && !active.has(matched.id)) {
      active.set(matched.id, { shownAtMs: transition.atMs, epoch: transition.epoch });
    }
  }
  const final = recording.transitions.at(-1);
  for (const cueId of [...active.keys()]) close(cueId, final?.atMs ?? 0, false);
  return intervals;
}

export function computeSchedulerAudit(recording: Json3Recording, live: boolean): SchedulerAudit {
  const requests = recording.requests;
  const starts = requests.filter((request) => request.action === 'start');
  let outstanding = 0;
  let maxOutstanding = 0;
  const ordered = [...requests].sort((left, right) => left.atMs - right.atMs);
  for (const request of ordered) {
    if (request.action === 'start') outstanding += 1;
    if (request.action === 'abort' || request.action === 'finish')
      outstanding = Math.max(0, outstanding - 1);
    maxOutstanding = Math.max(maxOutstanding, outstanding);
  }
  const activeAfterFar: string[] = [];
  const generations = new Map<string, CaptionRequestTrace[]>();
  for (const request of starts) {
    if (!request.phase.startsWith('seek') && !request.phase.startsWith('rate')) continue;
    const key = request.phase + ':' + request.generation;
    const group = generations.get(key) ?? [];
    group.push(request);
    generations.set(key, group);
  }
  for (const [key, group] of generations) {
    const first = [...group].sort((left, right) => left.atMs - right.atMs)[0];
    if (first && first.priority > 2) activeAfterFar.push(key);
  }
  return {
    translationStarts: starts.length,
    cacheHits: requests.filter((request) => request.action === 'cache-hit').length,
    aborted: requests.filter((request) => request.action === 'abort').length,
    finished: requests.filter((request) => request.action === 'finish').length,
    maxOutstanding,
    initialRequests: starts.filter((request) => request.phase === 'load').length,
    activeAfterFar,
    decoyTranslations: starts
      .filter((request) => request.sourceText.includes('NATIVE_DOM_DECOY_MUTATION'))
      .map((request) => request.cueId),
    liveVodSchedulerEvents: live
      ? recording.scheduler.filter((entry) => entry.mode === 'vod-json3').length +
        requests.filter((request) => request.mode === 'vod-json3').length
      : 0,
    instrumentationPresent: requests.length > 0 || recording.scheduler.length > 0,
  };
}

export function computeJson3QualityReport(
  manifest: ExpectedJson3Manifest,
  recording: Json3Recording,
  requests: NetworkRequestCounts,
  options: {
    phase?: string;
    live?: boolean;
    longTrackCueCount?: number;
    fixtureSha256?: string;
    /** Other valid manifest cues may continue playing outside this targeted subset. */
    allowUnexpected?: boolean;
  } = {},
): Json3QualityReport {
  const phase = options.phase ?? 'normal';
  const live = options.live === true;
  const samples = recording.samples.filter((sample) => sample.phase === phase);
  const transitions = recording.transitions.filter((transition) => transition.phase === phase);
  const lagDetails = manifest.cues.map((cue): CueLagDetail => {
    const crossing = crossingForCue(
      cue,
      [...recording.samples, ...recording.transitions, ...recording.requests].sort(
        (left, right) => left.atMs - right.atMs,
      ),
      phase,
    );
    const expectedText = normalizeJson3Caption(cue.expectedJa);
    const transitionPaints = transitions.filter(
      (transition) =>
        transition.visible &&
        !transition.censored &&
        normalizeJson3Caption(transition.caption) === expectedText &&
        (crossing === null || transition.epoch === crossing.epoch),
    );
    // A cached seek repaint can set the same attribute value and produce no DOM
    // mutation. The paint cache-hit still proves that the due cue was selected.
    const cachePaints = recording.requests.filter(
      (request) =>
        request.phase === phase &&
        request.action === 'cache-hit' &&
        request.visible &&
        normalizeJson3Caption(request.caption ?? '') === expectedText &&
        (crossing === null || request.epoch === crossing.epoch),
    );
    const paints = [...transitionPaints, ...cachePaints].sort(
      (left, right) => left.atMs - right.atMs,
    );
    const earlyPaint = paints.some((paint) => paint.mediaMs < cue.startMs);
    const painted = crossing ? paints.find((paint) => paint.mediaMs >= cue.startMs) : undefined;
    return {
      cueId: cue.id,
      crossingAtMs: crossing?.atMs ?? null,
      paintedAtMs: painted?.atMs ?? null,
      lagMs: crossing && painted ? painted.atMs - crossing.atMs : Number.POSITIVE_INFINITY,
      earlyPaint,
    };
  });
  const lags = lagDetails.map((detail) => detail.lagMs);
  const dwellIntervals = visibilityIntervals(manifest, recording, phase, 'caption');
  const sourceIntervals = visibilityIntervals(manifest, recording, phase, 'original', 'source:');
  const fullyObserved = dwellIntervals.filter((interval) => !interval.censored);
  const belowMinimum = fullyObserved.filter(
    (interval) => interval.dwellMs < JSON3_THRESHOLDS.minimumDwellMs,
  );
  const jaOrder = firstAppearanceOrder(manifest, dwellIntervals);
  const sourceOrder = firstAppearanceOrder(
    manifest,
    sourceIntervals.map((interval) => ({ ...interval, cueId: interval.cueId.slice(7) })),
  );
  const jaCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  dwellIntervals.forEach((interval) =>
    jaCounts.set(interval.cueId, (jaCounts.get(interval.cueId) ?? 0) + 1),
  );
  sourceIntervals.forEach((interval) => {
    const id = interval.cueId.slice(7);
    sourceCounts.set(id, (sourceCounts.get(id) ?? 0) + 1);
  });
  const knownJa = new Set(manifest.cues.map((cue) => normalizeJson3Caption(cue.expectedJa)));
  const knownSource = new Set(manifest.cues.map((cue) => normalizeJson3Caption(cue.source)));
  const unexpectedTranslations = options.allowUnexpected
    ? []
    : [
        ...new Set(
          transitions
            .filter((transition) => !transition.censored)
            .map((transition) => normalizeJson3Caption(transition.caption))
            .filter((caption) => caption.length > 0 && !knownJa.has(caption)),
        ),
      ];
  const unexpectedSources = options.allowUnexpected
    ? []
    : [
        ...new Set(
          transitions
            .filter((transition) => !transition.censored)
            .map((transition) => normalizeJson3Caption(transition.original))
            .filter((original) => original.length > 0 && !knownSource.has(original)),
        ),
      ];
  const content: ContentAudit = {
    missingJaIds: manifest.cues.filter((cue) => !jaCounts.has(cue.id)).map((cue) => cue.id),
    missingSourceIds: manifest.cues.filter((cue) => !sourceCounts.has(cue.id)).map((cue) => cue.id),
    duplicatedJaIds: [...jaCounts].filter(([, count]) => count > 1).map(([id]) => id),
    duplicatedSourceIds: [...sourceCounts].filter(([, count]) => count > 1).map(([id]) => id),
    reorderedJaIds: sameOrder(
      jaOrder,
      manifest.cues.map((cue) => cue.id),
    )
      ? []
      : jaOrder,
    reorderedSourceIds: !sameOrder(
      sourceOrder,
      manifest.cues.map((cue) => cue.id),
    ),
    unexpectedTranslations,
    unexpectedSources,
    observedJaOrder: jaOrder,
    observedSourceOrder: sourceOrder,
  };
  const numericMismatches: NumericMismatch[] = [];
  for (const cue of manifest.cues) {
    const interval = dwellIntervals.find((candidate) => candidate.cueId === cue.id);
    const paint = interval
      ? transitions.find(
          (transition) =>
            transition.atMs === interval.shownAtMs &&
            normalizeJson3Caption(transition.caption) === normalizeJson3Caption(cue.expectedJa),
        )
      : undefined;
    const actual = paint ? numericLexemes(paint.caption) : [];
    const forbiddenForms = cue.numericLexemes
      .filter((lexeme) => lexeme.includes('.'))
      .map((lexeme) => lexeme.replace('.', ''))
      .filter((forbidden) => paint?.caption.includes(forbidden));
    if (!sameOrder(actual, cue.numericLexemes) || forbiddenForms.length > 0) {
      numericMismatches.push({
        cueId: cue.id,
        expected: cue.numericLexemes,
        actual,
        forbiddenForms,
      });
    }
  }
  const scheduler = computeSchedulerAudit(recording, live);
  const failures: string[] = [];
  if (manifest.cues.length < Math.min(JSON3_THRESHOLDS.minimumCueCount, manifest.minimumCueCount)) {
    failures.push('vacuous cue sample');
  }
  if (linearPercentile(lags, 0.5) > JSON3_THRESHOLDS.medianCueLagMs)
    failures.push('median cue-start lag');
  if (linearPercentile(lags, 0.95) > JSON3_THRESHOLDS.p95CueLagMs)
    failures.push('p95 cue-start lag');
  lagDetails
    .filter((detail) => detail.earlyPaint)
    .forEach((detail) => failures.push(detail.cueId + ': early paint'));
  belowMinimum.forEach((interval) => failures.push(interval.cueId + ': dwell below 1200ms'));
  if (content.missingJaIds.length > 0)
    failures.push('missing JA cues: ' + content.missingJaIds.join(','));
  if (content.missingSourceIds.length > 0)
    failures.push('missing source cues: ' + content.missingSourceIds.join(','));
  if (content.duplicatedJaIds.length > 0 || content.duplicatedSourceIds.length > 0)
    failures.push('duplicated content');
  if (content.reorderedJaIds.length > 0 || content.reorderedSourceIds)
    failures.push('reordered content');
  if (unexpectedTranslations.length > 0 || unexpectedSources.length > 0)
    failures.push('partial or unexpected content');
  if (numericMismatches.length > 0) failures.push('numeric lexeme mismatch');
  if (!live && requests.json3 !== 1)
    failures.push('expected exactly one json3 GET, saw ' + requests.json3);
  if (requests.vtt !== 0) failures.push('unexpected VTT GET');
  if (!live && !scheduler.instrumentationPresent)
    failures.push('translation/scheduler instrumentation is missing');
  if (!live && scheduler.maxOutstanding > JSON3_THRESHOLDS.maximumOutstanding)
    failures.push('outstanding request budget exceeded');
  if (!live && scheduler.initialRequests > JSON3_THRESHOLDS.maximumInitialRequests)
    failures.push('initial whole-track translation burst');
  if (scheduler.activeAfterFar.length > 0) failures.push('active cue scheduled behind far work');
  if (scheduler.decoyTranslations.length > 0)
    failures.push('native VOD DOM decoy caused translation');
  if (scheduler.liveVodSchedulerEvents > 0) failures.push('live session invoked VOD scheduler');
  if (
    (options.longTrackCueCount ?? 0) > 0 &&
    scheduler.initialRequests >= (options.longTrackCueCount ?? 0)
  ) {
    failures.push('whole long track submitted during initial load');
  }

  return {
    scenarioId: manifest.scenarioId,
    phase,
    sampleCount: samples.length,
    ...(options.fixtureSha256 ? { fixtureSha256: options.fixtureSha256 } : {}),
    lag: {
      medianMs: linearPercentile(lags, 0.5),
      p95Ms: linearPercentile(lags, 0.95),
      worstMs: lags.length > 0 ? Math.max(...lags) : Number.POSITIVE_INFINITY,
      details: lagDetails,
    },
    dwell: {
      minimumMs: JSON3_THRESHOLDS.minimumDwellMs,
      shortestMs:
        fullyObserved.length > 0
          ? Math.min(...fullyObserved.map((interval) => interval.dwellMs))
          : Number.POSITIVE_INFINITY,
      intervals: dwellIntervals,
      belowMinimum,
    },
    content,
    numericMismatches,
    requests,
    scheduler,
    failures,
  };
}

/** A separate deterministic long payload exercises bounded scheduling without a transcript fixture. */
export function makeLongJson3Track(cueCount = 96): Json3Track {
  return {
    events: Array.from({ length: cueCount }, (_, index) => ({
      tStartMs: index * 5_000,
      dDurationMs: 1_500,
      segs: [
        { utf8: 'Long track cue ' + index + '.', tOffsetMs: 0 },
        { utf8: ' tail', tOffsetMs: 500 },
      ],
    })),
  };
}
