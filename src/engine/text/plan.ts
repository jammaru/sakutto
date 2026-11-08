import type { TranslateSegment } from '../types';
import {
  DEFAULT_MAX_CHUNK_CHARS,
  DEFAULT_PIECE_CHARS,
  DEFAULT_SENTENCE_THRESHOLD,
} from './sentences';
import { estimateTokens } from './tokens';

export interface BatchingConfig {
  maxSegmentTokens: number;
  maxBatchTokens: number;
}

/**
 * Source tokens that still leave room for the prompt template, a small glossary,
 * and a 2× completion inside one sequence. The budget is per sequence.
 */
export function sourceTokenBudget(contextTokens: number): number {
  const overhead = 192;
  const margin = 64;
  const room = contextTokens - overhead - margin;
  return Math.max(96, Math.floor(room / 3));
}

/**
 * Only labels, cells and one-line items share a completion. Packing pays off where the prompt
 * template is as long as the text; for a paragraph it saves a few template tokens but makes
 * the model read unrelated sentences as one text, delays every block in the pack behind the
 * whole pack's prefill, and depends on the model keeping the line count.
 */
export const DEFAULT_BATCHING: Readonly<BatchingConfig> = Object.freeze({
  maxSegmentTokens: 48,
  maxBatchTokens: 160,
});

const MAX_BATCH_SEGMENTS = 8;

export interface PlanConfig extends BatchingConfig {
  sentenceThreshold: number;
  maxChunkChars: number;
  /** A segment longer than this is translated as several prompts of whole sentences. */
  pieceChars: number;
}

export const DEFAULT_PLAN_CONFIG: Readonly<PlanConfig> = Object.freeze({
  ...DEFAULT_BATCHING,
  sentenceThreshold: DEFAULT_SENTENCE_THRESHOLD,
  maxChunkChars: DEFAULT_MAX_CHUNK_CHARS,
  pieceChars: DEFAULT_PIECE_CHARS,
});

export type WorkItem =
  | { kind: 'single'; segment: TranslateSegment }
  | { kind: 'batch'; segments: readonly TranslateSegment[]; text: string };

function toBatch(segments: readonly TranslateSegment[]): WorkItem {
  return {
    kind: 'batch',
    segments,
    text: segments.map((segment) => segment.text.trim()).join('\n'),
  };
}

function isBatchable(segment: TranslateSegment, config: PlanConfig): boolean {
  return !(
    segment.text.trim().length === 0 ||
    segment.text.includes('\n') ||
    segment.text.length > config.maxChunkChars ||
    estimateTokens(segment.text) > config.maxSegmentTokens
  );
}

function planSegments(segments: readonly TranslateSegment[], config: PlanConfig): WorkItem[] {
  const items: WorkItem[] = [];
  let batch: TranslateSegment[] = [];

  const flush = (): void => {
    if (batch.length === 1) {
      const only = batch[0];
      if (only) items.push({ kind: 'single', segment: only });
    } else if (batch.length > 1) {
      items.push(toBatch(batch));
    }
    batch = [];
  };

  for (const segment of segments) {
    const needsOwnRequest = !isBatchable(segment, config);

    if (needsOwnRequest) {
      flush();
      items.push({ kind: 'single', segment });
      continue;
    }

    if (batch.length > 0) {
      const candidate = [...batch, segment];
      const tokens = estimateTokens(candidate.map((entry) => entry.text.trim()).join('\n'));
      if (tokens > config.maxBatchTokens || batch.length >= MAX_BATCH_SEGMENTS) flush();
    }

    batch.push(segment);
  }

  flush();
  return items;
}

/**
 * Groups short segments for newline-joined requests and leaves long or already sizable
 * segments to run alone. The first short segment can stay on its own so its tokens
 * reach the page before the rest of the batch is decoded.
 */
export function planWork(
  segments: readonly TranslateSegment[],
  config: PlanConfig = DEFAULT_PLAN_CONFIG,
  eagerFirst = false,
): WorkItem[] {
  if (!eagerFirst) return planSegments(segments, config);

  const index = segments.findIndex((segment) => isBatchable(segment, config));
  const first = index >= 0 ? segments[index] : undefined;
  if (!first) return planSegments(segments, config);

  return [
    ...planSegments(segments.slice(0, index), config),
    { kind: 'single', segment: first },
    ...planSegments(segments.slice(index + 1), config),
  ];
}
