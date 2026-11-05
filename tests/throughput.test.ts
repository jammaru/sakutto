import { describe, expect, it } from 'vitest';
import { pageRates } from '@/dom/throughput';

describe('page rates', () => {
  it('waits until the page has been translating long enough to show a rate', () => {
    expect(pageRates({ active: true, elapsedMs: 100, done: 1, output: '翻訳' })).toEqual({
      tokensPerSecond: null,
      segmentsPerSecond: null,
    });
    expect(pageRates({ active: false, elapsedMs: 2000, done: 4, output: '翻訳' })).toEqual({
      tokensPerSecond: null,
      segmentsPerSecond: null,
    });
  });

  it('reports tokens and segments over the elapsed time', () => {
    const rates = pageRates({
      active: true,
      elapsedMs: 2000,
      done: 4,
      output: 'あ'.repeat(20),
    });

    expect(rates.tokensPerSecond).toBe(5);
    expect(rates.segmentsPerSecond).toBe(2);
  });
});
