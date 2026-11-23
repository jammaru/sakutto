import type { CaptionTranslateOptions } from './engine';

/**
 * Caption-only incremental translator for rolling auto-generated captions.
 *
 * YouTube ASR repaints the whole visible window as words arrive. Translating every window
 * as an isolated sentence re-decodes the same prefix, and cancelling on each change leaves
 * only the newest tail on screen. This class keeps the deltas instead: each new word run is
 * queued once, translated with the already committed prefix as context, and appended in
 * original order. Earlier coverage is never re-sent, so a late result cannot drop or
 * duplicate a clause.
 */
export interface AsrStreamCallbacks {
  /** Word-delimited target languages need a separator between incremental clauses. */
  spaceDelimited(): boolean;
  now(): number;
  playheadMs(): number;
  translate(delta: string, context: string | undefined, sequence: number): Promise<string | null>;
  cancel(delta: string, context: string | undefined, sequence: number): void;
  onLine(source: string, translation: string, sequence: number): void;
}

interface PendingDelta {
  sequence: number;
  text: string;
  context: string | undefined;
  staleAfterMediaMs: number;
}

/** Speech older than this is no longer worth translating (matches the overlay hold cap). */
export const ASR_DELTA_MAX_LAG_MS = 2_000;
/** Scripts that join incremental clauses without an ASCII space. */
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export class AsrChunkStream {
  private readonly callbacks: AsrStreamCallbacks;
  private readonly maxLagMs: number;
  private rawWindow = '';
  private lastQueued = '';
  private readonly pending: PendingDelta[] = [];
  private readonly bySequence = new Map<number, PendingDelta>();
  private readonly results = new Map<number, string>();
  private readonly inFlight = new Set<number>();
  private sourceParts: string[] = [];
  private translationParts: string[] = [];
  private nextSequence = 0;
  private nextCommit = 0;
  private generation = 0;

  constructor(callbacks: AsrStreamCallbacks, maxLagMs = ASR_DELTA_MAX_LAG_MS) {
    this.callbacks = callbacks;
    this.maxLagMs = maxLagMs;
  }

  /** Feed a new (already cleaned) native window. Returns true when a new delta was queued. */
  observe(visible: string): boolean {
    const text = visible.trim();
    if (text.length === 0) {
      this.reset();
      return false;
    }
    const { delta, continued } = rollingCaptionDelta(this.rawWindow, text);
    this.rawWindow = text;
    if (delta.length === 0) return false;
    if (!continued) this.resetCoverage();
    if (delta === this.lastQueued) return false;
    this.lastQueued = delta;
    const sequence = this.nextSequence++;
    this.pending.push({
      sequence,
      text: delta,
      context: this.coverage() || undefined,
      staleAfterMediaMs: this.callbacks.playheadMs() + this.maxLagMs,
    });
    this.pump();
    return true;
  }

  /** Drop work whose speech is already past the playhead; keep committed coverage intact. */
  tick(playheadMs: number): void {
    for (const item of [...this.pending]) {
      if (item.staleAfterMediaMs >= playheadMs) continue;
      this.pending.splice(this.pending.indexOf(item), 1);
      this.results.set(item.sequence, '');
    }
    for (const sequence of [...this.inFlight]) {
      const item = this.bySequence.get(sequence);
      if (!item || item.staleAfterMediaMs >= playheadMs) continue;
      this.callbacks.cancel(item.text, item.context, sequence);
      this.inFlight.delete(sequence);
      this.results.set(sequence, '');
    }
    this.commitReady();
    this.pump();
  }

  /** Abort everything and forget the window: seek, caption gap or source change. */
  reset(): void {
    this.resetCoverage();
    this.rawWindow = '';
  }

  private coverage(): string {
    return this.sourceParts.join('');
  }

  /** CJK-target output needs no separator; word languages keep one between clauses. */
  private joinedTranslation(): string {
    let line = '';
    // Read the target script at join time: a target change can outlive this stream.
    const spaceDelimited = this.callbacks.spaceDelimited();
    for (const part of this.translationParts) {
      if (line.length === 0 || /^[,.;:!?。、！？…]/u.test(part)) {
        line += part;
      } else {
        // CJK targets join clauses directly, but a result that is not in a CJK script
        // (a failed delta showing its source, or an engine echoing it) needs a boundary.
        const needsSpace = spaceDelimited || !CJK_SCRIPT.test(part);
        line += needsSpace ? ` ${part}` : part;
      }
    }
    return line;
  }

  /**
   * Forget the current sentence and retire all of its work. A new sentence must never
   * reuse a sequence that is still in flight: the stale result would be committed as the
   * new line and the fresh result would be orphaned. Sequences only ever increase, so
   * jumping `nextCommit` past the retired ones keeps late callbacks harmless.
   */
  private resetCoverage(): void {
    this.generation += 1;
    for (const sequence of this.inFlight) {
      const item = this.bySequence.get(sequence);
      if (item) this.callbacks.cancel(item.text, item.context, sequence);
    }
    this.inFlight.clear();
    // Pending deltas were never dispatched, so dropping them is enough; only dispatched
    // work needs an engine cancel.
    this.pending.length = 0;
    this.bySequence.clear();
    this.results.clear();
    this.nextCommit = this.nextSequence;
    this.sourceParts = [];
    this.translationParts = [];
    this.lastQueued = '';
  }

  /** One request at a time: decode cost must not grow with superseded windows. */
  private pump(): void {
    while (this.inFlight.size === 0 && this.pending.length > 0) {
      const item = this.pending.shift();
      if (!item) return;
      this.bySequence.set(item.sequence, item);
      this.inFlight.add(item.sequence);
      const generation = this.generation;
      void this.callbacks.translate(item.text, item.context, item.sequence).then((translation) => {
        if (generation !== this.generation) return;
        this.inFlight.delete(item.sequence);
        // A failed delta still has to advance the sequence; show its source rather
        // than leave a hole in the line or wait behind work for later speech.
        this.results.set(item.sequence, translation || item.text);
        this.commitReady();
        this.pump();
      });
    }
  }

  private commitReady(): void {
    while (this.results.has(this.nextCommit)) {
      const sequence = this.nextCommit;
      const translation = this.results.get(sequence) ?? '';
      const item = this.bySequence.get(sequence);
      this.results.delete(sequence);
      this.bySequence.delete(sequence);
      this.nextCommit += 1;
      if (!item || translation.length === 0) continue;
      this.sourceParts.push(item.text);
      this.translationParts.push(translation);
      this.callbacks.onLine(this.coverage(), this.joinedTranslation(), sequence);
    }
  }
}

interface RollingDelta {
  delta: string;
  continued: boolean;
}

/**
 * Return only the newly spoken part of next. A window that drops its leading words is
 * joined on the longest whole-word overlap, so the remaining tail is a delta, not a new
 * isolated sentence. An unrelated window starts a new sentence (continued: false).
 */
export function rollingCaptionDelta(previous: string, next: string): RollingDelta {
  if (previous.length === 0) return { delta: next, continued: false };
  if (next === previous || previous.startsWith(next)) return { delta: '', continued: true };
  if (next.startsWith(previous)) return { delta: next.slice(previous.length), continued: true };
  const max = Math.min(previous.length, next.length);
  for (let length = max; length >= 1; length -= 1) {
    const overlap = previous.slice(previous.length - length);
    if (!next.startsWith(overlap)) continue;
    const before = previous[previous.length - length - 1] ?? '';
    const after = next[length] ?? '';
    if (wholeWordEdge(before, after)) return { delta: next.slice(length), continued: true };
  }
  return { delta: next, continued: false };
}

function wholeWordEdge(before: string, after: string): boolean {
  const edge = /[\s,.;:!?()[\]'"\u3000\u3001\u3002\uff0c\uff0e\uff01\uff1f]/u;
  return before.length === 0 || after.length === 0 || edge.test(before) || edge.test(after);
}

/** Translation options for one incremental delta, keeping the prefix as light context. */
export function asrDeltaOptions(
  options: CaptionTranslateOptions,
  context: string | undefined,
): CaptionTranslateOptions {
  if (!context) return { ...options };
  return { ...options, context };
}
