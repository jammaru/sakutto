import { describe, expect, it } from 'vitest';
import {
  coveredBlocks,
  formatProgressCount,
  outputTokenCount,
  pageRates,
  type ThroughputSample,
} from '@/dom/throughput';

function sample(atMs: number, tokens: number, segments: number): ThroughputSample {
  return { atMs, tokens, segments };
}

describe('page rates', () => {
  it('waits until recent work has a long enough span', () => {
    expect(
      pageRates({
        active: true,
        nowMs: 1_000,
        samples: [sample(800, 0, 0), sample(1_000, 8, 1)],
      }),
    ).toEqual({ tokensPerSecond: null, segmentsPerSecond: null });
    expect(
      pageRates({
        active: false,
        nowMs: 5_000,
        samples: [sample(0, 0, 0), sample(2_000, 20, 4)],
      }),
    ).toEqual({ tokensPerSecond: null, segmentsPerSecond: null });
  });

  it('measures the latest burst instead of the whole lifetime', () => {
    const rates = pageRates({
      active: true,
      nowMs: 4_000,
      samples: [sample(0, 0, 0), sample(1_000, 4, 1), sample(2_000, 20, 4)],
    });

    expect(rates.tokensPerSecond).toBe(10);
    expect(rates.segmentsPerSecond).toBe(2);
  });

  it('does not let a prefill after the burst dilute the rate', () => {
    const duringPrefill = pageRates({
      active: true,
      nowMs: 6_000,
      samples: [sample(0, 0, 0), sample(2_000, 20, 4)],
    });
    const afterTheBurstLeaves = pageRates({
      active: true,
      nowMs: 9_000,
      samples: [sample(0, 0, 0), sample(2_000, 20, 4)],
    });

    expect(duringPrefill.tokensPerSecond).toBe(10);
    expect(duringPrefill.segmentsPerSecond).toBe(2);
    expect(afterTheBurstLeaves).toEqual({ tokensPerSecond: null, segmentsPerSecond: null });
  });

  it('counts a partly painted block toward the bar', () => {
    expect(
      coveredBlocks([
        { state: 'done', partFinal: [true], partText: ['済'] },
        { state: 'running', partFinal: [true, false, false], partText: ['一', '二', ''] },
      ]),
    ).toBeCloseTo(1 + 1.5 / 3);
    expect(formatProgressCount(12)).toBe('12');
    expect(formatProgressCount(12.44)).toBe('12.4');
    expect(outputTokenCount(['あいうえお'])).toBe(3);
  });
});
