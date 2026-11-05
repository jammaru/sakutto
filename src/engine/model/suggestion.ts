import type { ComputeTier } from '../in-browser/backend';

/**
 * Native CPU measurements put 2B at about 3.5× the 0.8B paragraph.
 * WebGPU has not been measured, so the suggestion stays on this conservative ratio.
 */
export const HIGH_QUALITY_SLOWDOWN = 3.5;

/** G-tier budget for one 77-word paragraph. The predicted 2B time must fit inside it. */
export const HIGH_QUALITY_PARAGRAPH_MS = 1500;

const MIN_DEVICE_MEMORY_GB = 8;
const MIN_FREE_BYTES = 2_500_000_000;

/** C4's paragraph budget is 7.5s. Twice that is the point where the built-in translator is worth mentioning. */
export const SLOW_PARAGRAPH_MS = 15_000;

export const QUALITY_PARAGRAPH =
  'The morning train leaves the quiet station while the baker opens a small shop on the corner of the square where children walk to school with bright bags and the river carries fallen leaves toward the wide sea beyond the old stone bridge near the market that opens early for neighbors who buy bread fruit and flowers before work begins across the town today after the rain has washed the dusty road clean again for everyone here.';

export interface HighQualityInput {
  tier: ComputeTier | null;
  paragraphMs: number | null;
  deviceMemoryGb: number | null;
  freeStorageBytes: number | null;
  maxBufferSize: number | null;
  modelBytes: number;
  dismissed: boolean;
  usingHighQuality: boolean;
}

export function shouldSuggestHighQuality(input: HighQualityInput): boolean {
  if (input.dismissed || input.usingHighQuality) return false;
  if (input.tier !== 'g') return false;
  if (input.paragraphMs === null || !Number.isFinite(input.paragraphMs)) return false;
  if (input.paragraphMs * HIGH_QUALITY_SLOWDOWN > HIGH_QUALITY_PARAGRAPH_MS) return false;
  if (input.deviceMemoryGb === null || input.deviceMemoryGb < MIN_DEVICE_MEMORY_GB) return false;
  if (input.freeStorageBytes === null || input.freeStorageBytes < MIN_FREE_BYTES) return false;
  // The weights have to fit in one GPU buffer.
  if (input.maxBufferSize === null || input.maxBufferSize < input.modelBytes) return false;
  return true;
}

export function shouldHintBuiltInFallback(
  tier: ComputeTier | null,
  paragraphMs: number | null,
): boolean {
  return tier === 'c4' && paragraphMs !== null && paragraphMs > SLOW_PARAGRAPH_MS;
}
