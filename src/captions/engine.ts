import type { PageEngine } from '@/dom/session';
import { isBrokenTranslation } from '@/engine/text/degenerate';
import { hasTranslatableText, isInvisibleRunawayOutput } from '@/engine/text/sanitize';
import type { Formality, GlossaryEntry, TranslationChunk } from '@/engine/types';
import { cuesInWindow, type CaptionCue } from './cues';
import { cleanCaptionSource, cleanCaptionText } from './text-cleanup';

/** Current playhead cue: ahead of other caption work, still after a selection (0). */
export const CAPTION_PLAYHEAD_PRIORITY = 1;
/** Next 1–2 cues after the playhead, before visible page prose (~10). */
export const CAPTION_LIVE_PRIORITY = 2;
/** After nearby page prose (~22), before far chrome (~34). */
export const CAPTION_PREFETCH_PRIORITY = 24;
/**
 * Far prefetch is a nudge, not a transcript download. Capping the window stops a
 * long cue list from filling the engine queue ahead of page work; nearby cues are
 * requested separately at {@link CAPTION_LIVE_PRIORITY}.
 */
export const CAPTION_PREFETCH_MAX_CUES = 8;

export function captionPrefetchWindowMs(
  tier: 'g' | 'c8' | 'c4' | 'c1' | null,
  playbackRate = 1,
): number {
  const base = tier === 'g' ? 36_000 : tier === 'c8' ? 16_000 : 8_000;
  return Math.round(base * Math.min(3, Math.max(1, playbackRate)));
}

export interface CaptionTranslateOptions {
  tgt: string;
  form: Formality;
  glossary?: readonly GlossaryEntry[] | undefined;
  src?: string | undefined;
  /** Previous committed source line, so a tail fragment keeps its sentence context. */
  context?: string | undefined;
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
  private readonly inflightPriorities = new Map<string, number>();
  private readonly controllers = new Map<string, AbortController>();
  private seekGeneration = 0;

  constructor(private readonly engine: PageEngine) {}

  cacheKey(text: string, options: CaptionTranslateOptions): string {
    return JSON.stringify([
      options.tgt,
      options.form,
      options.src ?? '',
      cleanCaptionText(options.context ?? ''),
      cleanCaptionText(text),
    ]);
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
    this.inflightPriorities.clear();
  }

  /** Snapshot before `translateCue`; {@link abortedSince} is true after `seek` / `clear`. */
  translateGeneration(): number {
    return this.seekGeneration;
  }

  abortedSince(generation: number): boolean {
    return generation !== this.seekGeneration;
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
    if (pending) {
      const pendingPriority = this.inflightPriorities.get(key);
      if (pendingPriority === undefined || priority >= pendingPriority) return pending;

      // A warmer's engine options cannot be upgraded in place; restart it so the
      // playhead request gets eager/preempt behavior. Its aborted run cannot cache.
      this.controllers.get(key)?.abort();
      this.controllers.delete(key);
      this.inflight.delete(key);
      this.inflightPriorities.delete(key);
    }

    const controller = new AbortController();
    this.controllers.set(key, controller);
    const generation = this.seekGeneration;
    const work = this.run(cue, options, priority, controller.signal).finally(() => {
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
      if (this.inflight.get(key) === work) {
        this.inflight.delete(key);
        this.inflightPriorities.delete(key);
      }
    });
    this.inflight.set(key, work);
    this.inflightPriorities.set(key, priority);
    const result = await work;
    if (generation !== this.seekGeneration) return null;
    return result;
  }

  /** Drop every in-flight job except `text` so live/DOM never builds a backlog. */
  keepOnly(text: string, options: CaptionTranslateOptions): void {
    this.retainTexts([text], options);
  }

  /**
   * Keep the current line plus the cues that are about to be shown, and abort the
   * rest. A natural line change should not leave the previous line occupying an
   * engine slot while the new playhead line waits behind it.
   */
  retainTexts(texts: readonly string[], options: CaptionTranslateOptions): void {
    const keep = new Set(texts.map((text) => this.cacheKey(text, options)));
    for (const [key, controller] of [...this.controllers.entries()]) {
      if (keep.has(key)) continue;
      controller.abort();
      this.controllers.delete(key);
      this.inflight.delete(key);
      this.inflightPriorities.delete(key);
    }
  }

  /** Abort one line without touching prefetched neighbours. */
  cancelText(text: string, options: CaptionTranslateOptions): void {
    const key = this.cacheKey(text, options);
    const controller = this.controllers.get(key);
    if (!controller) return;
    controller.abort();
    this.controllers.delete(key);
    this.inflight.delete(key);
    this.inflightPriorities.delete(key);
  }

  prefetch(
    cues: readonly CaptionCue[],
    timeMs: number,
    options: CaptionTranslateOptions,
    tier: 'g' | 'c8' | 'c4' | 'c1' | null,
    playbackRate = 1,
    skipIds: ReadonlySet<string> = new Set(),
    maxCues = CAPTION_PREFETCH_MAX_CUES,
  ): void {
    const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
    const windowMs = captionPrefetchWindowMs(tier, rate);
    const upcoming = cuesInWindow(cues, timeMs, timeMs + windowMs).slice(
      0,
      Math.max(0, Math.floor(maxCues)),
    );
    for (const cue of upcoming) {
      if (skipIds.has(cue.id)) continue;
      if (this.getCached(cue.text, options) !== undefined) continue;
      if (this.inflight.has(this.cacheKey(cue.text, options))) continue;
      void this.translateCue(cue, options, CAPTION_PREFETCH_PRIORITY);
    }
  }

  private async run(
    cue: CaptionCue,
    options: CaptionTranslateOptions,
    priority: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    // Caption-only cleanup: markers, stutters and sound tags never enter a prompt.
    // A pure tag returns an empty source and is dropped without a model call.
    const source = cleanCaptionSource(cue.text);
    if (signal.aborted || source.length === 0 || !hasTranslatableText(source)) return null;
    let output = '';
    let failed = false;
    try {
      for await (const chunk of this.engine.translate([{ id: cue.id, text: source }], {
        tgt: options.tgt,
        form: options.form,
        glossary: options.glossary,
        src: options.src ?? cue.language,
        ...(options.context ? { context: cleanCaptionText(options.context) } : {}),
        priority,
        signal,
        eager: priority <= CAPTION_LIVE_PRIORITY,
        preempt: priority <= CAPTION_PLAYHEAD_PRIORITY,
      })) {
        const next = applyChunk(output, chunk);
        output = next.text;
        if (next.error) failed = true;
      }
    } catch {
      return null;
    }
    // Safety net for engines that echo structural tokens or tags in their output.
    const translated = cleanCaptionText(output).trim();
    if (failed || translated.length === 0) return null;
    if (isBrokenTranslation(source, translated) || isInvisibleRunawayOutput(source, translated)) {
      return null;
    }
    if (signal.aborted) return null;
    this.cache.set(this.cacheKey(source, options), { translation: translated });
    return translated;
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
