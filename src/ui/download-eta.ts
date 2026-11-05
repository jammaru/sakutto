export interface ByteMark {
  at: number;
  received: number;
}

const MIN_WINDOW_MS = 1_500;
const MIN_BYTES = 256 * 1024;
const MAX_WINDOW_MS = 20_000;
const MAX_REMAINING_MS = 6 * 60 * 60 * 1000;

/** Keeps the recent transfer so a stall does not freeze an old rate. */
export function trimDownloadMarks(marks: readonly ByteMark[], now: number): ByteMark[] {
  const recent = marks.filter((mark) => now - mark.at <= MAX_WINDOW_MS && mark.at <= now);
  if (recent.length > 0) return recent;
  const last = marks[marks.length - 1];
  return last ? [last] : [];
}

/**
 * Remaining transfer time from the recent byte rate.
 * Returns null until the window has enough time and bytes to be stable.
 */
export function estimateRemainingMs(
  marks: readonly ByteMark[],
  total: number,
  now: number,
): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const window = trimDownloadMarks(marks, now);
  const first = window[0];
  const last = window[window.length - 1];
  if (!first || !last) return null;

  const elapsed = last.at - first.at;
  const gained = last.received - first.received;
  if (elapsed < MIN_WINDOW_MS || gained < MIN_BYTES) return null;

  const remaining = total - last.received;
  if (remaining <= 0) return 0;

  const ms = remaining / (gained / elapsed);
  if (!Number.isFinite(ms) || ms > MAX_REMAINING_MS) return null;
  return Math.round(ms);
}
