import type { ModelStatus } from './engine-status';

/**
 * Displayed bytes only move forward. A resumed prefix is hashed before the transfer continues,
 * so those bytes belong to the resume position rather than a second pass that starts at zero.
 * The final digest keeps the byte count it already reached, and loading/having the file on
 * disk keep the full count. A download that restarts from an empty file may begin again.
 */
export function advanceModelStatus(previous: ModelStatus | null, next: ModelStatus): ModelStatus {
  if (!previous || previous.id !== next.id) return next;
  if (next.state === 'absent' || next.state === 'error' || next.state === 'partial') return next;
  if (next.state === 'downloading' && next.received === 0 && previous.received > 0) return next;

  const total = next.total > 0 ? next.total : previous.total;
  if (previous.state === 'verifying' && next.state === 'downloading' && next.received > 0) {
    // The file is still the one being checked. Do not flip back to the transfer label while
    // its bytes move forward; a restart from zero is handled above.
    const received = Math.max(previous.received, Math.min(next.received, total));
    return {
      ...next,
      state: 'verifying',
      received,
      total,
      progress: total > 0 ? Math.min(1, received / total) : next.progress,
    };
  }
  if (next.state === 'verifying') {
    const requested = total > 0 ? Math.min(next.received, total) : next.received;
    const received = Math.max(previous.received, requested);
    return {
      ...next,
      received,
      total,
      progress: total > 0 ? Math.min(1, received / total) : next.progress,
    };
  }
  if (next.state === 'loading' || next.state === 'ready' || next.state === 'loaded') {
    const received = Math.max(previous.received, total);
    return { ...next, received, total, progress: 1 };
  }

  const received = Math.max(previous.received, next.received);
  const progress =
    total > 0 ? Math.max(previous.progress, Math.min(1, received / total)) : previous.progress;
  return { ...next, received, total, progress };
}
