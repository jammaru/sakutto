// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { applyTranslation, restoreSegment } from '@/dom/render';
import { buildSegment } from '@/dom/segment';

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
});
