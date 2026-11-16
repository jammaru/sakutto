// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { assessTranslation } from '@/dom/placeholders';
import { applyTranslation, restoreSegment } from '@/dom/render';
import { buildSegment, placeholderIds } from '@/dom/segment';

function paragraph(html: string): Element {
  document.body.innerHTML = html;
  const block = document.querySelector('p');
  if (!block) throw new Error('missing paragraph');
  return block;
}

describe('subscript and superscript placeholders', () => {
  it('keeps sub/sup in the source instead of dropping them', () => {
    const block = paragraph(
      '<p>Methane CH<sub>4</sub> and 10<sup>3</sup> are compared in water.</p>',
    );
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');

    expect(model.source).toMatch(/CH<i\d+>4<\/i\d+>/u);
    expect(model.source).toMatch(/10<i\d+>3<\/i\d+>/u);
    expect(model.children).toHaveLength(2);
  });

  it('round-trips both scripts through a mock translation and restore', () => {
    const block = paragraph(
      '<p>Methane CH<sub>4</sub> and 10<sup>3</sup> are compared in water.</p>',
    );
    const before = block.innerHTML;
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');
    const created: Text[] = [];
    const mockTranslate = (source: string): string =>
      source.replace('Methane', 'メタン').replace('are compared in water.', 'を水と比較した。');

    applyTranslation(model, mockTranslate(model.source), created);

    expect(block.querySelector('sub')?.textContent).toBe('4');
    expect(block.querySelector('sup')?.textContent).toBe('3');
    expect(block.textContent).toContain('CH4');
    expect(block.textContent).toContain('103');
    expect(block.innerHTML).not.toMatch(/<\/?i\d+>/u);

    restoreSegment(model, created);
    for (const node of created) node.remove();
    expect(block.innerHTML).toBe(before);
  });

  it('keeps a citation marker inside sup and preserves it through translation', () => {
    const block = paragraph('<p>Osaka is a city.<sup class="reference">[1]</sup></p>');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');

    expect(model.source).toMatch(/<i\d+>\[1\]<\/i\d+>/u);
    const created: Text[] = [];
    applyTranslation(model, '大阪は都市です。<i1>[1]</i1>', created);

    expect(block.querySelector('sup')?.textContent).toBe('[1]');
    expect(block.textContent).toContain('大阪は都市です。');
    expect(block.innerHTML).not.toMatch(/<\/?i\d+>/u);
  });

  it('ignores translated text the model puts inside an atomic script tag', () => {
    const block = paragraph('<p>Water is H<sub>2</sub>O and 10<sup>3</sup> here.</p>');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');
    const created: Text[] = [];

    applyTranslation(model, '水は H<i1>に</i1>O で、ここでは 10<i2>さん</i2> です。', created);

    expect(block.querySelector('sub')?.textContent).toBe('2');
    expect(block.querySelector('sup')?.textContent).toBe('3');
    expect(block.textContent).not.toContain('にO');
    expect(block.textContent).not.toContain('さん');
  });

  it('treats an NLM-style subscript span as atomic and keeps the digit on an empty tag', () => {
    const block = paragraph('<p>Methanol is CH<span class="NLM_sub">3</span>OH in water.</p>');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');
    const script = model.children[0];
    if (!script) throw new Error('missing script placeholder');

    expect(script.script).toBe('sub');
    expect(model.source).toMatch(/CH<i\d+>3<\/i\d+>OH/u);

    const created: Text[] = [];
    applyTranslation(model, `メタノールは CH<${script.id}></${script.id}>OH です。`, created);

    expect(block.querySelector('.NLM_sub')?.textContent).toBe('3');
    expect(block.textContent).toContain('CH3OH');
    expect(block.textContent).not.toContain('CHOH');
  });

  it('recognizes vertical-align scripts and keeps both digits through translation', () => {
    const block = paragraph(
      '<p>Methane CH<span style="vertical-align: sub">4</span> and 10<span style="vertical-align: super">3</span> are compared.</p>',
    );
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');

    expect(model.children.map((child) => child.script)).toEqual(['sub', 'super']);
    const created: Text[] = [];
    applyTranslation(model, 'メタン CH<i1></i1> と 10<i2></i2> を比較した。', created);

    expect(block.querySelector('[style*="sub"]')?.textContent).toBe('4');
    expect(block.querySelector('[style*="super"]')?.textContent).toBe('3');
    expect(block.textContent).toContain('CH4');
    expect(block.textContent).toContain('103');
  });

  it('keeps a publisher script inside a link when its tag is dropped', () => {
    const block = paragraph(
      '<p>Methanol is <a href="/compound">CH<span class="NLM_sub">3</span>OH</a> in water.</p>',
    );
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');
    const link = model.children[0];
    const script = link?.children[0];
    if (!link || !script) throw new Error('missing nested script');

    expect(model.source).toMatch(/CH<i\d+>3<\/i\d+>OH/u);
    const created: Text[] = [];
    applyTranslation(
      model,
      `メタノールは <${link.id}>CH<${script.id}></${script.id}>OH</${link.id}> です。`,
      created,
    );

    expect(block.querySelector('a')?.textContent).toBe('CH3OH');
    expect(block.querySelector('.NLM_sub')?.textContent).toBe('3');
    expect(block.textContent).not.toContain('CHOH');
  });

  it('keeps a script glyph in place in a plain fallback that drops the digit', () => {
    const block = paragraph('<p>Methanol is CH<span class="NLM_sub">3</span>OH in water.</p>');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');
    const created: Text[] = [];

    applyTranslation(model, 'メタノールはCHOHです。', created);

    const script = block.querySelector('.NLM_sub');
    expect(script?.textContent).toBe('3');
    expect(block.textContent).toContain('メタノールはCH3OHです。');
    expect(block.textContent).not.toContain('CHOH');
    expect(script?.nextSibling?.nodeValue ?? '').toContain('OH');
  });

  it('rejects a translation that drops a script placeholder', () => {
    const block = paragraph('<p>Methanol is CH<span class="NLM_sub">3</span>OH in water.</p>');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');

    expect(assessTranslation('メタノールはCHOHです。', placeholderIds(model)).ok).toBe(false);
  });
});
