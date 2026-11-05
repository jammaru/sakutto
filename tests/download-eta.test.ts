import { describe, expect, it } from 'vitest';
import { estimateRemainingMs, type ByteMark } from '@/ui/download-eta';

describe('estimateRemainingMs', () => {
  it('waits until the transfer has a stable window', () => {
    const marks: ByteMark[] = [
      { at: 0, received: 0 },
      { at: 500, received: 100_000 },
    ];
    expect(estimateRemainingMs(marks, 1_000_000, 500)).toBeNull();
  });

  it('estimates the remainder from the recent rate', () => {
    const marks: ByteMark[] = [
      { at: 0, received: 0 },
      { at: 2_000, received: 500_000 },
    ];
    expect(estimateRemainingMs(marks, 1_000_000, 2_000)).toBe(2_000);
  });

  it('ignores a rate from outside the recent window', () => {
    const marks: ByteMark[] = [
      { at: 0, received: 0 },
      { at: 2_000, received: 5_000_000 },
      { at: 30_000, received: 5_000_000 },
      { at: 32_000, received: 5_512_000 },
    ];
    expect(estimateRemainingMs(marks, 6_024_000, 32_000)).toBe(2_000);
  });

  it('returns zero once the file has arrived', () => {
    const marks: ByteMark[] = [
      { at: 0, received: 0 },
      { at: 2_000, received: 1_000_000 },
    ];
    expect(estimateRemainingMs(marks, 1_000_000, 2_000)).toBe(0);
  });
});
