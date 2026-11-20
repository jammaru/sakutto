import { describe, expect, it } from 'vitest';
import {
  CAPTION_REPLAY_LATENCIES_MS,
  CAPTION_REPLAY_MIN_DWELL_MS,
  replayCaptionTrace,
  validateCaptionTrace,
  type CaptionTrace,
} from '@/captions/trace';
import enFixture from './fixtures/caption-traces/en-asr.json';
import jaFixture from './fixtures/caption-traces/ja-asr.json';

const fixtures: Array<[string, CaptionTrace]> = [
  ['EN → JA', validateCaptionTrace(enFixture)],
  ['JA → EN', validateCaptionTrace(jaFixture)],
];

describe.each(fixtures)('%s offline ASR replay', (_name, trace) => {
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
      expect(metrics.blankTranslationFramesAfterFirst).toBe(0);
      expect(metrics.minTranslationDwellMs).not.toBeNull();
      expect(metrics.minTranslationDwellMs ?? 0).toBeGreaterThanOrEqual(
        CAPTION_REPLAY_MIN_DWELL_MS,
      );
      expect(metrics.cancellationCount).toBeGreaterThanOrEqual(0);
    },
  );
});
