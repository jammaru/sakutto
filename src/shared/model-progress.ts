import type { ModelStatus } from './engine-status';

/**
 * Download bytes only move forward. Verification has its own hashed/total progress: it must
 * not stay pinned at 100% while a multi-GB file is still being read. Loading and having the
 * file on disk keep the full byte count. A download that restarts from an empty file is
 * allowed to begin again.
 */
export function advanceModelStatus(previous: ModelStatus | null, next: ModelStatus): ModelStatus {
  if (!previous || previous.id !== next.id) return next;
  if (next.state === 'absent' || next.state === 'error' || next.state === 'partial') return next;
  if (next.state === 'downloading' && next.received === 0 && previous.received > 0) return next;

  const total = next.total > 0 ? next.total : previous.total;
  if (next.state === 'verifying') {
    const received = total > 0 ? Math.min(next.received, total) : next.received;
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
