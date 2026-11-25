import { describe, expect, it } from 'vitest';
import { stackedSliverOverlap } from '@/pdf/place';

describe('stackedSliverOverlap', () => {
  const head = { x: 108, y: 157, width: 396, height: 33 };

  it('ignores a hair of overlap where a split paragraph meets its tail', () => {
    // A subscript makes the head's last line taller, so its box reaches 0.6pt into the tail.
    expect(stackedSliverOverlap(head, { x: 108, y: 189.4, width: 396, height: 54 }, 10)).toBe(true);
    expect(stackedSliverOverlap({ x: 108, y: 189.4, width: 396, height: 54 }, head, 10)).toBe(true);
  });

  it('still reports a real overlap between two blocks', () => {
    expect(stackedSliverOverlap(head, { x: 108, y: 175, width: 396, height: 54 }, 10)).toBe(false);
    expect(stackedSliverOverlap(head, { x: 108, y: 160, width: 396, height: 20 }, 10)).toBe(false);
  });

  it('does not treat separate blocks as a sliver', () => {
    expect(stackedSliverOverlap(head, { x: 108, y: 200, width: 396, height: 20 }, 10)).toBe(false);
  });
});
