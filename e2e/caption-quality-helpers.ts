import type { Page } from '@playwright/test';

/** One expected display unit from the json3 fixture. Times are media milliseconds. */
export interface QualitySentence {
  text: string;
  startMs: number;
  endMs: number;
}

export interface QualityRun {
  language: 'ja' | 'en';
  target: 'en' | 'ja';
  sentences: QualitySentence[];
}

/** Thresholds are deliberately tight: the fake engine has no real decode cost. */
export const THRESHOLDS = {
  /** Sampler cadence. 50ms leaves >100 samples over a 6s track. */
  sampleIntervalMs: 50,
  /** From the playhead crossing a unit's start until its translation is painted. */
  showLatencyMs: 250,
  /** After a seek until the unit at the new playhead is painted. */
  seekSettleMs: 400,
  /**
   * After the next unit starts until the previous text is gone. The product
   * intentionally holds a finished line through up to 2s of real silence
   * (CAPTION_HOLD_MAX_MS); this window allows scheduler slack without hiding
   * a genuinely stale line once the next cue has started.
   */
  cueAdvanceMs: 400,
  /** Compact overlay: one translated line, optionally one original line. */
  maxVisibleLines: 2,
  /** Fraction of active frames allowed to show a non-sentence string at all. */
  partialFrameRatio: 0.08,
  /** Longest continuous stretch allowed for an intermediate/duplicate string. */
  partialDwellMs: 250,
  /** Worst acceptable delay from a native ASR chunk appearing to Japanese paint. */
  asrShowLatencyMs: 400,
} as const;

export interface RectSample {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** One ~50ms observation of the Sakutto overlay and the fake player. */
export interface CaptionSample {
  atMs: number;
  mediaMs: number;
  rate: number;
  paused: boolean;
  phase: string;
  visible: boolean;
  captionState: string;
  caption: string;
  original: string;
  /** Text of the currently visible shadow lines (catches pending labels). */
  lines: string[];
  pending: boolean;
  lineCount: number;
  overlay: RectSample | null;
  player: RectSample | null;
  nativeVisible: boolean;
  nativeText: string;
  /** Fake-engine count of pure sound tags sent to the model (0 in a correct build). */
  soundTagTranslations: number;
  decoyInBar: boolean;
}

export interface ScenarioStep {
  phase: string;
  /** Repositions the playhead: a seek test, a rewind to 0 for a rate run, etc. */
  seekMs?: number;
  /**
   * Marks a *pure seek* step, whose metric is seek-settle. Rate and tail steps also
   * reposition the playhead via seekMs, but leave this unset so their subsequent
   * play is measured for show-latency and cue-advance.
   */
  seek?: boolean;
  rate?: number;
  pause?: boolean;
  dwellMs: number;
}

export interface MetricResult {
  name: string;
  value: number;
  threshold: number;
  unit: string;
  passed: boolean;
  detail: string;
}

export interface QualityReport {
  language: string;
  sampleCount: number;
  sentencesSeen: string[];
  unexpectedStrings: string[];
  metrics: MetricResult[];
  failures: string[];
}

/** Samples only the Sakutto host/shadow, never the surrounding watch page. */
export async function installCaptionSampler(page: Page): Promise<void> {
  await page.evaluate((intervalMs) => {
    const state = globalThis as unknown as {
      __captionQualitySampler?: {
        samples: unknown[];
        phase: string;
        timer: number;
        mark(phase: string): void;
        reset(): void;
        stop(): void;
        tick(): void;
      };
      __captionQuality?: { decoy?: string };
    };
    const samples: unknown[] = [];
    let phase = 'idle';

    const readRect = (node: Element | null) => {
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };

    const tick = (): void => {
      const video = document.querySelector('#player') as HTMLVideoElement | null;
      const host = document.querySelector('sakutto-captions') as HTMLElement | null;
      const caption = host?.getAttribute('data-sakutto-caption') ?? '';
      const original = host?.getAttribute('data-sakutto-original') ?? '';
      const shadow = host?.shadowRoot ?? null;
      const lineTexts = shadow
        ? Array.from(shadow.querySelectorAll('.line'))
            .filter((line) => {
              const element = line as HTMLElement;
              return (
                !element.hidden &&
                window.getComputedStyle(element).display !== 'none' &&
                (element.textContent ?? '').trim().length > 0
              );
            })
            .map((line) => (line.textContent ?? '').trim())
        : [];
      const native = document.querySelector('.ytp-caption-window-container') as HTMLElement | null;
      const nativeStyle = native ? window.getComputedStyle(native) : null;
      const nativeVisible = Boolean(
        native &&
        nativeStyle &&
        nativeStyle.visibility !== 'hidden' &&
        nativeStyle.display !== 'none' &&
        nativeStyle.opacity !== '0',
      );
      const decoy = state.__captionQuality?.decoy ?? 'UNRELATED_PAGE_COPY_DECOY_7A3F';
      const barText = [caption, original, ...lineTexts].join(' ');
      samples.push({
        atMs: performance.now(),
        mediaMs: Math.round((video?.currentTime ?? 0) * 1000),
        rate: video?.playbackRate ?? 0,
        paused: video?.paused ?? true,
        phase,
        visible: Boolean(host && !host.hidden && caption.length > 0),
        captionState: document.documentElement.getAttribute('data-sakutto-captions') ?? '',
        caption,
        original,
        lines: lineTexts,
        pending: host?.getAttribute('data-sakutto-pending') === '1',
        lineCount: lineTexts.length,
        overlay: readRect(document.querySelector('sakutto-captions')),
        player: readRect(document.querySelector('#movie_player')),
        nativeVisible,
        nativeText: native?.textContent?.trim() ?? '',
        soundTagTranslations: Number(
          document.documentElement.getAttribute('data-bench-sound-tag-translations') ?? '0',
        ),
        decoyInBar: barText.includes(decoy),
      });
    };

    const sampler = {
      samples,
      get phase() {
        return phase;
      },
      set phase(value: string) {
        phase = value;
      },
      timer: 0,
      mark(next: string): void {
        phase = next;
      },
      reset(): void {
        samples.length = 0;
        phase = 'idle';
      },
      stop(): void {
        window.clearInterval(sampler.timer);
      },
      tick,
    };
    state.__captionQualitySampler = sampler;
    sampler.timer = window.setInterval(tick, intervalMs);
    tick();
  }, THRESHOLDS.sampleIntervalMs);
}

/** Drive play, seek, pause/resume and playback-rate changes with timed marks. */
export async function driveScenario(page: Page, steps: readonly ScenarioStep[]): Promise<number> {
  return page.evaluate(async (scenario) => {
    const video = document.querySelector('#player') as HTMLVideoElement | null;
    const sampler = (
      globalThis as unknown as {
        __captionQualitySampler?: {
          samples: unknown[];
          mark(phase: string): void;
          reset(): void;
        };
      }
    ).__captionQualitySampler;
    if (!video || !sampler) throw new Error('caption sampler or player missing');
    sampler.reset();
    video.playbackRate = 1;
    video.currentTime = 0;
    if (video.paused) await video.play();
    for (const step of scenario) {
      sampler.mark(step.phase);
      if (step.seekMs !== undefined) video.currentTime = step.seekMs / 1000;
      if (step.rate !== undefined) video.playbackRate = step.rate;
      if (step.pause === true) video.pause();
      else if (video.paused) await video.play();
      await new Promise((resolve) => window.setTimeout(resolve, step.dwellMs));
    }
    video.pause();
    return sampler.samples.length;
  }, steps);
}

export async function readSamples(page: Page): Promise<CaptionSample[]> {
  return page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __captionQualitySampler?: { samples: CaptionSample[] };
        }
      ).__captionQualitySampler?.samples ?? [],
  );
}

export async function stopCaptionSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      globalThis as unknown as {
        __captionQualitySampler?: { stop(): void };
      }
    ).__captionQualitySampler?.stop();
  });
}

export function metric(
  name: string,
  value: number,
  threshold: number,
  unit: string,
  passed: boolean,
  detail: string,
): MetricResult {
  return { name, value, threshold, unit, passed, detail };
}

/** Linear interpolation converts a media-time boundary to the wall-clock sample axis. */
function crossingAt(samples: readonly CaptionSample[], mediaMs: number): number | null {
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1];
    const after = samples[index];
    if (!before || !after) continue;
    if (before.mediaMs < mediaMs && after.mediaMs >= mediaMs && after.mediaMs > before.mediaMs) {
      const ratio = (mediaMs - before.mediaMs) / (after.mediaMs - before.mediaMs);
      return before.atMs + (after.atMs - before.atMs) * ratio;
    }
    if (before.mediaMs === mediaMs) return before.atMs;
  }
  return null;
}

function phaseSamples(samples: readonly CaptionSample[], phase: string): CaptionSample[] {
  return samples.filter((sample) => sample.phase === phase);
}

/** Compute all caption-quality metrics; each result carries its own hard threshold. */
export function computeQualityReport(
  run: QualityRun,
  samples: readonly CaptionSample[],
  steps: readonly ScenarioStep[],
): QualityReport {
  const marker = '§' + run.target + '§';
  const expected = new Map(
    run.sentences.map((sentence) => [sentence.text, marker + sentence.text] as const),
  );
  const expectedTexts = new Set(expected.values());
  const sentencesSeen: string[] = [];
  for (const text of expectedTexts) {
    if (samples.some((sample) => sample.caption === text)) sentencesSeen.push(text);
  }
  const unexpected = new Set<string>();
  for (const sample of samples) {
    if (sample.caption.length > 0 && !expectedTexts.has(sample.caption)) {
      unexpected.add(sample.caption);
    }
  }

  const inSentence = (sample: CaptionSample): boolean =>
    run.sentences.some(
      (sentence) => sample.mediaMs >= sentence.startMs && sample.mediaMs < sentence.endMs,
    );
  const active = samples.filter((sample) => sample.caption.length > 0 && inSentence(sample));
  const partial = active.filter((sample) => !expectedTexts.has(sample.caption));
  let longestPartialMs = 0;
  let partialStart: number | null = null;
  for (const sample of samples) {
    const isPartial =
      sample.caption.length > 0 && inSentence(sample) && !expectedTexts.has(sample.caption);
    if (isPartial && partialStart === null) partialStart = sample.atMs;
    if (!isPartial && partialStart !== null) {
      longestPartialMs = Math.max(longestPartialMs, sample.atMs - partialStart);
      partialStart = null;
    }
  }
  if (partialStart !== null && samples.length > 0) {
    const last = samples[samples.length - 1];
    if (last) longestPartialMs = Math.max(longestPartialMs, last.atMs - partialStart);
  }

  const latencies: number[] = [];
  const latencyDetails: string[] = [];
  for (const step of steps) {
    if (step.seek === true || step.pause === true) continue;
    const frames = phaseSamples(samples, step.phase);
    for (const sentence of run.sentences) {
      if (sentence.startMs === 0) continue; // already painted before play starts
      const crossed = crossingAt(frames, sentence.startMs);
      if (crossed === null) continue;
      const appearance = frames.find(
        (sample) => sample.caption === expected.get(sentence.text) && sample.atMs >= crossed - 50,
      );
      const latency = appearance
        ? Math.max(0, appearance.atMs - crossed)
        : Number.POSITIVE_INFINITY;
      latencies.push(latency);
      latencyDetails.push(step.phase + ':' + sentence.text + '=' + Math.round(latency));
    }
  }
  const worstLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

  const settles: number[] = [];
  const advance: number[] = [];
  for (const step of steps) {
    const frames = phaseSamples(samples, step.phase);
    if (frames.length === 0) continue;
    if (step.seek === true) {
      const target = run.sentences.find(
        (sentence) =>
          step.seekMs !== undefined &&
          step.seekMs >= sentence.startMs &&
          step.seekMs < sentence.endMs,
      );
      if (!target) continue;
      const start = frames[0]?.atMs ?? 0;
      const shown = frames.find((sample) => sample.caption === expected.get(target.text));
      settles.push(shown ? Math.max(0, shown.atMs - start) : Number.POSITIVE_INFINITY);
      continue;
    }
    for (let index = 1; index < run.sentences.length; index += 1) {
      const next = run.sentences[index];
      const previous = run.sentences[index - 1];
      if (!next || !previous) continue;
      const crossed = crossingAt(frames, next.startMs);
      if (crossed === null) continue;
      const cleared = frames.find(
        (sample) => sample.atMs >= crossed - 50 && sample.caption !== expected.get(previous.text),
      );
      advance.push(cleared ? Math.max(0, cleared.atMs - crossed) : Number.POSITIVE_INFINITY);
    }
  }
  const worstSettle = settles.length > 0 ? Math.max(...settles) : 0;
  const worstAdvance = advance.length > 0 ? Math.max(...advance) : 0;

  // A rollback is a *committed sentence* reappearing while a later unit has already
  // had its advance window. Short holds during a genuine gap are allowed by design.
  const jumps = samples.filter((sample) => {
    const shownIndex = run.sentences.findIndex(
      (sentence) => sample.caption === expected.get(sentence.text),
    );
    if (shownIndex < 0) return false;
    return run.sentences.some(
      (sentence, index) =>
        index > shownIndex &&
        sample.mediaMs >= sentence.startMs + THRESHOLDS.cueAdvanceMs &&
        sample.mediaMs < sentence.endMs,
    );
  }).length;

  const layoutBad = samples.filter((sample) => {
    if (!sample.visible || !sample.overlay || !sample.player) return false;
    return (
      sample.overlay.left < sample.player.left - 2 ||
      sample.overlay.right > sample.player.right + 2 ||
      sample.overlay.top < sample.player.top - 2 ||
      sample.overlay.bottom > sample.player.bottom + 2 ||
      sample.lineCount > THRESHOLDS.maxVisibleLines
    );
  }).length;
  const nativeLeaks = samples.filter((sample) => sample.visible && sample.nativeVisible).length;
  const decoyLeaks = samples.filter((sample) => sample.decoyInBar).length;

  const metrics: MetricResult[] = [
    metric(
      'sentence-units: complete units only',
      active.length === 0 ? 1 : partial.length / active.length,
      THRESHOLDS.partialFrameRatio,
      'ratio',
      active.length > 0 && partial.length / active.length <= THRESHOLDS.partialFrameRatio,
      'active frames whose text is not a full expected sentence; unexpected=' +
        JSON.stringify([...unexpected]),
    ),
    metric(
      'sentence-units: longest partial dwell',
      Math.round(longestPartialMs),
      THRESHOLDS.partialDwellMs,
      'ms',
      longestPartialMs <= THRESHOLDS.partialDwellMs,
      'longest continuous display of a fragment/duplicate string',
    ),
    metric(
      'sentence-units: all sentences observed',
      sentencesSeen.length,
      run.sentences.length,
      'count',
      sentencesSeen.length === run.sentences.length,
      'seen=' + JSON.stringify(sentencesSeen),
    ),
    metric(
      'show-latency: worst',
      Math.round(worstLatency),
      THRESHOLDS.showLatencyMs,
      'ms',
      worstLatency <= THRESHOLDS.showLatencyMs,
      'per-sentence ms by phase at 1x/1.5x/2x: ' + latencyDetails.join(', '),
    ),
    metric(
      'seek-settle: worst',
      Math.round(worstSettle),
      THRESHOLDS.seekSettleMs,
      'ms',
      worstSettle <= THRESHOLDS.seekSettleMs,
      'forward and backward seeks',
    ),
    metric(
      'no-stale: cue advance',
      Math.round(worstAdvance),
      THRESHOLDS.cueAdvanceMs,
      'ms',
      worstAdvance <= THRESHOLDS.cueAdvanceMs,
      'previous unit persisting after the next cue starts (1x/1.5x/2x, incl. tail after seek)',
    ),
    metric(
      'no-flicker: jump-back frames',
      jumps,
      0,
      'frames',
      jumps === 0,
      'frames showing a sentence after its window ended',
    ),
    metric(
      'overlay-isolation: decoy leaks',
      decoyLeaks,
      0,
      'frames',
      decoyLeaks === 0,
      'decoy watch-page copy inside caption attributes or shadow lines',
    ),
    metric(
      'layout: overflow or too many lines',
      layoutBad,
      0,
      'frames',
      layoutBad === 0,
      'host rect outside the player or more than ' + THRESHOLDS.maxVisibleLines + ' lines',
    ),
    metric(
      'native-captions-hidden',
      nativeLeaks,
      0,
      'frames',
      nativeLeaks === 0,
      'frames with a visible native caption while Sakutto paints',
    ),
  ];
  return {
    language: run.language,
    sampleCount: samples.length,
    sentencesSeen,
    unexpectedStrings: [...unexpected],
    metrics,
    failures: metrics
      .filter((entry) => !entry.passed)
      .map((entry) => entry.name + ': ' + entry.value + ' ' + entry.unit + ' > ' + entry.threshold),
  };
}
