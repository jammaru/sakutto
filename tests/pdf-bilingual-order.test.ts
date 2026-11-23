// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { compareReadingOrder, type LayoutBlock } from '@/pdf/layout';
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
});
