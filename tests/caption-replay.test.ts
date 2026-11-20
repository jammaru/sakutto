import { describe, expect, it } from 'vitest';
import {
  CAPTION_REPLAY_LATENCIES_MS,
  CAPTION_REPLAY_MIN_DWELL_MS,
  replayCaptionTrace,
  validateCaptionTrace,
  type CaptionTrace,
} from '@/captions/trace';
import {
  REPLAY_ORIGINAL_ROWS,
  replayOriginalGeometry,
  wrapReplayCaptionText,
} from '@/captions/replay-geometry';
import enFixture from './fixtures/caption-traces/en-asr.json';
import jaFixture from './fixtures/caption-traces/ja-asr.json';
import enRollupFixture from './fixtures/caption-traces/en-rollup.json';
import jaRollupFixture from './fixtures/caption-traces/ja-rollup.json';

const fixtures: Array<[string, CaptionTrace, boolean]> = [
  ['EN → JA', validateCaptionTrace(enFixture), false],
  ['JA → EN', validateCaptionTrace(jaFixture), false],
  ['EN → JA wrapped roll-up', validateCaptionTrace(enRollupFixture), true],
  ['JA → EN wrapped roll-up', validateCaptionTrace(jaRollupFixture), true],
];

describe.each(fixtures)('%s offline ASR replay', (_name, trace, expectsRollUp) => {
  it.each(CAPTION_REPLAY_LATENCIES_MS)(
    'keeps translated live captions stable at %i ms latency',
    { timeout: 15_000 },
    async (latencyMs) => {
      const result = await replayCaptionTrace(trace, { latencyMs });
      const { metrics } = result;

      // Do not let an empty replay satisfy the continuity assertions vacuously.
      expect(result.frames.length).toBeGreaterThan(50);
      expect(result.frames.some((frame) => frame.active && frame.translation)).toBe(true);
      expect(metrics.translationInputLengths.length).toBeGreaterThan(0);
      expect(metrics.heightChangeCount).toBe(0);
      expect(metrics.widthChangeCount).toBe(0);
      expect(metrics.originalHorizontalShiftCount).toBe(0);
      expect(metrics.clippedOriginalCharCount).toBe(0);
      expect(metrics.maxClippedOriginalCharCount).toBe(0);
      expect(metrics.originalRollUpCount > 0).toBe(expectsRollUp);
      expect(Math.max(...result.frames.map((frame) => frame.originalLineCount))).toBeGreaterThan(
        expectsRollUp ? REPLAY_ORIGINAL_ROWS : 0,
      );
      expect(metrics.committedSentenceCount).toBeGreaterThan(0);
      expect(metrics.committedSentenceRewriteCount).toBe(0);
      expect(metrics.maxTranslationsPerCommittedSentence).toBeLessThanOrEqual(1);
      expect(metrics.completedTranslationFrameCount).toBeGreaterThan(0);
      expect(metrics.translationOriginalMappingCount).toBe(metrics.completedTranslationFrameCount);
      expect(metrics.translationOriginalMismatchCount).toBe(0);
      expect(metrics.blankTranslationFramesAfterFirst).toBe(0);
      expect(metrics.minTranslationDwellMs).not.toBeNull();
      expect(metrics.minTranslationDwellMs ?? 0).toBeGreaterThanOrEqual(
        CAPTION_REPLAY_MIN_DWELL_MS,
      );
      expect(metrics.cancellationCount).toBeGreaterThanOrEqual(0);
    },
  );
});

describe('wrapped replay geometry', () => {
  it.each([
    'one unbroken english token that must wrap instead of scrolling horizontally '.repeat(4),
    '日本語のとても長い一文を二行の表示領域に収めながら自然に折り返します'.repeat(4),
  ])('keeps every wrapped character and rolls whole lines vertically', (text) => {
    const lines = wrapReplayCaptionText(text);
    const geometry = replayOriginalGeometry(text);
    expect(lines.length).toBeGreaterThan(REPLAY_ORIGINAL_ROWS);
    expect(geometry.visibleLines).toHaveLength(REPLAY_ORIGINAL_ROWS);
    expect(geometry.visibleLines).toEqual(lines.slice(-REPLAY_ORIGINAL_ROWS));
    expect(geometry.height).toBe(72);
    expect(geometry.clippedChars).toBe(0);
  });
});
