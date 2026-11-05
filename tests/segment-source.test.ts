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
});
