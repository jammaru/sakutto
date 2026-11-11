import { describe, expect, it } from 'vitest';
import { isBrokenTranslation } from '@/engine/text/degenerate';
import type { PageEngine } from '@/dom/session';
import type { TranslateOptions, TranslateSegment, TranslationChunk } from '@/engine/types';
import {
  CAPTION_LIVE_PRIORITY,
  CaptionTranslator,
  captionPrefetchWindowMs,
} from '@/captions/engine';
import type { CaptionCue } from '@/captions/cues';

function cue(text: string, startMs = 0): CaptionCue {
  return { id: text, startMs, endMs: startMs + 2000, text };
}

function engineOf(
  handler: (
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ) => AsyncIterable<TranslationChunk> | TranslationChunk[],
): PageEngine {
  return {
    async *translate(segments, options) {
      const result = handler(segments, options);
      if (Symbol.asyncIterator in result) {
        yield* result;
        return;
      }
      for (const chunk of result) yield chunk;
    },
  };
}

describe('caption translator', () => {
  it('caches a finished line and skips a second request', async () => {
    let calls = 0;
    const translator = new CaptionTranslator(
      engineOf((segments) => {
        calls += 1;
        return segments.map((segment) => ({
          id: segment.id,
          final: `訳:${segment.text}`,
          engine: 'plamo' as const,
        }));
      }),
    );
    const options = { tgt: 'ja', form: 'polite' as const };
    const first = await translator.translateCue(cue('The station opens at dawn.'), options, 2);
    const second = await translator.translateCue(cue('The station opens at dawn.'), options, 2);
    expect(first).toBe('訳:The station opens at dawn.');
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it('returns null for degenerate output so the overlay can keep the original', async () => {
    const collapsed = 'あ'.repeat(200);
    expect(isBrokenTranslation('The station opens at dawn.', collapsed)).toBe(true);
    const translator = new CaptionTranslator(
      engineOf((segments) =>
        segments.map((segment) => ({
          id: segment.id,
          final: collapsed,
          engine: 'plamo' as const,
        })),
      ),
    );
    const result = await translator.translateCue(
      cue('The station opens at dawn.'),
      { tgt: 'ja', form: 'polite' },
      CAPTION_LIVE_PRIORITY,
    );
    expect(result).toBeNull();
    expect(
      translator.getCached('The station opens at dawn.', { tgt: 'ja', form: 'polite' }),
    ).toBeUndefined();
  });

  it('returns null when the engine marks the chunk as an error', async () => {
    const translator = new CaptionTranslator(
      engineOf((segments) =>
        segments.map((segment) => ({
          id: segment.id,
          final: segment.text,
          error: true,
          engine: 'plamo' as const,
        })),
      ),
    );
    await expect(
      translator.translateCue(cue('Tickets please.'), { tgt: 'ja', form: 'polite' }, 2),
    ).resolves.toBeNull();
  });

  it('aborts in-flight work on seek', async () => {
    const translator = new CaptionTranslator(
      engineOf(async function* (segments, options) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 50);
          options.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
        yield { id: segments[0]?.id ?? 'x', final: 'too late', engine: 'plamo' as const };
      }),
    );
    const pending = translator.translateCue(
      cue('A red train waits.'),
      { tgt: 'ja', form: 'polite' },
      2,
    );
    translator.seek();
    await expect(pending).resolves.toBeNull();
  });

  it('prefetches a longer window on the GPU tier than on CPU', () => {
    expect(captionPrefetchWindowMs('g')).toBeGreaterThan(captionPrefetchWindowMs('c4'));
    expect(captionPrefetchWindowMs('c8')).toBeGreaterThan(captionPrefetchWindowMs(null));
    expect(captionPrefetchWindowMs('g', 2)).toBeGreaterThan(captionPrefetchWindowMs('g', 1));
  });

  it('drops stale live jobs so only the newest line is in flight', async () => {
    let started = 0;
    let finished = 0;
    const translator = new CaptionTranslator(
      engineOf(async function* (segments, options) {
        started += 1;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 40);
          options.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
        finished += 1;
        yield {
          id: segments[0]?.id ?? 'x',
          final: `訳:${segments[0]?.text}`,
          engine: 'plamo' as const,
        };
      }),
    );
    const options = { tgt: 'ja', form: 'polite' as const };
    const first = translator.translateCue(cue('The station opens at dawn.'), options, 2);
    translator.keepOnly('A red train waits.', options);
    const second = translator.translateCue(cue('A red train waits.'), options, 2);
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBe('訳:A red train waits.');
    expect(finished).toBe(1);
    expect(started).toBeGreaterThanOrEqual(2);
  });

  it('asks live caption jobs to preempt a page batch', async () => {
    let seenPriority: number | undefined;
    let seenPreempt: boolean | undefined;
    let seenEager: boolean | undefined;
    const translator = new CaptionTranslator(
      engineOf((segments, options) => {
        seenPriority = options.priority;
        seenPreempt = options.preempt;
        seenEager = options.eager;
        return segments.map((segment) => ({
          id: segment.id,
          final: `訳:${segment.text}`,
          engine: 'plamo' as const,
        }));
      }),
    );
    await translator.translateCue(
      cue('The station opens at dawn.'),
      { tgt: 'ja', form: 'polite' },
      CAPTION_LIVE_PRIORITY,
    );
    expect(seenPriority).toBe(CAPTION_LIVE_PRIORITY);
    expect(seenPreempt).toBe(true);
    expect(seenEager).toBe(true);
  });
});
