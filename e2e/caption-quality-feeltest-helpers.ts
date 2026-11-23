import type { CaptionSample, MetricResult, QualityReport } from './caption-quality-helpers';
import { metric } from './caption-quality-helpers';

/** One owner-style rolling ASR window and the cumulative source text it must cover. */
export interface FeeltestChunk {
  startMs: number;
  endMs: number;
  native: string;
  expected: string;
}

export interface FeeltestRun {
  chunks: readonly FeeltestChunk[];
  /** Localised pending labels that must never replace a mid-stream caption. */
  pendingTexts: readonly string[];
}

export const FEELTEST_THRESHOLDS = {
  /** Product goal; reported alongside the hard cap. */
  lagTargetMs: 1_000,
  /** Owner-derived hard cap from native caption appearance to Japanese overlay. */
  lagWorstMs: 2_000,
  /** Grace period before a complete native sentence must have a closed translation. */
  completeAfterMs: 1_200,
} as const;

/** Cross-language marker tokens are not part of the covered text. */
function cleanCaption(text: string): string {
  return text
    .replace(/§[a-z-]+§/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s+([.,!?;:])/gu, '$1')
    .trim();
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const before = sorted[Math.floor(index)] ?? 0;
  const after = sorted[Math.ceil(index)] ?? before;
  return Math.round(before + (after - before) * (index - Math.floor(index)));
}

interface Appearance {
  chunk: FeeltestChunk;
  atMs: number;
  index: number;
}

/** Derive wall-clock native appearances directly from the sampler, not the fixture clock. */
function nativeAppearances(run: FeeltestRun, samples: readonly CaptionSample[]): Appearance[] {
  const found: Appearance[] = [];
  let lastNative = '';
  samples.forEach((sample, index) => {
    const text = sample.nativeText.trim();
    if (text.length === 0) {
      lastNative = '';
      return;
    }
    if (text === lastNative) return;
    lastNative = text;
    const chunk = run.chunks.find((candidate) => candidate.native === text);
    if (chunk) found.push({ chunk, atMs: sample.atMs, index });
  });
  return found;
}

/**
 * Feel-test metrics for rolling ASR growth with a non-instant, queued translation model.
 * Latency is wall-clock from the first sampled native window to the first overlay that
 * covers that window; quality rates are fractions of active overlay frames.
 */
export function computeFeeltestReport(
  run: FeeltestRun,
  samples: readonly CaptionSample[],
): QualityReport {
  const appearances = nativeAppearances(run, samples);
  const lags: number[] = [];
  const lagDetails: string[] = [];
  const covered = new Set<string>();
  appearances.forEach((appearance, index) => {
    const expected = cleanCaption(appearance.chunk.expected);
    const stop = appearances[index + 1]?.index ?? samples.length;
    const shown = samples.slice(appearance.index, stop).find((sample) => {
      const caption = cleanCaption(sample.caption);
      return caption === expected || caption.startsWith(expected);
    });
    const lag = shown ? Math.max(0, shown.atMs - appearance.atMs) : Number.POSITIVE_INFINITY;
    lags.push(lag);
    if (shown) covered.add(appearance.chunk.native);
    lagDetails.push(
      appearance.chunk.native.slice(0, 28) +
        '=' +
        (Number.isFinite(lag) ? Math.round(lag) : 'missing'),
    );
  });
  const worstLag = lags.length > 0 ? Math.max(...lags) : Number.POSITIVE_INFINITY;
  const p95Lag = percentile(lags, 0.95);

  let activeFrames = 0;
  let skipFrames = 0;
  const skipDetails: string[] = [];
  for (const sample of samples) {
    const caption = cleanCaption(sample.caption);
    if (caption.length === 0) continue;
    const position = appearances.findIndex(
      (entry) => entry.chunk.native === sample.nativeText.trim(),
    );
    if (position < 0) continue;
    activeFrames += 1;
    const chunk = appearances[position]?.chunk;
    const previous = position > 0 ? appearances[position - 1]?.chunk : undefined;
    if (!chunk) continue;
    const expected = cleanCaption(chunk.expected);
    const previousExpected = cleanCaption(previous?.expected ?? '');
    const fresh = expected.startsWith(previousExpected)
      ? expected.slice(previousExpected.length)
      : expected;
    const distinctive = fresh
      .split(/\s+/u)
      .map((word) => word.replace(/[^A-Za-z0-9]/gu, ''))
      .filter((word) => word.length >= 4)
      .slice(-3);
    const carriesNewSpeech = distinctive.some((word) =>
      caption.toLowerCase().includes(word.toLowerCase()),
    );
    const orderedPrefix = expected.startsWith(caption) || caption.startsWith(expected);
    if (carriesNewSpeech && !orderedPrefix) {
      skipFrames += 1;
      if (skipDetails.length < 6) skipDetails.push(caption.slice(0, 90));
    }
  }
  const skipRate = activeFrames > 0 ? skipFrames / activeFrames : 1;

  const spans = [
    'I had some technical difficulties',
    'during my talk this morning',
    'I ran back home',
    "I'm just going to record it",
    "I'm Lydia",
    'the Cloud Code team at Anthropic',
    'the models have gotten really good lately',
    'Opus 55',
    'Fable 52',
    'understanding your codebase',
  ];
  let duplicateFrames = 0;
  const duplicateDetails: string[] = [];
  for (const sample of samples) {
    const caption = cleanCaption(
      sample.caption.length > 0 ? sample.caption : sample.lines.join(' '),
    ).toLowerCase();
    if (caption.length === 0) continue;
    const repeated = spans.filter((span) => {
      const needle = span.toLowerCase();
      const first = caption.indexOf(needle);
      return first >= 0 && caption.indexOf(needle, first + needle.length) >= 0;
    });
    if (repeated.length === 0) continue;
    duplicateFrames += 1;
    if (duplicateDetails.length < 6)
      duplicateDetails.push(repeated.join('+') + ': ' + caption.slice(0, 80));
  }
  const duplicateRate = activeFrames > 0 ? duplicateFrames / activeFrames : 1;

  const firstNativeAt = appearances[0]?.atMs ?? Number.POSITIVE_INFINITY;
  const loadingFrames = samples.filter(
    (sample) =>
      sample.atMs > firstNativeAt &&
      [...sample.lines, sample.caption, sample.original].some(
        (text) =>
          run.pendingTexts.some((label) => text.includes(label)) || text.includes('字幕を翻訳'),
      ),
  ).length;

  let incompleteFrames = 0;
  const incompleteDetails: string[] = [];
  for (const sample of samples) {
    const caption = cleanCaption(sample.caption);
    const lineText = sample.lines.join(' ').trim();
    if (sample.atMs <= firstNativeAt) continue;
    if (caption.length === 0) {
      if (/…$|\.\.\.$/u.test(lineText)) {
        incompleteFrames += 1;
        if (incompleteDetails.length < 6) incompleteDetails.push(lineText.slice(0, 80));
      }
      continue;
    }
    const position = appearances.findIndex(
      (entry) => entry.chunk.native === sample.nativeText.trim(),
    );
    const appearance = appearances[position];
    const chunk = appearance?.chunk;
    if (!appearance || !chunk) continue;
    const elapsed = sample.atMs - appearance.atMs;
    const endsWithEllipsis = /…$|\.\.\.$/u.test(caption);
    const nativeComplete = /[.!?]$/u.test(chunk.native.trim());
    const unfinished =
      !caption.endsWith('.') && !caption.endsWith('!') && caption !== cleanCaption(chunk.expected);
    if (
      !endsWithEllipsis &&
      !(nativeComplete && elapsed > FEELTEST_THRESHOLDS.completeAfterMs && unfinished)
    )
      continue;
    incompleteFrames += 1;
    if (incompleteDetails.length < 6) incompleteDetails.push(caption.slice(0, 80));
  }

  const metrics: MetricResult[] = [
    metric(
      'e2e-lag-worst',
      Math.round(worstLag),
      FEELTEST_THRESHOLDS.lagWorstMs,
      'ms',
      worstLag <= FEELTEST_THRESHOLDS.lagWorstMs,
      'target p95 <= ' +
        FEELTEST_THRESHOLDS.lagTargetMs +
        ' ms; p95=' +
        p95Lag +
        ' ms; ' +
        lagDetails.join(', '),
    ),
    metric(
      'skip-rate',
      Number(skipRate.toFixed(4)),
      0,
      'ratio',
      skipRate === 0,
      'ordered-prefix violations=' +
        skipFrames +
        '/' +
        activeFrames +
        '; ' +
        skipDetails.join(' | '),
    ),
    metric(
      'duplicate-rate',
      Number(duplicateRate.toFixed(4)),
      0,
      'ratio',
      duplicateRate === 0,
      'repeated-span frames=' +
        duplicateFrames +
        '/' +
        activeFrames +
        '; ' +
        duplicateDetails.join(' | '),
    ),
    metric(
      'loading-text-in-stream',
      loadingFrames,
      0,
      'frames',
      loadingFrames === 0,
      'pending label inside the caption box after playback started',
    ),
    metric(
      'incomplete-ending',
      incompleteFrames,
      0,
      'frames',
      incompleteFrames === 0,
      'ellipsis-only or unfinished clause after a complete native cue: ' +
        incompleteDetails.join(' | '),
    ),
    metric(
      'coverage-chunks',
      covered.size,
      run.chunks.length,
      'count',
      covered.size === run.chunks.length,
      'chunks whose cumulative source reached the overlay; missing=' +
        JSON.stringify(
          run.chunks.filter((chunk) => !covered.has(chunk.native)).map((chunk) => chunk.native),
        ),
    ),
  ];
  return {
    language: 'en',
    sampleCount: samples.length,
    sentencesSeen: [...covered],
    unexpectedStrings: [...new Set(skipDetails)],
    metrics,
    failures: metrics
      .filter((entry) => !entry.passed)
      .map((entry) => entry.name + ': ' + entry.value + ' ' + entry.unit + ' > ' + entry.threshold),
  };
}
