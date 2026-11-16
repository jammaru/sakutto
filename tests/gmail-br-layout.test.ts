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
import { translateOutlookBody } from '@/dom/outlook-banner';
import { applyTranslation, restoreSegment } from '@/dom/render';
import { buildSegment } from '@/dom/segment';
import type { PageEngine } from '@/dom/session';

/**
 * A Mozilla AMO approval mail. Gmail puts the whole message in one container and separates
 * lines with `<br>`; sometimes the container is a `<div dir="ltr">`, sometimes the whole
 * plain-text body sits inside a single `<span>` or `<font>`. The model usually returns one
 * paragraph, so the renderer has to put the translated words back on the source line runs.
 */
const AMO_BODY =
  'Hi,<br><br>Your add-on "Mozilla Example" has been approved and is now available on addons.mozilla.org.<br><br>You can view the listing at <a href="https://addons.mozilla.org/firefox/addon/example/">the AMO listing page</a> and update it from the developer hub.<br><br>Thanks,<br>The AMO team';

const VARIANTS: readonly (readonly [string, string])[] = [
  ['a single span wrapper', `<span>${AMO_BODY}</span>`],
  ['a single font wrapper', `<font face="Arial">${AMO_BODY}</font>`],
  ['nested span/font wrappers', `<span><font face="Arial">${AMO_BODY}</font></span>`],
  ['a blank div wrapper around a span', `<div class=""><span>${AMO_BODY}</span></div>`],
  ['content directly under a3s', AMO_BODY],
  ['a dir=ltr container', `<div dir="ltr">${AMO_BODY}</div>`],
  [
    'a span with newlines between brs',
    `<span>${AMO_BODY.replaceAll('<br><br>', '<br>\n<br>')}</span>`,
  ],
  [
    'a span with spaces between brs',
    `<span>${AMO_BODY.replaceAll('<br><br>', '<br> <br>')}</span>`,
  ],
];

function gmailMessage(inner: string): string {
  return `
    <div data-message-id="amo-1">
      <div class="a3s aiL" lang="en">${inner}</div>
    </div>
  `;
}

function gmailBody(inner: string): HTMLElement {
  document.body.innerHTML = gmailMessage(inner);
  const body = document.querySelector<HTMLElement>('div.a3s');
  if (!body) throw new Error('missing message body');
  return body;
}

/** Splits an element's direct text and inline children at the real `<br>` nodes. */
function lineTexts(element: Element): string[] {
  const lines = [''];
  for (const child of element.childNodes) {
    if (child instanceof Element && child.localName === 'br') {
      lines.push('');
      continue;
    }
    lines[lines.length - 1] += child.textContent ?? '';
  }
  return lines;
}

/** Drops the source newlines the way a real completion often does. */
function droppingBreaksEngine(counter?: { requests: number }): PageEngine {
  return {
    async *translate(segments, options) {
      if (counter) counter.requests += segments.length;
      for (const segment of segments) {
        if (options.signal.aborted) return;
        yield {
          id: segment.id,
          final: `§${segment.text.replace(/\n+/gu, ' ')}`,
          engine: 'plamo' as const,
        };
      }
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('br-separated mail layout', () => {
  it.each(VARIANTS)('keeps %s as one segment with real line breaks', (_name, inner) => {
    const body = gmailBody(inner);
    const before = body.innerHTML;
    const blocks = listTranslatableBlocks(body);

    expect(body.innerHTML).toBe(before);
    expect(blocks).toHaveLength(1);
    const source = buildSegment(blocks[0] ?? body)?.source ?? '';
    expect(source).toContain('Hi,\n\nYour add-on');
    expect(source).toContain('developer hub.\n\nThanks,\nThe AMO team');
    expect(source).toContain('<i1>the AMO listing page</i1>');
  });

  it.each(VARIANTS)('lays out %s after a model drops the newlines', async (_name, inner) => {
    const body = gmailBody(inner);
    const before = body.innerHTML;
    const breaks = body.querySelectorAll('br').length;

    const applied = await translateGmailBody(body, droppingBreaksEngine(), {
      targetLanguage: 'ja',
      form: 'polite',
      language: 'en',
      signal: new AbortController().signal,
    });

    expect(applied).toHaveLength(1);
    expect(body.querySelector('[data-sakutto-run]')).toBeNull();
    expect(body.querySelectorAll('br')).toHaveLength(breaks);

    const block = applied[0]?.model.block ?? body;
    const lines = lineTexts(block).filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('§');
    expect(body.textContent).toContain('listing at the AMO listing page and update');

    for (const entry of applied) restoreSegment(entry.model, entry.created);
    expect(body.innerHTML).toBe(before);
  });

  it('does not mutate the DOM when the same block is scanned twice', async () => {
    document.body.innerHTML = '<div id="mail">Hello<br>2024<br>World</div>';
    const body = document.querySelector('#mail');
    if (!body) throw new Error('missing body');

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((entries) => records.push(...entries));
    observer.observe(body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    const first = listTranslatableBlocks(body).map((block) => buildSegment(block)?.source ?? '');
    await new Promise((resolve) => setTimeout(resolve, 0));
    records.length = 0;
    const second = listTranslatableBlocks(body).map((block) => buildSegment(block)?.source ?? '');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(records).toHaveLength(0);
    expect(second).toEqual(first);
    observer.disconnect();
  });

  it('keeps a thirty-line mail in one request and spreads it over its lines', async () => {
    const body = gmailBody(
      `<span>${Array.from({ length: 30 }, (_, index) => `Line ${String(index + 1)}.`).join('<br>')}</span>`,
    );
    const counter = { requests: 0 };
    const applied = await translateGmailBody(body, droppingBreaksEngine(counter), {
      targetLanguage: 'ja',
      form: 'polite',
      language: 'en',
      signal: new AbortController().signal,
    });

    expect(counter.requests).toBe(1);
    expect(applied).toHaveLength(1);
    const block = applied[0]?.model.block ?? body;
    expect(lineTexts(block).filter((line) => line.trim().length > 0)).toHaveLength(30);
  });

  it.each([
    [
      'Japanese',
      'こんにちは。メッセージの準備ができました。ありがとう',
      ['こんにちは。', 'メッセージの準備ができました。', 'ありがとう'],
    ],
    ['Chinese', '你好。消息已准备好。谢谢', ['你好。', '消息已准备好。', '谢谢']],
  ])(
    'keeps %s sentences whole when blank source lines sit between brs',
    async (_name, translation, expected) => {
      const body = gmailBody(
        '<span>One<br>\n<br>Two<br>\n<br>Three<br>\n<br>Four<br>\n<br>Five</span>',
      );
      const block = body.querySelector('span');
      if (!block) throw new Error('missing inline body');
      const whitespace = [...block.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE && !(node.nodeValue ?? '').trim())
        .map((node) => ({ node: node as Text, value: node.nodeValue }));
      expect(whitespace.length).toBeGreaterThan(0);

      const engine: PageEngine = {
        async *translate(segments) {
          for (const segment of segments) {
            yield { id: segment.id, final: translation, engine: 'plamo' as const };
          }
        },
      };
      const applied = await translateGmailBody(body, engine, {
        targetLanguage: 'ja',
        form: 'polite',
        language: 'en',
        signal: new AbortController().signal,
      });

      const lines = lineTexts(applied[0]?.model.block ?? body)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(lines).toEqual(expected);
      for (const line of lines) expect(Array.from(line).length).toBeGreaterThan(1);
      for (const entry of whitespace) expect(entry.node.nodeValue).toBe(entry.value);
    },
  );

  it('keeps adjacent label lines separate when the translation has no terminators', async () => {
    const body = gmailBody(
      '<span>Approved versions: 1.6.2<br>Comments: This version has been screened and is available for download.</span>',
    );
    const engine: PageEngine = {
      async *translate(segments) {
        for (const segment of segments) {
          yield {
            id: segment.id,
            final:
              '承認済みバージョン：1.6.2 コメント：本バージョンは審査済みで、ダウンロードできます。',
            engine: 'plamo' as const,
          };
        }
      },
    };
    const applied = await translateGmailBody(body, engine, {
      targetLanguage: 'ja',
      form: 'polite',
      language: 'en',
      signal: new AbortController().signal,
    });

    const lines = lineTexts(applied[0]?.model.block ?? body)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('1.6.2');
    expect(lines[1]).toContain('コメント：');
  });

  it('does not cut through a multi-word English label', async () => {
    const body = gmailBody(
      '<span>Approved versions: 1.6.2<br>Comments: This version has been screened and is available for download.</span>',
    );
    const engine: PageEngine = {
      async *translate(segments) {
        for (const segment of segments) {
          yield {
            id: segment.id,
            final:
              'Approved versions: 1.6.2 Comments: This version has been screened and is available for download.',
            engine: 'plamo' as const,
          };
        }
      },
    };
    const applied = await translateGmailBody(body, engine, {
      targetLanguage: 'ja',
      form: 'polite',
      language: 'en',
      signal: new AbortController().signal,
    });

    const lines = lineTexts(applied[0]?.model.block ?? body)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Approved versions: 1.6.2');
    expect(lines[1]).toContain('Comments:');
  });

  it('keeps a normal page with br lines readable after a one-line translation', () => {
    document.body.innerHTML = '<div id="mail">First line<br>\nSecond line<br>\nThird line</div>';
    const body = document.querySelector('#mail');
    if (!body) throw new Error('missing body');
    const before = body.innerHTML;
    const block = listTranslatableBlocks(body)[0];
    if (!block) throw new Error('missing block');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');
    expect(model.source).toBe('First line\nSecond line\nThird line');

    const created: Text[] = [];
    applyTranslation(model, 'First sentence. Second sentence. Third sentence.', created);
    const lines = lineTexts(block)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines).toEqual(['First sentence.', 'Second sentence.', 'Third sentence.']);

    restoreSegment(model, created);
    expect(body.innerHTML).toBe(before);
  });

  it('leaves a contenteditable draft untouched while translating the rest', () => {
    document.body.innerHTML =
      '<div id="mail">Hello<br><span contenteditable="true">draft</span> tail<br>World</div>';
    const body = document.querySelector('#mail');
    if (!body) throw new Error('missing body');
    const before = body.innerHTML;
    const editable = body.querySelector('[contenteditable]');

    const block = listTranslatableBlocks(body)[0];
    if (!block) throw new Error('missing block');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');
    expect(model.source).not.toContain('draft');
    expect(model.source).toContain('tail');

    const created: Text[] = [];
    applyTranslation(model, `§${model.source.replace(/\n+/gu, ' ')}`, created);
    expect(body.querySelector('[contenteditable]')).toBe(editable);
    expect(editable?.textContent).toBe('draft');
    expect(body.textContent).toContain('tail');
    expect(body.querySelector('[data-sakutto-run]')).toBeNull();

    restoreSegment(model, created);
    expect(body.innerHTML).toBe(before);
  });

  it('keeps trailing text beside an inline body and translates it', async () => {
    const inner = '<span>Line one<br>Line two</span> NEW';
    const body = gmailBody(inner);
    const before = body.innerHTML;
    const applied = await translateGmailBody(body, droppingBreaksEngine(), {
      targetLanguage: 'ja',
      form: 'polite',
      language: 'en',
      signal: new AbortController().signal,
    });

    expect(applied).toHaveLength(1);
    expect(applied[0]?.model.source).toContain('NEW');
    expect(body.textContent).toContain('NEW');
    expect(body.querySelector('[data-sakutto-run]')).toBeNull();

    for (const entry of applied) restoreSegment(entry.model, entry.created);
    expect(body.innerHTML).toBe(before);
  });

  it('still keeps a real multiline paragraph as one block and maps its lines', () => {
    document.body.innerHTML = '<p id="multi">First line with text<br>Second line with text</p>';
    const paragraph = document.querySelector('#multi');
    if (!paragraph) throw new Error('missing paragraph');
    const before = paragraph.innerHTML;

    const blocks = listTranslatableBlocks(document);
    expect(blocks).toContain(paragraph);
    const model = buildSegment(paragraph);
    if (!model) throw new Error('missing segment');
    expect(model.source).toBe('First line with text\nSecond line with text');

    const created: Text[] = [];
    applyTranslation(model, '§First line with text Second line with text', created);
    const lines = lineTexts(paragraph).filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('§');

    restoreSegment(model, created);
    expect(paragraph.innerHTML).toBe(before);
  });

  it('handles the Outlook reading-pane shape without changing its HTML on restore', async () => {
    document.body.innerHTML = `
      <div data-convid="conv-1" id="message-1">
        <div role="document" aria-label="Message body" lang="en">
          <div dir="ltr">
            <p>Thanks,<br>Alex</p>
            <p>Please review the proposal before Friday.</p>
          </div>
        </div>
      </div>
    `;
    const body = document.querySelector<HTMLElement>('[role="document"]');
    if (!body) throw new Error('missing Outlook body');
    const before = body.innerHTML;

    const applied = await translateOutlookBody(body, droppingBreaksEngine(), {
      targetLanguage: 'ja',
      form: 'polite',
      language: 'en',
      signal: new AbortController().signal,
    });

    expect(applied).toHaveLength(2);
    const thanks = body.querySelector('p');
    if (!thanks) throw new Error('missing paragraph');
    expect(lineTexts(thanks).filter((line) => line.trim().length > 0)).toHaveLength(2);

    for (const entry of applied) restoreSegment(entry.model, entry.created);
    expect(body.innerHTML).toBe(before);
  });
});
