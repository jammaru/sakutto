import { describe, expect, it } from 'vitest';
import type { Box } from '../src/pdf/geometry';
import { layoutExportText, type ExportTextRequest } from '../src/pdf/export';

const EPSILON = 0.01;
/** A stand-in for the embedded face: Latin at 0.55em, CJK at a full em. */
function measure(text: string, size: number): number {
  let width = 0;
  for (const character of text) {
    width += (character.codePointAt(0) ?? 0) > 0x2e80 ? size : size * 0.55;
  }
  return width;
}

function request(overrides: Partial<ExportTextRequest> = {}): ExportTextRequest {
  return {
    translation: '',
    lines: [],
    fontSize: 10,
    lineHeight: 13,
    width: 220,
    height: 80,
    targetLanguage: 'en',
    role: 'prose',
    measure,
    ...overrides,
  };
}

function box(x: number, y: number, width: number, height: number): Box {
  return { x, y, width, height };
}

describe('layoutExportText', () => {
  it('wraps narrow left and right columns inside their own bounds', () => {
    // Boxes from the image-only two-column paper fixture, in page points.
    const left = box(60, 100, 220, 80);
    const right = box(320, 100, 210, 80);
    const translation =
      'By using WebAssembly within the browser models can be executed on the local device without sending source text anywhere. GPU acceleration varies with the endpoint and the available memory, so the same paper reads differently on two machines.';
    expect(left.x + left.width).toBeLessThan(right.x);
    for (const column of [left, right]) {
      const layout = layoutExportText(
        request({
          translation,
          // The viewer's canvas font set these lines; the embedded face measures them wider.
          lines: [translation],
          width: column.width,
          height: column.height,
        }),
      );
      expect(layout.lines.length).toBeGreaterThan(1);
      expect(layout.clipped).toBe(false);
      for (const line of layout.lines) {
        expect(measure(line, layout.fontSize)).toBeLessThanOrEqual(column.width + EPSILON);
        // No glyph may cross the column's own right edge into the gutter.
        expect(column.x + measure(line, layout.fontSize)).toBeLessThanOrEqual(
          column.x + column.width + EPSILON,
        );
      }
      expect(layout.height).toBeLessThanOrEqual(column.height + 1 + EPSILON);
    }
  });

  it('keeps the viewer line breaks when the embedded face agrees', () => {
    const lines = ['Short first line', 'Short second line'];
    const layout = layoutExportText(request({ translation: lines.join(' '), lines }));
    expect(layout.lines).toEqual(lines);
    expect(layout.fontSize).toBe(10);
    expect(layout.lineHeight).toBe(13);
    expect(layout.clipped).toBe(false);
  });

  it('shrinks a single-line figure label instead of painting over the artwork', () => {
    const width = 62;
    const layout = layoutExportText(
      request({
        translation: 'Figure 1: Translation process',
        lines: ['Figure 1: Translation process'],
        singleLine: true,
        role: 'label',
        width,
        height: 14,
        fontSize: 9,
        lineHeight: 11,
      }),
    );
    expect(layout.lines).toHaveLength(1);
    expect(layout.fontSize).toBeLessThan(9);
    expect(measure(layout.lines[0] ?? '', layout.fontSize)).toBeLessThanOrEqual(width + EPSILON);
  });

  it('clips rather than drawing glyphs outside a box no size can fit', () => {
    const width = 10;
    const layout = layoutExportText(
      request({
        translation: 'Local inference server and browser translation',
        lines: ['Local inference server and browser translation'],
        singleLine: true,
        width,
        height: 9,
      }),
    );
    for (const line of layout.lines) {
      expect(measure(line, layout.fontSize)).toBeLessThanOrEqual(width + EPSILON);
    }
    expect(layout.height).toBeLessThanOrEqual(9 + 1 + EPSILON);
  });
});
