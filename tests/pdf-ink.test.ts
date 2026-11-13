// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { HINTING_WRAP } from '@/pdf/fit';
import { DEFAULT_PAINT_SCALE, HINTING_GROWTH, HINTING_PAD_PX, coverPaintWidth } from '@/pdf/place';
import { coverInkOverflowPx, coverStyle } from '@/pdf/render';

describe('cover ink overflow', () => {
  it('reports zero when Chromium scrollWidth does not exceed the cover', () => {
    expect(coverInkOverflowPx({ scrollWidth: 160, clientWidth: 160 })).toBe(0);
    expect(coverInkOverflowPx({ scrollWidth: 161.2, clientWidth: 160 })).toBeCloseTo(1.2, 5);
  });

  it('paints a cover wider than a hinted line at the reader scale', () => {
    const wrapPt = 120;
    const fontPt = 9.4;
    const scale = DEFAULT_PAINT_SCALE;
    const paintPx = coverPaintWidth(wrapPt, wrapPt, scale) * scale;
    const linePt = wrapPt * HINTING_WRAP;
    const hintedPx = linePt * HINTING_GROWTH * scale;
    expect(HINTING_PAD_PX).toBe(2);
    expect(hintedPx).toBeLessThanOrEqual(paintPx);

    const node = document.createElement('div');
    node.className = 'sakutto-cover';
    node.style.cssText = `${coverStyle(
      { x: 0, y: 0, width: paintPx, height: fontPt * scale * 1.3 },
      fontPt * scale,
      fontPt * scale * 1.3,
      { family: 'serif', bold: false, italic: false },
      'left',
      'ja',
    )};overflow:hidden;white-space:pre`;
    node.textContent = 'translated line';
    document.body.append(node);
    expect(coverInkOverflowPx(node)).toBe(0);
    node.remove();
  });
});
