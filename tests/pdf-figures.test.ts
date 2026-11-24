import { describe, expect, it } from 'vitest';
import {
  coversMostText,
  figureAreas,
  isPlausibleFigure,
  MAX_FIGURE_PAGE_SHARE,
  PAGE_BACKGROUND_COVERAGE,
  rasterCoverage,
  withoutPageBackground,
  type FigureAreas,
} from '@/pdf/figures';
import { groupLines, type TextLine } from '@/pdf/lines';
import { layoutPage } from '@/pdf/layout';
import { piece } from './support/pdf-pieces';

const OPS = {
  save: 1,
  restore: 2,
  transform: 3,
  paintImageXObject: 4,
  paintInlineImageXObject: 5,
  paintImageMaskXObject: 6,
  constructPath: 7,
  rectangle: 8,
  fill: 9,
  eoFill: 10,
  stroke: 11,
  clip: 12,
  eoClip: 13,
  endPath: 14,
  paintFormXObjectBegin: 15,
  paintFormXObjectEnd: 16,
};

function path(x: number, y: number, width: number, height: number): unknown[] {
  return [0, [x, y, x + width, y, x + width, y + height, x, y + height]];
}

describe('figure cluster caps', () => {
  it('drops a path cluster that covers most of the page', () => {
    expect(isPlausibleFigure({ x: 0, y: 0, width: 600, height: 800 }, 600, 800)).toBe(false);
    expect(MAX_FIGURE_PAGE_SHARE).toBeLessThan(0.5);

    const fnArray: number[] = [];
    const argsArray: unknown[][] = [];
    for (let index = 0; index < 8; index += 1) {
      fnArray.push(OPS.constructPath, OPS.fill);
      argsArray.push(path(10 + index, 10 + index, 580, 780), []);
    }
    const areas = figureAreas(
      { fnArray, argsArray },
      OPS,
      800,
      600,
      groupLines([
        piece('Fitting Translated Text Into a Page Layout', 40, 80, 400, { em: 16, bold: true }),
        piece('The first paragraph of the article continues across the column.', 40, 120, 400),
        piece('A second paragraph of body text sits under the title on this page.', 40, 160, 400),
        piece('A third paragraph keeps the majority of the lines inside the frame.', 40, 200, 400),
      ]),
    );
    expect(areas.images.every((box) => box.width * box.height < 600 * 800 * 0.35)).toBe(true);
  });

  it('keeps a raster image even when it is large, and keeps a modest path cluster', () => {
    const fnArray = [OPS.transform, OPS.paintImageXObject];
    const argsArray: unknown[][] = [[120, 0, 0, 90, 80, 500], []];
    for (let index = 0; index < 6; index += 1) {
      fnArray.push(OPS.constructPath, OPS.fill);
      argsArray.push(path(90 + index * 2, 480 + index * 2, 80, 70), []);
    }
    const areas = figureAreas({ fnArray, argsArray }, OPS, 800, 600);
    expect(areas.images.length).toBeGreaterThan(0);
    expect(areas.images.some((box) => box.width >= 100)).toBe(true);
  });

  it('detects painted rectangles and drops clip paths', () => {
    const fnArray: number[] = [];
    const argsArray: unknown[][] = [];
    for (let index = 0; index < 6; index += 1) {
      fnArray.push(OPS.rectangle, OPS.fill);
      argsArray.push([80 + index * 2, 480 + index * 2, 200, 100], []);
    }
    const areas = figureAreas({ fnArray, argsArray }, OPS, 800, 600);
    expect(areas.images.length).toBeGreaterThan(0);
    expect(areas.images.some((box) => box.width >= 180 && box.height >= 90)).toBe(true);

    const pageClips: number[] = [];
    const pageArgs: unknown[][] = [];
    for (let index = 0; index < 6; index += 1) {
      pageClips.push(OPS.rectangle, OPS.clip, OPS.endPath);
      pageArgs.push([0, 0, 600, 800], [], []);
    }
    expect(figureAreas({ fnArray: pageClips, argsArray: pageArgs }, OPS, 800, 600).images).toEqual(
      [],
    );

    const unpainted: number[] = [];
    const unpaintedArgs: unknown[][] = [];
    for (let index = 0; index < 6; index += 1) {
      unpainted.push(OPS.constructPath);
      unpaintedArgs.push(path(80 + index * 2, 480 + index * 2, 200, 100));
    }
    expect(
      figureAreas({ fnArray: unpainted, argsArray: unpaintedArgs }, OPS, 800, 600).images,
    ).toEqual([]);
  });

  it('uses a transformed Form XObject bbox as a figure candidate', () => {
    const fnArray = [
      OPS.paintFormXObjectBegin,
      OPS.paintFormXObjectEnd,
      OPS.restore,
      OPS.save,
      OPS.paintFormXObjectBegin,
      OPS.paintFormXObjectEnd,
    ];
    const argsArray: unknown[][] = [
      [
        [1, 0, 0, 1, 40, 400],
        [0, 0, 200, 100],
      ],
      [],
      [],
      [],
      [
        [1, 0, 0, 1, 300, 100],
        [0, 0, 200, 100],
      ],
      [],
    ];
    const areas = figureAreas({ fnArray, argsArray }, OPS, 800, 600);
    expect(areas.images).toHaveLength(2);
    expect(areas.images.some((box) => box.x >= 40 && box.width >= 190)).toBe(true);
    expect(areas.images.some((box) => box.x >= 300 && box.width >= 190)).toBe(true);
  });

  it('prefers a path minMax and leaves code inside a rectangle figure as figure-label', () => {
    const fnArray: number[] = [];
    const argsArray: unknown[][] = [];
    for (let index = 0; index < 6; index += 1) {
      fnArray.push(OPS.constructPath, OPS.fill);
      // The coordinate list is tiny; pdf.js's minMax is the painted area that must win.
      argsArray.push([0, [0, 0, 1, 0, 1, 1], [80, 480, 280, 580]], []);
    }
    const lines = groupLines([
      piece('The model routes each token to two of its experts.', 49, 100, 250),
      piece('Router', 150, 280, 40),
      piece('emit(token);', 150, 300, 70),
    ]);
    const areas = figureAreas({ fnArray, argsArray }, OPS, 800, 600, lines);
    expect(areas.images.some((box) => box.width >= 180 && box.height >= 90)).toBe(true);
    const layout = layoutPage(lines, areas, { width: 600, height: 800 });
    expect(layout.blocks.map((block) => block.text)).toContain(
      'The model routes each token to two of its experts.',
    );
    expect(layout.blocks.map((block) => block.text)).not.toContain('Router');
    expect(layout.blocks.map((block) => block.text)).not.toContain('emit(token);');
    const labels = layout.skipped.filter((block) => block.role === 'figure-label');
    expect(labels.some((block) => block.text.includes('Router'))).toBe(true);
    expect(labels.some((block) => block.text.includes('emit(token);'))).toBe(true);
  });

  it('shrinks a form to its painted paths and keeps a caption outside the figure', () => {
    const fnArray: number[] = [OPS.paintFormXObjectBegin];
    const argsArray: unknown[][] = [
      [
        [1, 0, 0, 1, 40, 300],
        [0, 0, 300, 200],
      ],
    ];
    for (let index = 0; index < 6; index += 1) {
      fnArray.push(OPS.constructPath, OPS.fill);
      argsArray.push(path(40 + index * 2, 120, 200, 60), []);
    }
    fnArray.push(OPS.paintFormXObjectEnd);
    argsArray.push([]);
    const lines = groupLines([
      piece('Figure 1: A caption under the drawing stays prose.', 40, 430, 240),
    ]);
    const areas = figureAreas({ fnArray, argsArray }, OPS, 800, 600, lines);
    expect(areas.images.length).toBeGreaterThan(0);
    expect(areas.images.every((box) => box.height < 100)).toBe(true);
    expect(areas.images.every((box) => 425 < box.y || 425 > box.y + box.height)).toBe(true);
    const layout = layoutPage(lines, areas, { width: 600, height: 800 });
    expect(layout.blocks.some((block) => block.role === 'caption')).toBe(true);
    expect(layout.skipped.some((block) => block.role === 'figure-label')).toBe(false);
  });

  it('rejects a column-spanning path cluster before caption shrinking', () => {
    const fnArray: number[] = [];
    const argsArray: unknown[][] = [];
    for (let index = 0; index < 6; index += 1) {
      fnArray.push(OPS.constructPath, OPS.fill);
      argsArray.push(path(40 + index, 400, 510, 200), []);
    }
    const lines = groupLines([
      piece('Left column prose line one stays translatable.', 50, 230, 240),
      piece('Left column prose line two stays translatable.', 50, 250, 240),
      piece('Right column prose line one must stay translatable.', 320, 270, 240),
      piece('Right column prose line two must stay translatable.', 320, 290, 240),
      piece('Right column prose line three must stay translatable.', 320, 310, 240),
      piece('Right column prose line four must stay translatable.', 320, 330, 240),
      piece('Figure 1: Caption under the wide drawing.', 40, 350, 300),
      piece('Lower right prose line one stays translatable.', 320, 360, 240),
      piece('Lower right prose line two stays translatable.', 320, 370, 240),
      piece('Lower right prose line three stays translatable.', 320, 380, 240),
      piece('Lower right prose line four stays translatable.', 320, 390, 240),
      piece('Lower right prose line five stays translatable.', 320, 400, 240),
    ]);
    const areas = figureAreas({ fnArray, argsArray }, OPS, 800, 600, lines);
    const layout = layoutPage(lines, areas, { width: 600, height: 800 });
    expect(layout.blocks.some((block) => block.text.includes('Right column prose line one'))).toBe(
      true,
    );
    expect(
      layout.skipped.some(
        (block) =>
          block.role === 'figure-label' && block.text.includes('Right column prose line one'),
      ),
    ).toBe(false);
  });

  it('does not treat a page frame as a figure, so a title stays a heading', () => {
    const lines = groupLines([
      piece('Fitting Translated Text Into a Page Layout', 40, 80, 420, { em: 16, bold: true }),
      piece('The first paragraph of the article continues across the column here.', 40, 130, 420),
      piece('A second paragraph of body text sits under the title on this page.', 40, 170, 420),
      piece('A third paragraph keeps the majority of the lines inside the frame.', 40, 210, 420),
    ]);
    const frame = { x: 0, y: 0, width: 600, height: 800 };
    expect(coversMostText(frame, lines)).toBe(true);
    const layout = layoutPage(lines, { images: [] }, { width: 600, height: 800 });
    expect(layout.blocks.some((block) => block.role === 'heading')).toBe(true);
    expect(layout.blocks.some((block) => block.role === 'prose')).toBe(true);
  });
});

describe('page-background raster filtering', () => {
  const width = 600;
  const height = 800;
  interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  /** Raster tiles, expressed as pdf.js unit-square paints in top-left page coordinates. */
  const rasterAreas = (boxes: readonly Rect[]): FigureAreas => {
    const fnArray: number[] = [];
    const argsArray: unknown[][] = [];
    for (const box of boxes) {
      fnArray.push(OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore);
      argsArray.push([], [box.width, 0, 0, box.height, box.x, height - box.y - box.height], [], []);
    }
    return figureAreas({ fnArray, argsArray }, OPS, height, width);
  };

  /** Six painted paths per box, so each box is recognised as a vector figure. */
  const vectorAreas = (boxes: readonly Rect[], lines: readonly TextLine[] = []): FigureAreas => {
    const fnArray: number[] = [];
    const argsArray: unknown[][] = [];
    for (const box of boxes) {
      for (let index = 0; index < 6; index += 1) {
        fnArray.push(OPS.constructPath, OPS.fill);
        argsArray.push(
          path(box.x + index * 2, height - box.y - box.height + index * 2, box.width, box.height),
          [],
        );
      }
    }
    return figureAreas({ fnArray, argsArray }, OPS, height, width, lines);
  };

  const strips = (count: number): Rect[] =>
    Array.from({ length: count }, (_, index) => ({
      x: 0,
      y: (index * height) / count,
      width,
      height: height / count,
    }));

  it('sums tiled raster coverage instead of looking at one image', () => {
    const tiles = {
      images: [
        { x: 0, y: 0, width: 300, height: 800 },
        { x: 300, y: 0, width: 300, height: 800 },
      ],
    };
    expect(rasterCoverage(tiles, width, height)).toBe(1);
    expect(rasterCoverage({ images: [] }, width, height)).toBe(0);
    expect(rasterCoverage(tiles, 0, 0)).toBe(0);
  });

  it('drops a tiled or inset scan but keeps a partial figure', () => {
    const tiles = {
      images: [
        { x: 0, y: 0, width: 300, height: 800 },
        { x: 300, y: 0, width: 300, height: 800 },
      ],
    };
    const inset = { images: [{ x: 20, y: 40, width: 550, height: 720 }] };
    const partial = { images: [{ x: 40, y: 60, width: 300, height: 400 }] };
    expect(rasterCoverage(inset, width, height)).toBeGreaterThanOrEqual(PAGE_BACKGROUND_COVERAGE);
    expect(withoutPageBackground(tiles, width, height).images).toHaveLength(0);
    expect(withoutPageBackground(inset, width, height).images).toHaveLength(0);
    expect(withoutPageBackground(partial, width, height)).toEqual(partial);
    // A drawing drawn on top of the scan must still protect its own labels.
    const withFigure = { images: [...tiles.images, ...partial.images] };
    expect(withoutPageBackground(withFigure, width, height).images).toEqual(partial.images);
  });

  it('removes every tile of a three- or five-strip scan, with no leftover strip', () => {
    for (const count of [3, 5]) {
      const tiles = rasterAreas(strips(count));
      expect(rasterCoverage(tiles, width, height)).toBeCloseTo(1);
      const cleaned = withoutPageBackground(tiles, width, height);
      expect(cleaned.images).toEqual([]);
      expect(cleaned.rasters).toEqual([]);
    }

    // Native text inside the last strip of a five-tile scan must stay translatable.
    const footer = piece('Footer stamp inside the last scan tile', 40, 730, 300);
    const lines = groupLines([footer]);
    const layout = layoutPage(lines, withoutPageBackground(rasterAreas(strips(5)), width, height), {
      width,
      height,
      index: 0,
    });
    expect(layout.blocks.map((block) => block.text)).toContain(footer.text);
    expect(layout.skipped.filter((block) => block.role === 'figure-label')).toHaveLength(0);
  });

  it('sums disjoint vertical spans when raster tiles have hairline gaps', () => {
    const gapped = {
      images: [0, 200, 400, 600].map((y) => ({ x: 0, y, width, height: 199 })),
    };
    expect(rasterCoverage(gapped, width, height)).toBeCloseTo(0.995);

    const bands = {
      images: [
        { x: 0, y: 0, width, height: 200 },
        { x: 0, y: 400, width, height: 200 },
      ],
    };
    expect(rasterCoverage(bands, width, height)).toBeCloseTo(0.5);
  });

  it('removes a gapped tiled scan so its native header stays translatable', () => {
    const tiles = rasterAreas([0, 200, 400, 600].map((y) => ({ x: 0, y, width, height: 199 })));
    expect(rasterCoverage(tiles, width, height)).toBeCloseTo(0.995);

    const header = piece('Quarterly results and outlook for readers', 40, 40, 400);
    const lines = groupLines([header]);
    const cleaned = withoutPageBackground(tiles, width, height);
    expect(cleaned.images).toEqual([]);
    expect(cleaned.rasters).toEqual([]);

    const layout = layoutPage(lines, cleaned, { width, height, index: 0 });
    expect(layout.blocks.map((block) => block.text)).toContain(header.text);
    expect(layout.skipped.filter((block) => block.role === 'figure-label')).toHaveLength(0);
  });

  it('removes all overlapping scan tiles as one coherent cluster', () => {
    const tiles = rasterAreas([
      { x: 0, y: 0, width, height: 400 },
      { x: 0, y: 200, width, height: 400 },
      { x: 0, y: 400, width, height: 400 },
    ]);
    expect(rasterCoverage(tiles, width, height)).toBeGreaterThanOrEqual(PAGE_BACKGROUND_COVERAGE);
    expect(withoutPageBackground(tiles, width, height).images).toEqual([]);
  });

  it('keeps a lone full-bleed figure instead of reading it as a scan background', () => {
    const fullBleed = { images: [{ x: 0, y: 0, width, height: 650 }] };
    expect(rasterCoverage(fullBleed, width, height)).toBeGreaterThanOrEqual(
      PAGE_BACKGROUND_COVERAGE,
    );
    // One raster touching the page edges is a drawing, not a scan: edge contact needs a
    // second tile (or a near-page-size box) before it removes the image and its labels.
    expect(withoutPageBackground(fullBleed, width, height)).toEqual(fullBleed);

    const label = piece('Axis label drawn inside the full-bleed figure', 40, 300, 300);
    const layout = layoutPage(
      groupLines([label]),
      withoutPageBackground(fullBleed, width, height),
      { width, height, index: 0 },
    );
    expect(
      layout.skipped.some((block) => block.role === 'figure-label' && block.text === label.text),
    ).toBe(true);

    // The same full-width raster is background once another tile joins it at the page edge.
    const tiled = rasterAreas([
      { x: 0, y: 0, width, height: 650 },
      { x: 0, y: 650, width, height: 150 },
    ]);
    expect(withoutPageBackground(tiled, width, height).images).toEqual([]);
  });

  it('keeps a partial figure when the inset scan alone misses the threshold', () => {
    const scan = rasterAreas([{ x: 0, y: 0, width: 420, height }]);
    const lines = groupLines([piece('Router', 300, 300, 60)]);
    const drawing = vectorAreas([{ x: 240, y: 120, width: 300, height: 300 }], lines);
    const figures: FigureAreas = {
      images: [...scan.images, ...drawing.images],
      rasters: scan.rasters ?? [],
    };
    expect(drawing.images).toHaveLength(1);
    expect(rasterCoverage(figures, width, height)).toBeCloseTo(0.7);
    expect(withoutPageBackground(figures, width, height).images).toEqual(figures.images);
    const layout = layoutPage(lines, withoutPageBackground(figures, width, height), {
      width,
      height,
      index: 0,
    });
    expect(layout.skipped.some((block) => block.role === 'figure-label')).toBe(true);
  });

  it('keeps vector figures even when together they cover 80% of the page', () => {
    const figures: FigureAreas = {
      images: [
        { x: 0, y: 0, width, height: 320 },
        { x: 0, y: 480, width, height: 320 },
      ],
      rasters: [],
    };
    expect(rasterCoverage(figures, width, height)).toBe(0);
    expect(withoutPageBackground(figures, width, height)).toEqual(figures);
    const label = piece('Axis label inside the drawing', 40, 200, 200);
    const lines = groupLines([label]);
    const layout = layoutPage(lines, figures, { width, height, index: 0 });
    expect(layout.skipped.some((block) => block.role === 'figure-label')).toBe(true);
  });
});
