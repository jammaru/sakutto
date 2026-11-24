// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  bilingualReadingRanks,
  compareReadingOrder,
  layoutPage,
  type LayoutBlock,
} from '@/pdf/layout';
import { groupLines } from '@/pdf/lines';
import { PdfReader } from '@/pdf/reader';
import type { BlockState } from '@/pdf/session';

type BilingualElement = {
  bilingual: HTMLElement;
  bilingualRows: Map<object, HTMLElement>;
};

/** paintBilingual is private; a bare prototype instance keeps this test about ordering only. */
function painter(): (element: BilingualElement, states: readonly BlockState[]) => void {
  const reader = Object.create(PdfReader.prototype) as PdfReader;
  (reader as unknown as { target: string }).target = 'ja';
  const api = reader as unknown as {
    paintBilingual: (element: BilingualElement, states: readonly BlockState[]) => void;
  };
  return api.paintBilingual.bind(reader);
}

function block(
  text: string,
  x: number,
  y: number,
  column: number,
  writing: 0 | 90 = 0,
): LayoutBlock {
  return {
    text,
    box: { x, y, width: 100, height: 20 },
    column,
    writing,
  } as LayoutBlock;
}

function state(b: LayoutBlock): BlockState {
  return {
    block: b,
    state: 'done',
    translation: '訳' + String(b.text.length),
  } as BlockState;
}

/** A normal-pitch vertical column: 40pt wide boxes separated by a 10pt inter-column gap. */
function narrowVertical(text: string, x: number, y: number): LayoutBlock {
  return {
    ...block(text, x, y, 0, 90),
    box: { x, y, width: 40, height: 20 },
  } as LayoutBlock;
}

function rowSources(element: BilingualElement): string[] {
  return [...element.bilingual.children].map((row) => row.firstElementChild?.textContent ?? '');
}

describe('bilingual reading order', () => {
  it('reads a two-column page down the left column before the right', () => {
    const left1 = block('left one', 45, 90, 0);
    const left2 = block('left two', 45, 170, 0);
    const right1 = block('right one', 315, 90, 1);
    const right2 = block('right two', 315, 170, 1);
    // Deliberately interleave the columns as a pure y/x sort would.
    const element: BilingualElement = {
      bilingual: document.createElement('div'),
      bilingualRows: new Map(),
    };
    painter()(element, [state(left1), state(right1), state(left2), state(right2)]);
    expect(rowSources(element)).toEqual(['left one', 'left two', 'right one', 'right two']);
  });

  it('reads vertical columns right to left', () => {
    const right = block('右列', 400, 90, 1, 90);
    const left = block('左列', 100, 90, 0, 90);
    expect(compareReadingOrder(right, left)).toBeLessThan(0);
    const element: BilingualElement = {
      bilingual: document.createElement('div'),
      bilingualRows: new Map(),
    };
    painter()(element, [state(left), state(right)]);
    expect(rowSources(element)).toEqual(['右列', '左列']);
  });

  it('orders a vertical page without column metadata by decreasing x', () => {
    const right = block('右列', 400, 90, 0, 90);
    const left = block('左列', 100, 90, 0, 90);
    expect(compareReadingOrder(right, left)).toBeLessThan(0);
  });

  it('reads adjacent vertical columns at normal pitch right to left', () => {
    const right = narrowVertical('右列', 250, 90);
    const left = narrowVertical('左列', 200, 90);
    expect(compareReadingOrder(right, left)).toBeLessThan(0);
    expect(compareReadingOrder(left, right)).toBeGreaterThan(0);
    const element: BilingualElement = {
      bilingual: document.createElement('div'),
      bilingualRows: new Map(),
    };
    painter()(element, [state(left), state(right)]);
    expect(rowSources(element)).toEqual(['右列', '左列']);
  });

  it('reads adjacent vertical columns right to left below a spanning block', () => {
    const heading = {
      ...block('見出し', 45, 50, -1, 90),
      box: { x: 45, y: 50, width: 500, height: 20 },
    } as LayoutBlock;
    const right = narrowVertical('右列', 250, 90);
    const left = narrowVertical('左列', 200, 90);
    const element: BilingualElement = {
      bilingual: document.createElement('div'),
      bilingualRows: new Map(),
    };
    painter()(element, [state(left), state(heading), state(right)]);
    expect(rowSources(element)).toEqual(['見出し', '右列', '左列']);
  });

  it('reorders rows that already had a DOM node when the layout order changes', () => {
    const left = block('left', 45, 90, 0);
    const right = block('right', 315, 90, 1);
    const element: BilingualElement = {
      bilingual: document.createElement('div'),
      bilingualRows: new Map(),
    };
    const states = [state(left), state(right)];
    const paint = painter();
    paint(element, states);
    expect(rowSources(element)).toEqual(['left', 'right']);
    // A new layout assigns the opposite reading columns to the same states, so the rows
    // already have DOM nodes and have to be moved rather than recreated.
    states[0]!.block = { ...left, column: 1 };
    states[1]!.block = { ...right, column: 0 };
    paint(element, states);
    expect(rowSources(element)).toEqual(['right', 'left']);
  });

  it('reads a native full-width crossing block between the two columns', () => {
    const body = (label: string) =>
      `${label} column prose continues across the printed measure of this paper with enough words to be body text.`;
    // Two real body columns on every row, with a single full-width line crossing their gutter.
    // The lines are long enough that the region is prose rather than a table of short cells.
    const rows = [
      [body('LeftA'), 45, 100, 240],
      [body('RightA'), 320, 100, 240],
      [body('LeftB'), 45, 115, 240],
      [body('RightB'), 320, 115, 240],
      [body('LeftC'), 45, 130, 240],
      [body('RightC'), 320, 130, 240],
      [body('LeftD'), 45, 145, 240],
      [body('RightD'), 320, 145, 240],
      ['Crossing full-width heading printed across both body columns of the page', 45, 175, 510],
      [body('LeftBelow'), 45, 215, 240],
      [body('RightBelow'), 320, 215, 240],
      [body('LeftLast'), 45, 230, 240],
      [body('RightLast'), 320, 230, 240],
    ] as const;
    const lines = groupLines(
      rows.map(([text, x, baseline, width]) => ({
        text,
        box: { x, y: baseline - 10, width, height: 10 },
        baseline,
        fontName: 'regular',
        family: 'serif',
        bold: false,
        italic: false,
        math: false,
        orientation: 0,
        size: 10,
        displayed: 0,
      })),
    );
    const layout = layoutPage(lines, { images: [] }, { width: 600, height: 800 });
    const spanning = layout.blocks.find((block) => block.text.startsWith('Crossing'));
    // The cut reads a crossing band at its printed height, but its block is full-width like an
    // OCR span: column 0 would order the translation as another left-column row.
    expect(spanning?.column).toBe(-1);
    const ranks = bilingualReadingRanks(layout.blocks);
    const order = [...layout.blocks]
      .sort((left, right) => (ranks.get(left) ?? 0) - (ranks.get(right) ?? 0))
      .map((block) => block.text.split(' ', 1)[0]);
    expect(order).toEqual(['LeftA', 'RightA', 'Crossing', 'LeftBelow', 'RightBelow']);
    const element: BilingualElement = {
      bilingual: document.createElement('div'),
      bilingualRows: new Map(),
    };
    painter()(element, layout.blocks.map(state));
    expect(rowSources(element).map((text) => text.split(' ', 1)[0])).toEqual(order);
  });
});
