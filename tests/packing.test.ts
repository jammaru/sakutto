// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { PageSession, type PageEngine, type SessionPreferences } from '@/dom/session';
import { estimateTokens } from '@/engine/text/tokens';

const labels = {
  original: '原文',
  chromeNote: 'Chrome の内蔵翻訳',
  machine: 'PLaMo による機械翻訳です。',
  selectionPending: '翻訳しています…',
  selectionFailed: 'この選択範囲を翻訳できませんでした。',
  selectionTitle: '選択したテキスト',
  selectionIcon: '選択したテキストを翻訳します',
  close: '閉じる',
  bilingualOn: 'このサイトの表示を対訳にしました。',
  replaceOn: 'このサイトの表示を置換にしました。',
  barLabel: '翻訳の進み具合',
  barProgress: (done: number, total: number) => `翻訳中 ${String(done)} / ${String(total)}`,
  barRate: (tokens: string, segments: string) => `${tokens} tok/s · ${segments} seg/s`,
  barDone: '翻訳しました。',
  barPartial: (blocks: number) => `翻訳できない箇所が ${String(blocks)} 件残っています。`,
  barOriginal: '原文に戻す',
  barAlways: 'このサイトを常に翻訳します',
  barAlwaysOn: 'このサイトは常に翻訳します。',
};

function preferences(overrides: Partial<SessionPreferences> = {}): SessionPreferences {
  return {
    targetLanguage: 'ja',
    targetExplicit: true,
    form: 'polite',
    display: 'replace',
    auto: 'ask',
    host: 'example.com',
    context: false,
    tier: 'c8',
    pace: 'quality',
    ...overrides,
  };
}

const sessions: PageSession[] = [];

function start(doc: Document, engine: PageEngine): PageSession {
  const session = new PageSession(doc, {
    engine,
    labels,
    preferences: preferences(),
    scheduleFrame: (callback) => callback(),
    debounceMs: 20,
  });
  sessions.push(session);
  return session;
}

afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions.length = 0;
  document.body.innerHTML = '';
  document.documentElement.lang = '';
  document.documentElement.removeAttribute('data-sakutto-source-lang');
});

/** Records the segments of every engine request and answers each line verbatim. */
function recorder(sizes: number[], requests: string[][]): PageEngine {
  return {
    async *translate(segments, options) {
      sizes.push(segments.length);
      requests.push(segments.map((segment) => segment.text));
      for (const segment of segments) {
        if (options.signal.aborted) return;
        yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
      }
    },
  };
}

function manyParagraphs(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `<p id="p${String(index)}">Paragraph ${String(index)} of the list.</p>`,
  ).join('');
}

describe('packed page requests', () => {
  it('packs many short blocks into fewer requests', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = manyParagraphs(24);
    const sizes: number[] = [];
    const requests: string[][] = [];
    const session = start(document, recorder(sizes, requests));

    await session.translate();
    await session.whenIdle();

    expect(requests.length).toBeGreaterThan(1);
    // Twenty-four one-line paragraphs must not cost twenty-four prefills.
    expect(requests.length).toBeLessThan(12);
    expect(Math.max(...sizes)).toBeGreaterThan(1);
  });

  it('paints the first block before the rest of the screen is packed', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = manyParagraphs(12);
    const sizes: number[] = [];
    const session = start(document, recorder(sizes, []));

    await session.translate();
    await session.whenIdle();

    expect(sizes[0]).toBe(1);
    expect(sizes.slice(1).some((size) => size > 1)).toBe(true);
  });

  it('packs blocks that carry inline placeholders with blocks that do not', async () => {
    // Placeholder and plain blocks used to be kept in separate requests, which on a page
    // that alternates between them produced one request per block.
    document.documentElement.lang = 'en';
    document.body.innerHTML = [
      '<p>See <a href="/a">Kyoto</a> today.</p>',
      '<p>Plain sentence here.</p>',
      '<p>Visit <a href="/b">Osaka</a> tomorrow.</p>',
      '<p>Another plain sentence.</p>',
      '<p>Leave <a href="/c">Nara</a> tonight.</p>',
    ].join('');
    const sizes: number[] = [];
    const session = start(document, recorder(sizes, []));

    await session.translate();
    await session.whenIdle();

    expect(sizes.some((size) => size >= 3)).toBe(true);
  });

  it('keeps a block that already spans lines in a request of its own', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<p id="multi">First line with text<br />Second line with text</p><p>Short one.</p>';
    const requests: string[][] = [];
    const sizes: number[] = [];
    const session = start(document, recorder(sizes, requests));

    await session.translate();
    await session.whenIdle();

    const multiline = requests.find((batch) =>
      batch.some((text) => text.includes('First line') && text.includes('Second line')),
    );
    expect(multiline).toHaveLength(1);
    expect(multiline?.[0]).toContain('\n');
  });

  it('trims the page indentation out of a source before packing it', async () => {
    // Real markup indents every cell: a four-word cell is often three hundred characters of
    // newlines and spaces. Kept as-is it inflated the prompt, made the block look long
    // enough to be excluded from packing, and — through the newline rule — put the row in a
    // request of its own.
    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <p id="lead">
        Hello there
      </p>
      <p id="second">
        Another line
      </p>
    `;
    const requests: string[][] = [];
    const session = start(document, recorder([], requests));

    await session.translate();
    await session.whenIdle();

    for (const batch of requests) {
      for (const text of batch) {
        expect(text).not.toMatch(/\n/);
        expect(text).toBe(text.trim());
      }
    }
    expect(document.querySelector('#lead')?.textContent?.trim()).toContain('訳:');
  });

  it('retries a failed packed block on its own so its neighbours are not taken down', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = [
      '<p id="bad">This paragraph always fails.</p>',
      '<p id="good1">A neighbour that should still translate.</p>',
      '<p id="good2">Another neighbour that should translate.</p>',
    ].join('');
    const sizes: number[] = [];
    const session = start(document, {
      async *translate(segments, options) {
        sizes.push(segments.length);
        if (segments.some((segment) => segment.text.includes('always fails'))) {
          throw new Error('model failed');
        }
        for (const segment of segments) {
          if (options.signal.aborted) return;
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      },
    });

    await session.translate();
    await session.whenIdle();

    expect(document.querySelector('#good1')?.textContent).toContain('訳:');
    expect(document.querySelector('#good2')?.textContent).toContain('訳:');
    expect(document.querySelector('#bad')?.textContent).toContain('always fails');
  });

  it('keeps a packed request inside the token budget', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = Array.from(
      { length: 20 },
      (_, index) =>
        `<p>${`Sentence ${String(index)} of a longer block for the page. `.repeat(4)}</p>`,
    ).join('');
    const requests: string[][] = [];
    const session = start(document, recorder([], requests));

    await session.translate();
    await session.whenIdle();

    for (const batch of requests) {
      expect(estimateTokens(batch.join('\n'))).toBeLessThanOrEqual(512);
    }
  });
});

describe('progress reporting', () => {
  it('counts every translated block, not only prose', async () => {
    document.documentElement.lang = 'en';
    // `td` and `div` blocks are classified as chrome, and the bar used to count only prose
    // blocks — so a table-heavy page reported a total that excluded most of its own work.
    document.body.innerHTML = `
      <table><tr><td>Price list</td><td>Stock count</td></tr></table>
      <div>Sidebar copy</div>
      <p>Body paragraph</p>
    `;
    const session = start(document, recorder([], []));

    await session.translate();
    await session.whenIdle();

    const view = session.state();
    expect(view.total).toBeGreaterThanOrEqual(3);
    expect(view.done).toBe(view.total);
    expect(document.documentElement.dataset.sakuttoState).toBe('translated');
  });
});

describe('no stand-in engine on a supported pair', () => {
  const ROW = 'display: grid; grid-template-columns: 3rem 1fr 8rem';

  it('never stamps a table cell with built-in translator text', async () => {
    // The product rule: for a pair PLaMo supports, Chrome output must never be visible page
    // text — not as a draft, a preview, a fallback, or a faded stand-in. A table is where a
    // stand-in would be most tempting, because its cells are short and numerous.
    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <ol>
        ${[1, 2, 3]
          .map(
            (rank) => `
          <li style="${ROW}">
            <span style="display: block">${String(rank)}</span>
            <span style="display: block">Person ${String(rank)}</span>
            <span style="display: block">Japan</span>
          </li>`,
          )
          .join('')}
      </ol>
    `;
    const engines: (string | undefined)[] = [];
    const requests: string[][] = [];
    const session = start(document, {
      async *translate(segments, options) {
        requests.push(segments.map((segment) => segment.text));
        for (const segment of segments) {
          if (options.signal.aborted) return;
          engines.push('plamo');
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      },
    });

    await session.translate();
    await session.whenIdle();

    // Every request went to the model, and no block carries a Chrome stamp.
    expect(engines.every((engine) => engine === 'plamo')).toBe(true);
    expect(document.querySelectorAll('[data-sakutto-engine="chrome"]')).toHaveLength(0);
    expect(document.querySelector('sakutto-note')).toBeNull();
    expect(document.body.textContent).not.toContain('簡易訳');
    // No request asked for a draft or a preview.
    for (const batch of requests) expect(batch.join('')).not.toContain('簡易訳');
  });

  it('leaves a failed cell showing its source instead of another engine', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <ol>
        ${[1, 2, 3]
          .map(
            (rank) => `
          <li style="${ROW}">
            <span style="display: block">${String(rank)}</span>
            <span style="display: block">Person ${String(rank)}</span>
            <span style="display: block">Japan</span>
          </li>`,
          )
          .join('')}
      </ol>
    `;
    const session = start(document, {
      async *translate() {
        throw new Error('model failed');
        yield { id: 'unused', final: '', engine: 'chrome' as const };
      },
    });

    await session.translate();
    await session.whenIdle();

    expect(document.body.textContent).toContain('Person 1');
    expect(document.querySelectorAll('[data-sakutto-engine="chrome"]')).toHaveLength(0);
    expect(document.querySelector('sakutto-note')).toBeNull();
    expect(document.body.textContent).not.toContain('簡易訳');
  });
});
