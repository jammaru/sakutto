import { estimateTokens } from '@/engine/text/tokens';

export interface PageRates {
  tokensPerSecond: number | null;
  segmentsPerSecond: number | null;
}

const MIN_ELAPSED_MS = 400;

/** Live page rates from the text painted so far. Tokens use the same estimate as the planner. */
export function pageRates(input: {
  active: boolean;
  elapsedMs: number;
  done: number;
  output: string;
}): PageRates {
  if (!input.active || input.elapsedMs < MIN_ELAPSED_MS) {
    return { tokensPerSecond: null, segmentsPerSecond: null };
  }
  if (input.done === 0 && input.output.trim().length === 0) {
    return { tokensPerSecond: null, segmentsPerSecond: null };
  }

  const seconds = input.elapsedMs / 1000;
  const tokens = input.output.trim().length === 0 ? 0 : estimateTokens(input.output);
  return {
    tokensPerSecond: Math.round((tokens / seconds) * 10) / 10,
    segmentsPerSecond: Math.round((input.done / seconds) * 10) / 10,
  };
}

export function formatRate(value: number): string {
  return value.toFixed(1);
}
