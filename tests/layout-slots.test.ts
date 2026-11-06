// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  isDataRowCell,
  isDataValueText,
  listTranslatableBlocks,
  repeatedCellTexts,
} from '@/dom/blocks';
import { buildSegment } from '@/dom/segment';

/**
 * Layout containers that place each child in its own slot. A translation written into the
 * text nodes between the cells becomes an anonymous grid/flex item, and every cell after it
 * moves one slot along — which is exactly how the srclog.com ranking table collapsed into a
 * vertical pile while its untranslated neighbours still looked like a table.
 *
 * These tests use inline styles because happy-dom does not apply stylesheets to
 * `getComputedStyle`, and the layout decision has to be visible to it.
 */

const ROW = 'display: grid; grid-template-columns: 3rem 1fr 8rem';

function rankingRow(rank: number, login: string, name: string, country: string): string {
  return `
    <li class="row" data-rank="${String(rank)}" style="${ROW}">
      <span style="display: block">${String(rank)}</span>
      <a href="/github/${login}" class="person" style="display: flex">
        <span style="display: block">${login}</span>
        <span style="display: block">${name}</span>
      </a>
      <span class="country" style="display: block">${country}</span>
    </li>`;
}

function rankingTable(): string {
  return `
    <div class="head" style="${ROW}">
      <span>Name</span><span>Country</span><span>Language</span>
    </div>
    <ol style="list-style: none">
      ${rankingRow(1, 'antfu', 'Anthony Fu', 'Japan')}
      ${rankingRow(2, 'DayuanJiang', 'Dayuan Jiang', 'Japan')}
      ${rankingRow(3, 'yusukebe', 'Yusuke Wada', 'Japan')}
    </ol>`;
}

function blocks(): Element[] {
  return listTranslatableBlocks(document);
}

function sources(): string[] {
  return blocks().map((block) => buildSegment(block)?.source ?? '');
}

describe('layout slots', () => {
  it('never yields a grid row as one segment', () => {
    document.body.innerHTML = rankingTable();
    const row = document.querySelector('li');
    if (!row) throw new Error('missing row');
    expect(blocks()).not.toContain(row);
  });

  it('never yields a flex container as one segment', () => {
    document.body.innerHTML = '<p style="display: flex"><span>Hello</span><span>world</span></p>';
    expect(sources()).toEqual(['Hello', 'world']);
  });

  it('never folds a grid item into its container segment', () => {
    // The row's own text nodes are the whitespace between the cells. Folding the cells in
    // would send the whole row to the model and write the result back into that whitespace.
    document.body.innerHTML = rankingTable();
    const rows = [...document.querySelectorAll('li')];
    for (const row of rows) {
      const model = buildSegment(row);
      if (!model) continue;
      expect(model.source).not.toContain('Anthony Fu');
      expect(model.source).not.toContain('Dayuan Jiang');
    }
  });

  it('keeps the cells of a grid row as separate segments', () => {
    document.body.innerHTML = rankingTable();
    const texts = blocks().map((block) => (block.textContent ?? '').trim());
    expect(texts).toContain('Anthony Fu');
    expect(texts).toContain('Yusuke Wada');
  });

  it('translates an inline element on its own when its parent places items', () => {
    // A grid item is a slot whatever its own `display` says, so its text must not be
    // written into the container's node list.
    document.body.innerHTML = `
      <div style="display: flex">
        <span>Read more</span>
        <span>Settings</span>
      </div>
    `;
    expect(sources().sort()).toEqual(['Read more', 'Settings']);
  });

  it('still yields a plain container that owns prose beside nested blocks', () => {
    document.body.innerHTML = '<div>Lead sentence<p>Nested paragraph</p></div>';
    const texts = blocks().map((block) => (block.textContent ?? '').trim());
    expect(texts).toContain('Nested paragraph');
    const lead = blocks().find((block) => block.tagName === 'DIV');
    expect(lead && buildSegment(lead)?.source).toBe('Lead sentence');
  });

  it('keeps a table header as one row segment when it is not a repeated data row', () => {
    document.body.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Country</th></tr></thead>
        <tbody><tr><td>Osaka</td><td>Japan</td></tr></tbody>
      </table>
    `;
    // One body row is not a repeating list, so its cells are ordinary copy.
    const texts = blocks().map((block) => (block.textContent ?? '').trim());
    expect(texts).toContain('Osaka');
  });
});

describe('repeated data rows', () => {
  it('marks the cells of a repeating row', () => {
    document.body.innerHTML = rankingTable();
    const cells = [...document.querySelectorAll('li > span')];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(isDataRowCell(cell)).toBe(true);
  });

  it('skips counts, handles and stat lines in a repeated row', () => {
    document.body.innerHTML = rankingTable();
    const texts = blocks().map((block) => (block.textContent ?? '').trim());
    expect(texts).not.toContain('1');
    expect(texts).not.toContain('antfu');
    expect(texts).not.toContain('yusukebe');
  });

  it('keeps a capitalised name for the model, and skips it once the column repeats', () => {
    // `DayuanJiang` is not recognisable as an identifier with certainty, so it is copy. It
    // is skipped only because it repeats down the column, which the next test covers.
    document.body.innerHTML = rankingTable();
    expect(blocks().map((block) => (block.textContent ?? '').trim())).toContain('DayuanJiang');
  });

  it('translates a name in a repeated row', () => {
    document.body.innerHTML = rankingTable();
    expect(blocks().map((block) => (block.textContent ?? '').trim())).toContain('Anthony Fu');
  });

  it('translates the same value once per column instead of once per row', () => {
    document.body.innerHTML = rankingTable();
    const texts = blocks().map((block) => (block.textContent ?? '').trim());
    // The country column reads `Japan` in every row. Translating it per row spends one
    // completion on the same word fifty times and gives the model fifty chances to drift.
    expect(texts.filter((text) => text === 'Japan')).toEqual([]);
  });

  it('still translates a repeated value that appears in a handful of cards', () => {
    // Three cards are not a data column: the repetition threshold is what separates them.
    document.body.innerHTML = `
      <div><p>Learn more</p></div>
      <div><p>Learn more</p></div>
      <div><p>Learn more</p></div>
    `;
    expect(blocks().map((block) => (block.textContent ?? '').trim())).toEqual([
      'Learn more',
      'Learn more',
      'Learn more',
    ]);
  });

  it('reads repeated column values with their markup removed', () => {
    document.body.innerHTML = `
      <ul>
        <li style="${ROW}"><span style="display: block">1</span><span><span>TypeScript</span></span></li>
        <li style="${ROW}"><span style="display: block">2</span><span><span>TypeScript</span></span></li>
        <li style="${ROW}"><span style="display: block">3</span><span><span>TypeScript</span></span></li>
      </ul>
    `;
    expect([...repeatedCellTexts(document)]).toContain('TypeScript');
  });
});

describe('data value classification', () => {
  it('recognises counts, magnitudes and stat lines', () => {
    for (const value of ['1', '44', '1,305', '64.4k', '−12%', '⭐ 64.4k · 🍴 4.1k · 44 repos']) {
      expect(isDataValueText(value)).toBe(true);
    }
  });

  it('recognises handles, slugs and versions', () => {
    for (const value of ['antfu', 'dai-shi', 'pilcrowonpaper', 'v1.2.3', 'node.js']) {
      expect(isDataValueText(value)).toBe(true);
    }
  });

  it('keeps words a reader may not know', () => {
    for (const value of ['Japan', 'TypeScript', 'Anthony Fu', 'Yusuke Wada', 'Read more']) {
      expect(isDataValueText(value)).toBe(false);
    }
  });

  it('keeps text in another script', () => {
    expect(isDataValueText('日本')).toBe(false);
    expect(isDataValueText('ソ瑠璃(soruly)')).toBe(false);
  });
});
