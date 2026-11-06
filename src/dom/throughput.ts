import { estimateTokens } from '@/engine/text/tokens';

export interface PageRates {
  tokensPerSecond: number | null;
  segmentsPerSecond: number | null;
}

/** One observation of how much translated text and how many pieces were finished. */
export interface ThroughputSample {
  atMs: number;
  tokens: number;
  segments: number;
}

/** Recent window. Older bursts drop out instead of diluting the live rate forever. */
export const RATE_WINDOW_MS = 5_000;

/**
 * How long a measured rate stays on the bar while the model is prefilling and no new
 * tokens arrive. The lifetime average used to fall through that gap and look stalled.
 */
export const RATE_HOLD_MS = 8_000;

const MIN_SPAN_MS = 400;

/** Live page rates from recent output, not from the whole time since Start. */
export function pageRates(input: {
  active: boolean;
  nowMs: number;
  samples: readonly ThroughputSample[];
}): PageRates {
  if (!input.active) return { tokensPerSecond: null, segmentsPerSecond: null };
  return {
    tokensPerSecond: rateOf(input.samples, input.nowMs, (sample) => sample.tokens),
    segmentsPerSecond: rateOf(input.samples, input.nowMs, (sample) => sample.segments),
  };
}

export function formatRate(value: number): string {
  return value.toFixed(1);
}

/** One decimal while a block is mid-piece, and an integer when the count is whole. */
export function formatProgressCount(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(1);
}

export function roundProgress(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Counts finished pieces, plus half a piece while its text is already on screen.
 * A long paragraph therefore moves the bar before the whole block is done.
 */
export function coveredBlocks(
  items: readonly {
    state: string;
    partFinal: readonly boolean[];
    partText: readonly string[];
  }[],
): number {
  let covered = 0;
  for (const item of items) {
    if (item.state === 'done') {
      covered += 1;
      continue;
    }
    if (item.partFinal.length === 0) {
      if (item.partText.some((part) => part.trim().length > 0)) covered += 0.5;
      continue;
    }
    let credit = 0;
    for (let index = 0; index < item.partFinal.length; index += 1) {
      if (item.partFinal[index]) {
        credit += 1;
        continue;
      }
      if ((item.partText[index] ?? '').trim().length > 0) credit += 0.5;
    }
    covered += credit / item.partFinal.length;
  }
  return covered;
}

export function outputTokenCount(parts: readonly string[]): number {
  const output = parts.join('\n');
  if (output.trim().length === 0) return 0;
  return estimateTokens(output);
}

function rateOf(
  samples: readonly ThroughputSample[],
  nowMs: number,
  pick: (sample: ThroughputSample) => number,
): number | null {
  if (samples.length < 2) return null;

  const windowStart = nowMs - RATE_WINDOW_MS;
  let baseline = samples[0];
  if (!baseline) return null;
  for (const sample of samples) {
    if (sample.atMs <= windowStart) baseline = sample;
    else break;
  }

  let last = baseline;
  for (const sample of samples) {
    if (sample.atMs < baseline.atMs || sample.atMs > nowMs) continue;
    if (pick(sample) > pick(last)) last = sample;
  }

  if (last === baseline || last.atMs < windowStart) return null;
  const span = last.atMs - baseline.atMs;
  if (span < MIN_SPAN_MS) return null;
  const delta = pick(last) - pick(baseline);
  if (delta <= 0) return null;
  return Math.round((delta / (span / 1000)) * 10) / 10;
}
