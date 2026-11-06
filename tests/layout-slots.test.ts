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

  it('translates a card grid instead of treating it as a data table', () => {
    // A card grid is also a set of sibling elements with the same tag, but a card holds a
    // heading and a paragraph — copy, not values. Only a row of short cells is a record.
    document.body.style.setProperty('display', 'contents');
    document.body.innerHTML = `
      <section style="display: grid; grid-template-columns: 1fr 1fr">
        <article><p>Evaluation</p><h2>Why small benchmarks lie</h2><p>A suite of twenty questions fits in a spreadsheet and flatters every change.</p><p>6 min read</p></article>
        <article><p>Infrastructure</p><h2>The queue is the product</h2><p>Scheduling decisions show up as latency long before throughput charts.</p><p>9 min read</p></article>
        <article><p>Tooling</p><h2>A linter for experiment logs</h2><p>Most failed runs are misconfigured, not mistuned.</p><p>6 min read</p></article>
      </section>
    `;
    const texts = blocks().map((block) => (block.textContent ?? '').trim());
    expect(texts).toContain(
      'A suite of twenty questions fits in a spreadsheet and flatters every change.',
    );
    expect(texts).toContain(
      'Scheduling decisions show up as latency long before throughput charts.',
    );
    // The repeated meta line inside cards is copy, not a column value.
    expect(texts.filter((text) => text === '6 min read')).toHaveLength(2);
  });

  it('still treats short repeated rows as data', () => {
    document.body.innerHTML = rankingTable();
    const row = document.querySelector('li');
    if (!row) throw new Error('missing row');
    expect(isDataRowCell(row.children[0] ?? row)).toBe(true);
  });

  it('translates a flex container that holds only text', () => {
    // A `<p>` styled `display: flex` to space a label and a score still only holds text of
    // its own. Descending into it used to find no child to yield, so the line was never
    // translated and the page reported itself finished over it.
    document.body.innerHTML = `
      <div id="index">
        <p style="display: flex; justify-content: space-between">Translation 41.2</p>
        <p style="display: flex; justify-content: space-between">Fluency 38.7</p>
      </div>
    `;
    const own = blocks()
      .filter((block) => block.tagName === 'P')
      .map((block) => buildSegment(block)?.source ?? '');
    expect(own).toEqual(['Translation 41.2', 'Fluency 38.7']);
  });

  it('still does not yield a flex row that holds real elements', () => {
    document.body.innerHTML = '<p style="display: flex"><span>Hello</span><span>world</span></p>';
    const paragraph = document.querySelector('p');
    if (!paragraph) throw new Error('missing paragraph');
    expect(blocks()).not.toContain(paragraph);
  });

  it('translates a flex row that owns text beside its items', () => {
    // `<div class="bar">Fluency <span>38.7</span></div>`. Every child of a flex container is
    // blockified by the engine, so the span paints as `display: block`; descending past the
    // container found only that span to yield and dropped `Fluency` on the floor. The cells
    // filled in, the words around them stayed in English, and the page still said it was
    // translated.
    document.body.innerHTML = `
      <div style="display: flex; justify-content: space-between" id="bar">
        Fluency <span style="display: block">38.7</span>
      </div>
    `;
    const bar = document.querySelector('#bar');
    if (!bar) throw new Error('missing bar');
    expect(blocks()).toContain(bar);
    expect(buildSegment(bar)?.source).toBe('Fluency <i1>38.7</i1>');
  });

  it('keeps the words around a link in a flex paragraph', () => {
    document.body.innerHTML = `
      <p style="display: flex">
        Read the whole <a href="/x" style="display: block">report</a> before you decide.
      </p>
    `;
    const model = buildSegment(document.querySelector('p') ?? document.body);
    // One segment, so the sentence stays in order around the link instead of the loose
    // words being dropped or merged into each other.
    expect(model?.source).toBe('Read the whole <i1>report</i1> before you decide.');
  });

  it('never folds a grid row that only owns the indentation between its cells', () => {
    // The row's own text nodes are `\n  ` between the cells. Treating those as copy would
    // make the row one segment again, which is the collapse this file exists to prevent.
    document.body.innerHTML = rankingTable();
    for (const row of [...document.querySelectorAll('li')]) {
      const model = buildSegment(row);
      if (!model) continue;
      expect(model.source).not.toContain('Anthony Fu');
      expect(model.source).not.toContain('Japan');
    }
  });

  it('keeps a nested block under a container that owns text', () => {
    // The container is yielded for its own loose text, and the nested block is still its own
    // segment. Yielding the container and stopping would drop the paragraph entirely.
    document.body.innerHTML = `
      <div style="display: grid" id="g">
        Intro sentence
        <article><p>Deep paragraph that readers want.</p></article>
      </div>
    `;
    const sources = blocks().map((block) => buildSegment(block)?.source ?? '');
    expect(sources).toContain('Intro sentence');
    expect(sources).toContain('Deep paragraph that readers want.');
  });

  it('does not translate a folded flex item twice', () => {
    // A blockified `<span>` is folded into the parent's segment as a placeholder, so walking
    // into it as well would queue the same words a second time over a translation.
    document.body.innerHTML = `
      <div style="display: flex" id="bar">Fluency <span style="display: block">38.7</span></div>
    `;
    const sources = blocks()
      .map((block) => buildSegment(block)?.source ?? '')
      .filter((source) => source.length > 0);
    expect(sources.filter((source) => source === '38.7')).toEqual([]);
    expect(sources).toEqual(['Fluency <i1>38.7</i1>']);
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
