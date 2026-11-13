import { describe, expect, it } from 'vitest';
import { groupLines } from '@/pdf/lines';
import { layoutPage } from '@/pdf/layout';
import { BODY_MIN_FONT_SIZE, BODY_MIN_SCALE, MIN_FONT_SIZE, MIN_SCALE } from '@/pdf/fit';
import { pageMetrics, metricsPass } from '@/pdf/metrics';
import {
  COVER_DESCENDER_EM,
  clippedPaintWidth,
  coverPaintWidth,
  overlapRegion,
  paintedCoverOverlaps,
  placePage,
  verticalCut,
} from '@/pdf/place';
import { stubExpand } from '@/pdf/stub';
import { measure, piece } from './support/pdf-pieces';

function place(
  lines: ReturnType<typeof groupLines>,
  figures?: Parameters<typeof layoutPage>[1],
  pageHeight = 800,
) {
  const layout = layoutPage(lines, figures, { height: pageHeight });
  const placed = placePage({
    layout,
    translationOf: (block) => stubExpand(block.text),
    target: 'ja',
    measure: (_block, text, size) => measure(text, size),
    pageHeight,
  });
  return {
    layout,
    placed,
    metrics: pageMetrics(layout, placed, { x: 0, y: 0, width: 600, height: pageHeight }),
  };
}

describe('placePage', () => {
  it('fits a two-column page without overlapping boxes', () => {
    const lines = groupLines([
      piece('left top line that fills the column of the page with prose', 40, 100, 240),
      piece('left bottom line that fills the column too and continues', 40, 112, 240),
      piece('A following paragraph in the same left column of the page.', 40, 140, 240),
      piece('right top line that fills the other column of the page', 320, 100, 240),
      piece('right bottom line that fills it as well with more words', 320, 112, 240),
      piece('A following paragraph in the same right-hand column too.', 320, 140, 240),
    ]);
    const { metrics, placed } = place(lines);
    expect(metrics.overlapPairs).toBe(0);
    expect(paintedCoverOverlaps(placed)).toBe(0);
    expect(metrics.prosePainted).toBeGreaterThanOrEqual(0.85);
    expect(metricsPass(metrics)).toBe(true);
  });

  it('does not paint a translation that cannot fit, so the source stays', () => {
    const lines = groupLines([
      piece('A heading', 40, 80, 80, { em: 14, bold: true }),
      piece('tiny', 40, 100, 20, { em: 10 }),
    ]);
    const layout = layoutPage(lines);
    const heading = layout.blocks.find((block) => block.role === 'heading');
    if (!heading) throw new Error('expected a heading');
    const placed = placePage({
      layout,
      translationOf: (block) => (block === heading ? 'あ'.repeat(400) : stubExpand(block.text)),
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 400,
    });
    const painted = placed.find((entry) => entry.block === heading);
    expect(painted?.paint).toBe(false);
    expect(painted?.fit?.fits).toBe(false);
    expect(painted?.overflow).toBe(true);
    expect(painted?.translation.length).toBeGreaterThan(0);
  });

  it('never shrinks below the readable floor', () => {
    const lines = groupLines([
      piece(
        'A reader who wants an article in Japanese has three choices on this page.',
        40,
        100,
        260,
      ),
      piece(
        'The second line continues the same paragraph with more English words here.',
        40,
        112,
        260,
      ),
      piece(
        'A following paragraph in the same column keeps the first one from growing.',
        40,
        128,
        260,
      ),
    ]);
    const { placed } = place(lines);
    for (const entry of placed) {
      if (!entry.paint || !entry.fit) continue;
      const body = entry.block.role === 'prose' && entry.block.fontSize >= 9 - 1e-9;
      const floor = body
        ? Math.max(entry.block.fontSize * BODY_MIN_SCALE, BODY_MIN_FONT_SIZE)
        : Math.max(entry.block.fontSize * MIN_SCALE, MIN_FONT_SIZE);
      expect(entry.fit.fontSize).toBeGreaterThanOrEqual(floor - 1e-9);
    }
  });

  it('does not let two cells in a row paint over each other', () => {
    const lines = groupLines([
      piece('Name', 40, 100, 40, { em: 8 }),
      piece('Value', 120, 100, 40, { em: 8 }),
      piece('pieceChars', 40, 114, 50, { em: 8 }),
      piece('Longest block', 120, 114, 70, { em: 8 }),
    ]);
    const { placed, metrics } = place(lines);
    const painted = placed.filter((entry) => entry.paint && entry.drawn);
    expect(painted.length).toBeGreaterThanOrEqual(3);
    expect(metrics.overlapPairs).toBe(0);
    for (let left = 0; left < painted.length; left += 1) {
      for (let right = left + 1; right < painted.length; right += 1) {
        const a = painted[left]?.drawn;
        const b = painted[right]?.drawn;
        if (!a || !b) continue;
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(overlapX <= 0 || overlapY <= 0).toBe(true);
      }
    }
  });

  it('grows a last paragraph toward the foot of the page, not the highest neighbour', () => {
    const lines = groupLines([
      piece('Title of the document that sits at the top of the page', 40, 40, 400, {
        em: 16,
        bold: true,
      }),
      piece(
        'A long closing paragraph that needs room below it to take a longer translation of the same words.',
        40,
        400,
        400,
      ),
      piece(
        'It continues on a second line so the block is more than a single row of text on the page.',
        40,
        412,
        400,
      ),
    ]);
    const { placed } = place(lines, undefined, 700);
    const prose = placed.find((entry) => entry.block.role === 'prose');
    expect(prose?.paint).toBe(true);
    expect(prose?.fit && prose.fit.fits).toBe(true);
  });

  it('grows a paragraph when a figure sits beside it rather than under it', () => {
    const lines = groupLines([
      piece(
        'A paragraph beside a drawing still has empty space under its own words on this page.',
        40,
        120,
        200,
      ),
    ]);
    const layout = layoutPage(
      lines,
      { images: [{ x: 260, y: 80, width: 160, height: 220 }] },
      { height: 800, width: 500 },
    );
    const placed = placePage({
      layout,
      translationOf: (block) => stubExpand(block.text),
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 800,
      pageWidth: 500,
    });
    expect(placed.some((entry) => entry.paint || entry.overflow)).toBe(true);
    expect(
      placed.every((entry) => entry.paint || entry.overflow || entry.translation.length === 0),
    ).toBe(true);
  });

  it('fails metrics when a page-sized figure cluster turns the body into labels', () => {
    const lines = groupLines([
      piece('Fitting Translated Text Into a Page Layout', 40, 80, 400, { em: 16, bold: true }),
      piece('Encoder', 80, 200, 50),
      piece('Decoder', 80, 230, 50),
      piece('Loss', 80, 260, 40),
    ]);
    const layout = layoutPage(
      lines,
      { images: [{ x: 0, y: 0, width: 600, height: 800 }] },
      { width: 600, height: 800 },
    );
    const placed = placePage({
      layout,
      translationOf: (block) => stubExpand(block.text),
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 800,
      pageWidth: 600,
    });
    const metrics = pageMetrics(layout, placed, { x: 0, y: 0, width: 600, height: 800 });
    expect(metrics.figureAreaShare).toBeGreaterThan(0.5);
    expect(metricsPass(metrics)).toBe(false);
  });

  it('covers 0.22em of descenders without counting that pad as overlap', () => {
    expect(COVER_DESCENDER_EM).toBe(0.22);
    const lines = groupLines([
      piece('A heading that hangs glyphs', 40, 80, 220, { em: 14, bold: true }),
      piece(
        'A body paragraph under the heading that keeps going across the column of the page.',
        40,
        110,
        260,
      ),
    ]);
    const { placed } = place(lines);
    const painted = placed.filter((entry) => entry.paint && entry.drawn);
    expect(painted.length).toBeGreaterThan(0);
    expect(paintedCoverOverlaps(placed)).toBe(0);
    for (const entry of painted) {
      const need = entry.block.box.height + entry.block.fontSize * 0.22;
      expect(verticalCut(entry)).toBe(0);
      expect(entry.drawn?.height ?? 0).toBeGreaterThanOrEqual(need - 0.01);
      const region = overlapRegion(entry);
      expect(region?.height ?? 0).toBeLessThanOrEqual(
        Math.max(entry.block.box.height, entry.fit?.height ?? 0) + 0.01,
      );
    }
  });

  it('paints at least the wrap width when capToPage trims the drawn box', () => {
    const fitWidth = 120;
    const drawnWidth = 119.4;
    expect(coverPaintWidth(fitWidth, drawnWidth)).toBe(fitWidth);
    const lines = groupLines([
      piece(
        'A body paragraph that fills the column and continues across the page with more words.',
        40,
        100,
        260,
      ),
    ]);
    const { placed } = place(lines);
    const painted = placed.filter((entry) => entry.paint && entry.fit && entry.drawn);
    expect(painted.length).toBeGreaterThan(0);
    for (const entry of painted) {
      if (!entry.fit || !entry.drawn) continue;
      expect(coverPaintWidth(entry.fit.width, entry.drawn.width)).toBeGreaterThanOrEqual(
        entry.fit.width,
      );
      expect(clippedPaintWidth(entry, measure)).toBeLessThanOrEqual(0.01);
    }
  });

  it('does not clip a narrow table cell; overflow goes to a marker', () => {
    const lines = groupLines([piece('Maximum', 40, 100, 18, { em: 10 })]);
    const { placed } = place(lines);
    expect(placed.length).toBeGreaterThan(0);
    for (const entry of placed) {
      expect(clippedPaintWidth(entry, measure)).toBeLessThanOrEqual(0.01);
      if (entry.translation.trim().length > 0) {
        expect(entry.paint || entry.overflow).toBe(true);
      }
      if (entry.paint && entry.fit && entry.drawn) {
        const painted = coverPaintWidth(entry.fit.width, entry.drawn.width);
        for (const line of entry.fit.lines) {
          expect(measure(line, entry.fit.fontSize)).toBeLessThanOrEqual(painted + 1);
        }
      }
    }
  });
});
