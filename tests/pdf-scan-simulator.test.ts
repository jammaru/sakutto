import { describe, expect, it } from 'vitest';
import { pseudoOcrRegions, type ScanSourceLine } from '../scripts/bench/pdf-scan-simulator.ts';

function sourceLine(text: string, x: number, width: number, y = 100, height = 12): ScanSourceLine {
  return { text, height, box: { x, y, width } };
}

function xSpan(region: { quad: readonly { readonly x: number }[] }): [number, number] {
  const xs = region.quad.map((point) => point.x);
  return [Math.min(...xs), Math.max(...xs)];
}

describe('simulated scan word boxes', () => {
  it('keeps every word inside its source line, including the last one', () => {
    const line = sourceLine(
      'Machine translation of web pages is usually a client of a remote service.',
      79.007,
      436.718,
    );
    const spans = pseudoOcrRegions([line])
      .map(xSpan)
      .sort((left, right) => left[0] - right[0]);
    const rightEdge = line.box.x + line.box.width;

    expect(spans).toHaveLength(13);
    expect(spans[0]?.[0]).toBeCloseTo(line.box.x, 6);
    expect(spans.at(-1)?.[1]).toBeCloseTo(rightEdge, 6);
    for (const [left, right] of spans) {
      expect(left).toBeGreaterThanOrEqual(line.box.x - 1e-9);
      expect(right).toBeLessThanOrEqual(rightEdge + 1e-9);
    }
  });

  it('reserves one space between adjacent words and reverses detector order', () => {
    const regions = pseudoOcrRegions([sourceLine('one two three', 100, 130)]);
    expect(regions.map((region) => region.text)).toEqual(['three', 'two', 'one']);
    expect(regions.map(xSpan)).toEqual([
      [180, 230],
      [140, 170],
      [100, 130],
    ]);
  });
});
