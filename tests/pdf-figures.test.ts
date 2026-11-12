import { describe, expect, it } from 'vitest';
import {
  coversMostText,
  figureAreas,
  isPlausibleFigure,
  MAX_FIGURE_PAGE_SHARE,
} from '@/pdf/figures';
import { groupLines } from '@/pdf/lines';
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
      fnArray.push(OPS.constructPath);
      argsArray.push(path(10 + index, 10 + index, 580, 780));
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
      fnArray.push(OPS.constructPath);
      argsArray.push(path(90 + index * 2, 480 + index * 2, 80, 70));
    }
    const areas = figureAreas({ fnArray, argsArray }, OPS, 800, 600);
    expect(areas.images.length).toBeGreaterThan(0);
    expect(areas.images.some((box) => box.width >= 100)).toBe(true);
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
