// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildSegment, visibleOriginal } from '@/dom/segment';

describe('segment source', () => {
  it('keeps separators between links and leaves pronunciation out of the source', () => {
    document.body.innerHTML = `
      <p id="lead">Osaka (<span class="IPA">oːsaka</span>) is a <a href="/city">designated city</a>.<sup class="reference">[1]</sup></p>
      <p id="universities"><a href="/ou">Osaka University</a>, <a href="/omu">Osaka Metropolitan University</a></p>
      <p id="joined"><a href="/a">Osaka University</a><a href="/b">Osaka Metropolitan University</a></p>
    `;

    const lead = document.querySelector('#lead');
    const universities = document.querySelector('#universities');
    const joined = document.querySelector('#joined');
    if (!lead || !universities || !joined) throw new Error('missing paragraphs');

    const leadModel = buildSegment(lead);
    const listModel = buildSegment(universities);
    if (!leadModel || !listModel) throw new Error('missing segment');

    expect(leadModel.source).toContain('(');
    expect(leadModel.source).toContain('<i1>designated city</i1>');
    expect(leadModel.source).not.toContain('oːsaka');
    expect(leadModel.source).not.toContain('[1]');
    expect(listModel.source).toContain(', ');
    expect(visibleOriginal(universities)).toBe('Osaka University, Osaka Metropolitan University');
    expect(visibleOriginal(joined)).toBe('Osaka University Osaka Metropolitan University');
    expect(visibleOriginal(lead)).toContain('oːsaka');
    expect(visibleOriginal(lead)).toContain('[1]');
  });

  it('keeps an aria-hidden icon ligature out of the source and out of the translation', () => {
    // Material Symbols and friends paint a glyph from the literal word inside the span.
    // Sending that word to the model replaced it with a translated word, and the icon
    // then rendered that word's letters — a blank box or the wrong picture — in place of
    // the glyph. The decorative inline stays in the DOM and out of the segment.
    document.body.innerHTML = `
      <p id="lead">Search <span class="material-symbols-outlined" aria-hidden="true">search</span> models</p>
    `;
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing paragraph');
    const model = buildSegment(lead);
    if (!model) throw new Error('missing segment');

    expect(model.source).toContain('Search');
    expect(model.source).toContain('models');
    expect(model.source).not.toContain('search');
    expect(model.children).toHaveLength(0);
  });

  it('keeps a decorative separator between two links out of the source', () => {
    document.body.innerHTML = `
      <p id="lead"><a href="/a">Models</a><span aria-hidden="true">/</span><a href="/b">Datasets</a></p>
    `;
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing paragraph');
    const model = buildSegment(lead);
    if (!model) throw new Error('missing segment');

    expect(model.source).toContain('<i1>Models</i1>');
    expect(model.source).toContain('<i2>Datasets</i2>');
  });

  it('leaves an aria-hidden inline region to the block walk, as before this change', () => {
    // A decorative inline stays out of the parent's segment even when it wraps real text,
    // which is the pre-PR behaviour restored here. The block walk still descends into a
    // non-leaf `aria-hidden` region that contains blocks.
    document.body.innerHTML = `
      <p id="lead">Hello <span aria-hidden="true"><em>world</em></span> today</p>
    `;
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing paragraph');
    const model = buildSegment(lead);
    if (!model) throw new Error('missing segment');
    expect(model.source).not.toContain('world');
    expect(model.source).toContain('Hello');
    expect(model.source).toContain('today');
  });
});
