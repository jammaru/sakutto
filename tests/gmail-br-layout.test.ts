// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension-id',
    },
  },
}));

import { listTranslatableBlocks } from '@/dom/blocks';
import { translateGmailBody } from '@/dom/gmail-banner';
import { restoreSegment } from '@/dom/render';
import { buildSegment } from '@/dom/segment';
import type { PageEngine } from '@/dom/session';

/**
 * A Mozilla AMO approval mail. Gmail puts the whole message in one `<div dir="ltr">` and
 * separates lines with `<br>`; Outlook's reading pane has the same shape. The model usually
 * returns one paragraph, so before this fixture was split at its breaks the renderer wrote
 * every sentence into the first text node and the remaining `<br>`s painted a tall empty gap.
 */
const AMO_BODY =
  'Hi,<br><br>Your add-on "Mozilla Example" has been approved and is now available on addons.mozilla.org.<br><br>You can view the listing at <a href="https://addons.mozilla.org/firefox/addon/example/">the AMO listing page</a> and update it from the developer hub.<br><br>Thanks,<br>The AMO team';

const AMO_MESSAGE = `
  <div data-message-id="amo-1">
    <div class="a3s aiL" lang="en">
      <div dir="ltr">${AMO_BODY}</div>
    </div>
  </div>
`;

const EXPECTED_SOURCES = [
  'Hi,',
  'Your add-on "Mozilla Example" has been approved and is now available on addons.mozilla.org.',
  'You can view the listing at <i1>the AMO listing page</i1> and update it from the developer hub.',
  'Thanks,',
  'The AMO team',
];

function gmailMessage(inner: string): string {
  return `
    <div data-message-id="amo-1">
      <div class="a3s aiL" lang="en">${inner}</div>
    </div>
  `;
}

function messageBody(): HTMLElement {
  document.body.innerHTML = AMO_MESSAGE;
  const element = document.querySelector<HTMLElement>('div.a3s');
  if (!element) throw new Error('missing message body');
  return element;
}

function sourcesFor(html: string): string[] {
  document.body.innerHTML = html;
  const body = document.querySelector<HTMLElement>('div.a3s');
  if (!body) throw new Error('missing message body');
  return listTranslatableBlocks(body).map((block) => buildSegment(block)?.source ?? '');
}

/** Answers each source line in place, dropping the newlines like a real completion often does. */
function immediateEngine(): PageEngine {
  return {
    async *translate(segments, options) {
      for (const segment of segments) {
        if (options.signal.aborted) return;
        yield { id: segment.id, final: `§${segment.text}`, engine: 'plamo' as const };
      }
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('br-separated mail layout', () => {
  it('yields one block per line instead of the whole dir=ltr container', () => {
    const body = messageBody();
    const blocks = listTranslatableBlocks(body);
    const sources = blocks.map((block) => buildSegment(block)?.source ?? '');

    expect(sources).toEqual(EXPECTED_SOURCES);
    // A split run has no source newline left, which is what let the model collapse it.
    expect(sources.every((source) => !source.includes('\n'))).toBe(true);
  });

  it.each([
    ['a single span wrapper', `<span>${AMO_BODY}</span>`],
    ['a single font wrapper', `<font face="Arial">${AMO_BODY}</font>`],
    ['nested span/font wrappers', `<span><font face="Arial">${AMO_BODY}</font></span>`],
    ['a blank div wrapper around a span', `<div class=""><span>${AMO_BODY}</span></div>`],
    ['content directly under a3s', AMO_BODY],
  ])('splits a body with %s', (_name, inner) => {
    expect(sourcesFor(gmailMessage(inner))).toEqual(EXPECTED_SOURCES);
  });

  it('treats wbr as a line boundary but keeps it inside a URL token', () => {
    const html = gmailMessage(
      '<span>Hi,<br><br>Visit https://example.com/a<wbr>very<wbr>long/path.<wbr>Thanks</span>',
    );

    expect(sourcesFor(html)).toEqual([
      'Hi,',
      'Visit https://example.com/averylong/path.',
      'Thanks',
    ]);
  });

  it('translates a span-wrapped Gmail body without collapsing its lines', async () => {
    document.body.innerHTML = gmailMessage(`<span>${AMO_BODY}</span>`);
    const body = document.querySelector<HTMLElement>('div.a3s');
    if (!body) throw new Error('missing message body');
    const original = body.textContent;

    const applied = await translateGmailBody(body, immediateEngine(), {
      targetLanguage: 'ja',
      form: 'polite',
      language: 'en',
      signal: new AbortController().signal,
    });

    expect(applied).toHaveLength(EXPECTED_SOURCES.length);
    expect(body.textContent?.match(/§/gu)).toHaveLength(EXPECTED_SOURCES.length);
    for (const run of body.querySelectorAll('[data-sakutto-run]')) {
      if (!(run.textContent ?? '').includes('§')) continue;
      expect((run.textContent ?? '').match(/§/gu)).toHaveLength(1);
    }
    const link = body.querySelector('a');
    expect(link?.closest('[data-sakutto-run]')?.textContent).toContain(
      '§You can view the listing at',
    );

    for (const entry of applied) restoreSegment(entry.model, entry.created);
    expect(body.textContent).toBe(original);
  });

  it('keeps each translated paragraph in its own run, with the link inside its sentence', async () => {
    const body = messageBody();
    const original = body.textContent;
    const breaks = body.querySelectorAll('br').length;
    const applied = await translateGmailBody(body, immediateEngine(), {
      targetLanguage: 'ja',
      form: 'polite',
      language: 'en',
      signal: new AbortController().signal,
    });

    expect(applied).toHaveLength(EXPECTED_SOURCES.length);
    const runs = [...body.querySelectorAll('[data-sakutto-run]')];
    const translated = runs.filter((run) => (run.textContent ?? '').includes('§'));
    expect(translated).toHaveLength(EXPECTED_SOURCES.length);
    // Each run holds exactly one translated line; a collapse would put every § in one run.
    for (const run of translated) {
      expect((run.textContent ?? '').match(/§/gu)).toHaveLength(1);
    }
    expect(body.textContent?.match(/§/gu)).toHaveLength(EXPECTED_SOURCES.length);
    // The paragraphs still paint as paragraphs, not as one block followed by empty breaks.
    expect(body.querySelectorAll('br')).toHaveLength(breaks);

    const link = body.querySelector('a');
    expect(link?.textContent).toBe('the AMO listing page');
    expect(link?.closest('[data-sakutto-run]')?.textContent).toContain(
      '§You can view the listing at',
    );

    for (const entry of applied) restoreSegment(entry.model, entry.created);
    expect(body.textContent).toBe(original);
    expect(body.querySelectorAll('br')).toHaveLength(breaks);
  });

  it('still keeps a real multiline paragraph as one block', () => {
    document.body.innerHTML = '<p id="multi">First line with text<br>Second line with text</p>';
    const paragraph = document.querySelector('#multi');
    if (!paragraph) throw new Error('missing paragraph');

    expect(listTranslatableBlocks(document)).toContain(paragraph);
    expect(buildSegment(paragraph)?.source).toBe('First line with text\nSecond line with text');
  });
});
