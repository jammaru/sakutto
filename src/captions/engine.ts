import type { PageEngine } from '@/dom/session';
import { isBrokenTranslation } from '@/engine/text/degenerate';
import type { Formality, GlossaryEntry, TranslationChunk } from '@/engine/types';
import { cuesInWindow, type CaptionCue } from './cues';

/** After a selection (0), before visible page prose (~10). */
export const CAPTION_LIVE_PRIORITY = 2;
/** After nearby page prose (~22), before far chrome (~34). */
export const CAPTION_PREFETCH_PRIORITY = 24;

export function captionPrefetchWindowMs(
  tier: 'g' | 'c8' | 'c4' | 'c1' | null,
  playbackRate = 1,
): number {
  const base = tier === 'g' ? 36_000 : tier === 'c8' ? 16_000 : 8_000;
  return Math.round(base * Math.min(3, Math.max(1, playbackRate)));
}

const NEAR_PLAYHEAD_MS = 8_000;

export interface CaptionTranslateOptions {
  tgt: string;
  form: Formality;
  glossary?: readonly GlossaryEntry[] | undefined;
  src?: string | undefined;
}

interface CacheEntry {
  translation: string;
}

/**
 * Translates caption lines through the shared page engine. Failed or degenerate output
 * is not cached and the caller shows the original cue instead.
 */
export class CaptionTranslator {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly controllers = new Map<string, AbortController>();
  private seekGeneration = 0;

  constructor(private readonly engine: PageEngine) {}

  cacheKey(text: string, options: CaptionTranslateOptions): string {
    return `${options.tgt}|${options.form}|${options.src ?? ''}|${text}`;
  }

  getCached(text: string, options: CaptionTranslateOptions): string | undefined {
    return this.cache.get(this.cacheKey(text, options))?.translation;
  }

  hasInflight(text: string, options: CaptionTranslateOptions): boolean {
    return this.inflight.has(this.cacheKey(text, options));
  }

  clear(): void {
    this.seek();
    this.cache.clear();
  }

  seek(): void {
    this.seekGeneration += 1;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.inflight.clear();
  }

  async translateCue(
    cue: CaptionCue,
    options: CaptionTranslateOptions,
    priority: number,
  ): Promise<string | null> {
    const key = this.cacheKey(cue.text, options);
    const cached = this.cache.get(key);
    if (cached) return cached.translation;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const controller = new AbortController();
    this.controllers.set(key, controller);
    const generation = this.seekGeneration;
    const work = this.run(cue, options, priority, controller.signal).finally(() => {
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
      if (this.inflight.get(key) === work) this.inflight.delete(key);
    });
    this.inflight.set(key, work);
    const result = await work;
    if (generation !== this.seekGeneration) return result;
    return result;
  }

  /** Drop every in-flight job except `text` so live/DOM never builds a backlog. */
  keepOnly(text: string, options: CaptionTranslateOptions): void {
    const keep = this.cacheKey(text, options);
    for (const [key, controller] of [...this.controllers.entries()]) {
      if (key === keep) continue;
      controller.abort();
      this.controllers.delete(key);
      this.inflight.delete(key);
    }
  }

  prefetch(
    cues: readonly CaptionCue[],
    timeMs: number,
    options: CaptionTranslateOptions,
    tier: 'g' | 'c8' | 'c4' | 'c1' | null,
    playbackRate = 1,
  ): void {
    const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
    const windowMs = captionPrefetchWindowMs(tier, rate);
    const upcoming = cuesInWindow(cues, timeMs, timeMs + windowMs);
    const nearMs = timeMs + NEAR_PLAYHEAD_MS * Math.min(3, Math.max(1, rate));
    for (const cue of upcoming) {
      if (this.getCached(cue.text, options) !== undefined) continue;
      if (this.inflight.has(this.cacheKey(cue.text, options))) continue;
      const priority = cue.startMs <= nearMs ? CAPTION_LIVE_PRIORITY : CAPTION_PREFETCH_PRIORITY;
      void this.translateCue(cue, options, priority);
    }
  }

  private async run(
    cue: CaptionCue,
    options: CaptionTranslateOptions,
    priority: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (signal.aborted || cue.text.trim().length === 0) return null;
    let output = '';
    let failed = false;
    try {
      for await (const chunk of this.engine.translate([{ id: cue.id, text: cue.text }], {
        tgt: options.tgt,
        form: options.form,
        glossary: options.glossary,
        src: options.src ?? cue.language,
        priority,
        signal,
        eager: priority <= CAPTION_LIVE_PRIORITY,
        preempt: priority <= CAPTION_LIVE_PRIORITY,
      })) {
        const next = applyChunk(output, chunk);
        output = next.text;
        if (next.error) failed = true;
      }
    } catch {
      return null;
    }
    if (failed || output.trim().length === 0) return null;
    if (isBrokenTranslation(cue.text, output)) return null;
    this.cache.set(this.cacheKey(cue.text, options), { translation: output });
    return output;
  }
}

function applyChunk(current: string, chunk: TranslationChunk): { text: string; error: boolean } {
  if (chunk.textDelta !== undefined) {
    return {
      text: chunk.restart === true ? chunk.textDelta : current + chunk.textDelta,
      error: false,
    };
  }
  return { text: chunk.final, error: chunk.error === true };
}
