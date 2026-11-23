import type { CaptionCue } from './cues';

export const VOD_MIN_DISPLAY_MS = 1_200;
export const VOD_SILENCE_HOLD_MS = 2_000;

export interface VodDisplayValue {
  original: string;
  translation: string;
}

export interface VodDisplayPaint extends VodDisplayValue {
  cue: CaptionCue;
  pending: boolean;
}

export type VodDisplayCommand =
  { type: 'show'; paint: VodDisplayPaint } | { type: 'clear'; cueId: string };

interface ActiveDisplay {
  cue: CaptionCue;
  value: VodDisplayValue;
  pending: boolean;
  shownAt: number;
}

/**
 * Ordered cue-start presentation for an immutable VOD timeline. Natural cue ends
 * never skip a started cue; a translated cue owns at least 1.2 seconds of wall time.
 */
export class VodDisplayScheduler {
  private cues: readonly CaptionCue[] = [];
  private nextIndex = 0;
  private queue: CaptionCue[] = [];
  private active: ActiveDisplay | null = null;
  private generationValue = 0;

  get generation(): number {
    return this.generationValue;
  }

  get queuedCueIds(): string[] {
    return this.queue.map((cue) => cue.id);
  }

  reset(cues: readonly CaptionCue[], timeMs = 0): void {
    this.cues = cues;
    this.queue = [];
    this.active = null;
    this.generationValue += 1;
    this.seek(timeMs);
  }

  /** Intentional seeks flush due work; user-skipped cues are not continuous-play drops. */
  seek(timeMs: number): void {
    this.queue = [];
    this.active = null;
    this.generationValue += 1;
    const index = this.cues.findIndex((cue) => cue.endMs > timeMs || cue.startMs >= timeMs);
    this.nextIndex = index < 0 ? this.cues.length : index;
  }

  update(
    timeMs: number,
    nowMs: number,
    read: (cue: CaptionCue) => VodDisplayValue | null,
    paused = false,
  ): VodDisplayCommand | null {
    if (!paused) {
      while (this.nextIndex < this.cues.length) {
        const cue = this.cues[this.nextIndex];
        if (!cue || cue.startMs > timeMs) break;
        this.queue.push(cue);
        this.nextIndex += 1;
      }
    }

    let clearedActiveId: string | null = null;
    if (this.active?.pending) {
      const value = read(this.active.cue);
      if (!value) {
        // A terminal translation failure must not pin the original or block later dialogue.
        clearedActiveId = this.active.cue.id;
        this.active = null;
      } else if (value.translation) {
        this.active = {
          cue: this.active.cue,
          value,
          pending: false,
          shownAt: nowMs,
        };
        return this.show(this.active);
      }
    }

    if (this.active && !this.active.pending) {
      const elapsed = Math.max(0, nowMs - this.active.shownAt);
      // Date.now() and mutation observers can use clocks with sub-millisecond
      // rounding differences. One guard millisecond prevents a measured 1199.9ms flash.
      if (elapsed < VOD_MIN_DISPLAY_MS + 1) return null;
      if (this.queue.length === 0) {
        if (timeMs > this.active.cue.endMs + VOD_SILENCE_HOLD_MS) {
          const cueId = this.active.cue.id;
          this.active = null;
          return { type: 'clear', cueId };
        }
        return null;
      }
      clearedActiveId = this.active.cue.id;
      this.active = null;
    }

    // A pending original does not have a JA dwell yet, but it still owns the FIFO
    // until its translation arrives. Later translated cues cannot overtake it.
    if (this.active) return null;
    while (this.queue.length > 0) {
      const cue = this.queue.shift();
      if (!cue) continue;
      const value = read(cue);
      // Sound-only and otherwise undisplayable cues are intentional FIFO skips.
      if (!value) continue;
      const pending = value.translation.length === 0;
      this.active = { cue, value, pending, shownAt: nowMs };
      return this.show(this.active);
    }
    return clearedActiveId ? { type: 'clear', cueId: clearedActiveId } : null;
  }

  private show(active: ActiveDisplay): VodDisplayCommand {
    return {
      type: 'show',
      paint: {
        cue: active.cue,
        original: active.value.original,
        translation: active.value.translation,
        pending: active.pending,
      },
    };
  }
}
