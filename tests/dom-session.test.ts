// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSegment } from '@/dom/segment';
import { applyTranslation, restoreSegment } from '@/dom/render';
import { PageSession, type PageEngine, type SessionPreferences } from '@/dom/session';
import type { TranslateOptions } from '@/engine/types';

const labels = {
  original: '原文',
  simple: '簡易訳',
  simpleDetail: '簡易訳（Chrome 内蔵）',
  machine: 'PLaMo による機械翻訳です。',
  selectionPending: '翻訳しています…',
  selectionFailed: 'この選択範囲を翻訳できませんでした。',
  selectionTitle: '選択したテキスト',
  close: '閉じる',
  bilingualOn: 'このサイトの表示を対訳にしました。',
  replaceOn: 'このサイトの表示を置換にしました。',
  barLabel: '翻訳の進み具合',
  barProgress: (done: number, total: number) => `翻訳中 ${String(done)} / ${String(total)}`,
  barRate: (tokens: string, segments: string) => `${tokens} tok/s · ${segments} seg/s`,
  barDone: '翻訳しました。',
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

function textNodes(root: ParentNode): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    nodes.push(current as Text);
  }
  return nodes;
}

function snapshot(root: ParentNode): string[] {
  return textNodes(root).map((node) => node.nodeValue ?? '');
}

function engineOf(translate: PageEngine['translate']): PageEngine {
  return { translate };
}

function immediate(
  render: (text: string) => string,
  engine: 'plamo' | 'chrome' = 'plamo',
): PageEngine {
  return engineOf(async function* (segments) {
    for (const segment of segments) {
      yield { id: segment.id, textDelta: '…', engine };
      yield { id: segment.id, final: render(segment.text), engine };
    }
  });
}

const sessions: PageSession[] = [];

function start(
  doc: Document,
  engine: PageEngine,
  overrides: Partial<SessionPreferences> = {},
): PageSession {
  const session = new PageSession(doc, {
    engine,
    labels,
    preferences: preferences(overrides),
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
  document.title = '';
});

describe('segment restore', () => {
  it('rewrites inline text through placeholders and restores every node', () => {
    document.body.innerHTML = '<p>Hello <a href="https://example.com">world</a> today</p>';
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');

    const before = snapshot(block);
    const created: Text[] = [];
    applyTranslation(model, 'こんにちは <i1>世界</i1> です', created);

    expect(block.textContent).toContain('こんにちは');
    expect(block.querySelector('a')?.textContent).toBe('世界');
    expect(block.querySelector('a')?.getAttribute('href')).toBe('https://example.com');

    restoreSegment(model, created);
    for (const node of created) node.remove();
    expect(snapshot(block)).toEqual(before);
  });

  it('does not insert another text node when the same gap is written twice', () => {
    document.body.innerHTML = '<p><a href="/docs">Docs</a></p>';
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');
    const created: Text[] = [];

    applyTranslation(model, '資料 <i1>ドキュメント</i1>', created);
    applyTranslation(model, '資料 <i1>ドキュメント</i1>', created);

    expect(block.textContent).toBe('資料 ドキュメント');
    expect(block.querySelectorAll('a')).toHaveLength(1);
    expect([...block.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)).toHaveLength(
      1,
    );
  });

  it('restores nested inline elements after they are reordered', () => {
    document.body.innerHTML = '<p>Go <span><a href="/a">one</a> and <b>two</b></span></p>';
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');
    const before = [...block.querySelector('span')!.childNodes].map((node) => node.textContent);
    const created: Text[] = [];

    applyTranslation(model, '<i3><i2>二</i2> と <i1>一</i1></i3> 行け', created);
    expect(block.querySelector('b')?.textContent).toBe('二');
    expect(block.querySelector('span')?.firstElementChild?.tagName).toBe('B');

    restoreSegment(model, created);
    expect([...block.querySelector('span')!.childNodes].map((node) => node.textContent)).toEqual(
      before,
    );
    expect(block.querySelector('span')?.firstElementChild?.tagName).toBe('A');
  });

  it('moves inline elements into the translated order and puts them back', () => {
    document.body.innerHTML = '<p>Hello <a href="/a">world</a></p>';
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');
    const link = block.querySelector('a');
    const before = snapshot(block);
    const created: Text[] = [];

    applyTranslation(model, '<i1>世界</i1> こんにちは', created);
    expect(block.firstElementChild).toBe(link);

    restoreSegment(model, created);
    expect(snapshot(block)).toEqual(before);
    expect(block.querySelector('a')).toBe(link);
  });
});

describe('page session', () => {
  it('translates visible text, leaves code untouched, and restores the DOM text', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <p>Hello world</p>
      <pre><code>const answer = 42;</code></pre>
      <p>Run <code>npm test</code> now</p>
      <p translate="no">Do not translate</p>
      <p aria-hidden="true">Hidden label</p>
      <p>https://example.com/docs</p>
    `;
    const code = document.querySelector('code');
    const before = snapshot(document.body);
    const protectedValue = code?.firstChild?.nodeValue;
    let requests = 0;
    const session = start(
      document,
      engineOf(async function* (segments) {
        requests += 1;
        for (const segment of segments) {
          const translated = segment.text
            .replaceAll('Hello world', 'こんにちは')
            .replaceAll('Run', '実行')
            .replaceAll('now', '今');
          yield { id: segment.id, final: translated, engine: 'plamo' };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();

    expect(requests).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('こんにちは');
    expect(document.body.textContent).toContain('実行');
    expect(document.body.textContent).toContain('npm test');
    expect(code?.firstChild?.nodeValue).toBe(protectedValue);
    expect(document.body.textContent).toContain('Do not translate');
    expect(document.body.textContent).toContain('Hidden label');
    expect(document.body.textContent).toContain('https://example.com/docs');

    session.restore();
    expect(snapshot(document.body)).toEqual(before);
    expect(document.querySelector('sakutto-line')).toBeNull();
    expect(document.querySelector('sakutto-note')).toBeNull();
  });

  it('streams plain text and keeps placeholder segments intact until the final text', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello</p><p>See <a href="/docs">docs</a></p>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: '途中', engine: 'plamo' as const };
          if (!segment.text.includes('<i')) {
            await gate;
            if (options.signal.aborted) return;
          }
          yield { id: segment.id, final: `完了 ${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (document.body.textContent?.includes('途中')) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(document.body.textContent).toContain('途中');
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/docs');

    release();
    await session.whenIdle();
    expect(document.body.textContent).toContain('完了');
    expect(document.querySelector('a')?.textContent).toBe('docs');
  });

  it('shows a bilingual line without rewriting the original nodes', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
      { display: 'bilingual' },
    );

    await session.translate();
    await session.whenIdle();

    const paragraph = document.querySelector('p');
    expect(paragraph?.childNodes[0]?.nodeValue).toBe('Hello world');
    expect(document.querySelector('sakutto-line')?.textContent).toContain('訳:Hello world');
  });

  it('labels a built-in translation as a quick translation', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`, 'chrome'),
    );

    await session.translate();
    await session.whenIdle();

    expect(document.querySelector('sakutto-note')?.textContent).toBe('簡易訳');
    document.querySelector('p')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    expect(document.querySelector('sakutto-tip')?.shadowRoot?.textContent).toContain(
      '簡易訳（Chrome 内蔵）',
    );
  });

  it('remembers bilingual mode for the page and can switch back', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const patches: string[] = [];
    const session = new PageSession(document, {
      engine: immediate((text) => `訳:${text}`),
      labels,
      preferences: preferences(),
      scheduleFrame: (callback) => callback(),
      onSitePatch: (patch) => {
        if (patch.display) patches.push(patch.display);
      },
    });
    sessions.push(session);

    await session.translate();
    await session.whenIdle();
    await session.toggleDisplay();

    expect(document.querySelector('p')?.childNodes[0]?.nodeValue).toBe('Hello world');
    expect(document.querySelector('sakutto-line')).not.toBeNull();
    expect(patches).toEqual(['bilingual']);

    await session.toggleDisplay();
    expect(document.querySelector('sakutto-line')).toBeNull();
    expect(document.body.textContent).toContain('訳:Hello world');
  });

  it('skips blocks already written in the target language', async () => {
    document.documentElement.lang = 'ja';
    document.body.innerHTML = '<p>これは日本語です</p><p lang="en">Hello world</p>';
    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          seen.push(segment.text);
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();

    expect(seen).toEqual(['Hello world']);
    expect(document.body.textContent).toContain('これは日本語です');
  });

  it('translates nodes added after the first pass', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
      {},
    );

    await session.translate();
    await session.whenIdle();

    const added = document.createElement('p');
    added.textContent = 'Added later';
    document.body.append(added);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await session.whenIdle();

    expect(added.textContent).toContain('訳:Added later');
  });

  it('interrupts an in-flight page translation for a selection', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const order: string[] = [];
    let releasePage!: () => void;
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        order.push(segments.map((segment) => segment.text).join('|'));
        if (options.priority > 0) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new DOMException('aborted', 'AbortError'));
            if (options.signal.aborted) {
              abort();
              return;
            }
            options.signal.addEventListener('abort', abort, { once: true });
            releasePage = () => resolve();
          });
          if (options.signal.aborted) return;
        }
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    session.translateSelection('Selected phrase', new DOMRect(12, 12, 40, 16));

    let popover = '';
    for (let attempt = 0; attempt < 20 && !popover.includes('訳:Selected phrase'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      popover = document.querySelector('sakutto-pop')?.shadowRoot?.textContent ?? '';
    }

    expect(order[0]).toContain('Hello world');
    expect(order.some((entry) => entry.includes('Selected phrase'))).toBe(true);
    expect(popover).toContain('訳:Selected phrase');
    releasePage();
  });

  it('passes the title and previous block only when context is enabled', async () => {
    document.documentElement.lang = 'en';
    document.title = 'Release notes';
    document.body.innerHTML = `<p>${'First paragraph about the release. '.repeat(12)}</p><p>${'Second paragraph about the release. '.repeat(12)}</p>`;
    const contexts: Array<string | undefined> = [];
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        contexts.push(options.context);
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
      { context: true },
    );

    await session.translate();
    await session.whenIdle();

    expect(contexts.some((context) => context?.includes('Release notes'))).toBe(true);
    expect(contexts.some((context) => context?.includes('First paragraph'))).toBe(true);
  });

  it('splits a long paragraph into sentences before asking the engine', async () => {
    document.documentElement.lang = 'en';
    const sentence = 'This is one sentence about the release. ';
    document.body.innerHTML = `<p>${sentence.repeat(12)}</p>`;
    const ids: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          ids.push(segment.id);
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();

    expect(ids.some((id) => id.includes('#'))).toBe(true);
    expect(document.body.textContent).toContain('訳:');
  });

  it('retries a block that failed before the model was ready', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    let ready = false;
    const session = start(
      document,
      engineOf(async function* (segments) {
        if (!ready) throw new Error('model-missing');
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();
    expect(document.body.textContent).toContain('Hello world');
    expect(document.body.textContent).not.toContain('訳:');

    ready = true;
    session.upgradeChromeSegments();
    await session.whenIdle();
    expect(document.body.textContent).toContain('訳:Hello world');
  });

  it('does not let a late frame paint over a restored page', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const before = snapshot(document.body);
    const frames: Array<() => void> = [];
    const session = new PageSession(document, {
      engine: immediate((text) => `訳:${text}`),
      labels,
      preferences: preferences(),
      scheduleFrame: (callback) => {
        frames.push(callback);
      },
    });
    sessions.push(session);

    await session.translate();
    await session.whenIdle();
    session.restore();
    for (const frame of frames) frame();

    expect(snapshot(document.body)).toEqual(before);
  });

  it('translates the lead paragraph before navigation chrome', async () => {
    document.documentElement.lang = 'en';
    const links = Array.from(
      { length: 24 },
      (_, index) => `<li><a href="#s${String(index)}">Section ${String(index)} Etymology</a></li>`,
    ).join('');
    document.body.innerHTML = `
      <header><nav aria-label="Contents"><ul>${links}</ul></nav></header>
      <aside><div>Appearance</div></aside>
      <main>
        <h1>Osaka</h1>
        <p id="lead">Osaka (<span class="IPA">oːsaka</span>) is a <a href="/city">designated city</a> in Japan.<sup class="reference">[1]</sup></p>
        <p id="mixed">By the Edo period, <span lang="ja">大坂</span> was the commercial center.</p>
        <p id="universities"><a href="/ou">Osaka University</a>, <a href="/omu">Osaka Metropolitan University</a></p>
      </main>
    `;
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      const element = this as Element;
      if (element.closest('main')) return new DOMRect(0, 20, 640, 80);
      return new DOMRect(0, 4000, 200, 24);
    };

    const order: string[] = [];
    const started = performance.now();
    let leadAt = -1;
    const session = start(
      document,
      engineOf(async function* (segments) {
        order.push(segments.map((segment) => segment.text).join('\n'));
        await new Promise((resolve) => setTimeout(resolve, 8));
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
        if (document.querySelector('#lead')?.textContent?.includes('訳:') && leadAt < 0) {
          leadAt = performance.now() - started;
        }
      }),
    );

    try {
      await session.translate();
      await session.whenIdle();

      const leadIndex = order.findIndex((text) => text.includes('designated city'));
      const navIndex = order.findIndex((text) => text.includes('Etymology'));
      expect(leadIndex).toBeGreaterThanOrEqual(0);
      expect(leadIndex).toBeLessThan(3);
      expect(navIndex).toBeGreaterThan(leadIndex);
      expect(order[leadIndex]).toContain('(');
      expect(order[leadIndex]).not.toContain('oːsaka');
      expect(order[leadIndex]).not.toContain('[1]');
      expect(order.some((text) => text.includes('大坂'))).toBe(false);
      expect(order.some((text) => text.includes(', '))).toBe(true);
      expect(leadAt).toBeGreaterThanOrEqual(0);
      expect(leadAt).toBeLessThan(800);
      expect(document.querySelector('#lead .IPA')?.textContent).toBe('oːsaka');
      expect(document.querySelector('#lead sup')?.textContent).toBe('[1]');
      expect(document.querySelector('#mixed')?.textContent).toContain('大坂');
      expect(document.querySelector('#mixed')?.textContent).toContain('訳:');
      expect(document.querySelector('#universities')?.textContent).toContain('Osaka University');
      expect(document.querySelector('#universities')?.textContent).toContain(',');
      expect(document.body.innerHTML).not.toMatch(/<i\d/);
      expect(document.documentElement.lang).toBe('ja');
      expect(document.documentElement.dataset.sakuttoProgress).toMatch(/^\d+\/\d+$/);
      expect(document.documentElement.dataset.sakuttoState).toBe('translated');

      document
        .querySelector('#universities')
        ?.dispatchEvent(
          new PointerEvent('pointerover', { bubbles: true, clientX: 24, clientY: 24 }),
        );
      const tip = document.querySelector('sakutto-tip');
      expect(tip?.shadowRoot?.textContent).toContain('Osaka University, Osaka Metropolitan');
      expect(tip?.shadowRoot?.textContent).not.toContain('UniversityOsaka');
      document.defaultView?.dispatchEvent(new Event('scroll'));
      expect(tip instanceof HTMLElement && tip.hidden).toBe(true);

      session.restore();
      expect(document.documentElement.lang).toBe('en');
      expect(document.documentElement.hasAttribute('data-sakutto-source-lang')).toBe(false);
      expect(document.querySelector('#lead .IPA')?.textContent).toBe('oːsaka');
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
    }
  });

  it('drops a broken placeholder and retries the sentence as plain text', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">See <a href="/osaka">Osaka</a> today.</p>';
    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        const text = segments.map((segment) => segment.text).join('');
        seen.push(text);
        const final = text.includes('<i') ? 'Osaka <i1 today' : `訳:${text}`;
        for (const segment of segments) {
          yield { id: segment.id, final, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();

    expect(seen[0]).toContain('<i1>');
    expect(seen[1]).not.toContain('<i');
    expect(document.body.innerHTML).not.toMatch(/<i\d/);
    expect(document.body.textContent).toContain('訳:');
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/osaka');
  });

  it('runs a selection after the current page chunk and before the next one', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = `<p>${'First paragraph of the page. '.repeat(8)}</p><p>Second paragraph</p>`;
    let releasePage: (() => void) | undefined;
    const calls: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        const label = segments.map((segment) => segment.text).join('|');
        calls.push(`start:${label}`);
        if (label.startsWith('First paragraph')) {
          await new Promise<void>((resolve) => {
            releasePage = resolve;
          });
          if (options.signal.aborted) {
            calls.push('aborted');
            return;
          }
        }
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
        calls.push(`end:${label}`);
      }),
    );

    const pending = session.translate();
    for (
      let attempt = 0;
      attempt < 20 && !calls.some((call) => call.startsWith('start:First paragraph'));
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    session.translateSelection('Selected phrase', new DOMRect(12, 12, 40, 16));
    for (let attempt = 0; attempt < 20 && !calls.includes('end:Selected phrase'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(calls).toContain('start:Selected phrase');
    expect(calls).toContain('end:Selected phrase');
    expect(calls).not.toContain('start:Second paragraph');
    expect(calls).not.toContain('aborted');
    expect(document.querySelector('sakutto-pop')?.shadowRoot?.textContent).toContain(
      '訳:Selected phrase',
    );

    releasePage?.();
    await pending;
    await session.whenIdle();
    expect(calls.some((call) => call.startsWith('end:First paragraph'))).toBe(true);
    expect(calls).toContain('start:Second paragraph');
    expect(document.body.textContent).toContain('訳:Second paragraph');
  });

  it('starts bilingual translation from Alt+B and switches a finished page in place', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const patches: string[] = [];
    let calls = 0;
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        calls += 1;
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
      labels,
      preferences: preferences(),
      scheduleFrame: (callback) => callback(),
      onSitePatch: (patch) => {
        if (patch.display) patches.push(patch.display);
      },
    });
    sessions.push(session);

    await session.handle('bilingual');
    await session.whenIdle();

    expect(patches).toEqual(['bilingual']);
    expect(document.querySelector('sakutto-line')?.textContent).toContain('訳:Hello world');
    expect(document.body.textContent).toContain('Hello world');

    await session.handle('bilingual');
    expect(document.querySelector('sakutto-line')).toBeNull();
    expect(calls).toBe(1);
    expect(patches).toEqual(['bilingual', 'replace']);
  });

  it('packs later linked paragraphs into one request', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = [
      '<p>See <a href="/a">Kyoto</a> today.</p>',
      '<p>Visit <a href="/b">Osaka</a> tomorrow.</p>',
      '<p>Leave <a href="/c">Nara</a> tonight.</p>',
    ].join('');
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () => new DOMRect(0, 20, 640, 80);
    const sizes: number[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        sizes.push(segments.length);
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    try {
      await session.translate();
      await session.whenIdle();
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
    }

    expect(sizes[0]).toBe(1);
    expect(sizes.some((size) => size > 1)).toBe(true);
  });

  it('hides the original tooltip on leave, Escape and restore', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Hello world</p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );

    await session.translate();
    await session.whenIdle();

    const lead = document.querySelector('#lead');
    const show = (): void => {
      lead?.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, clientX: 12, clientY: 12 }),
      );
    };
    const tip = (): HTMLElement => {
      const node = document.querySelector('sakutto-tip');
      if (!(node instanceof HTMLElement)) throw new Error('missing tooltip');
      return node;
    };

    show();
    expect(tip().style.display).not.toBe('none');
    expect(tip().hidden).toBe(false);

    lead?.dispatchEvent(
      new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
    );
    expect(tip().style.display).toBe('none');

    show();
    document.defaultView?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(tip().style.display).toBe('none');

    show();
    document.defaultView?.dispatchEvent(new Event('scroll'));
    expect(tip().style.display).toBe('none');

    show();
    const scroller = document.createElement('div');
    document.body.append(scroller);
    scroller.dispatchEvent(new Event('scroll', { bubbles: false }));
    expect(tip().style.display).toBe('none');

    show();
    session.restore();
    expect(tip().style.display).toBe('none');
  });

  it('keeps the current translation when the URL path stays the same', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world from the article.</p>';
    let aborted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        const segment = segments[0];
        if (!segment) return;
        options.signal.addEventListener('abort', () => {
          aborted = true;
        });
        yield { id: segment.id, textDelta: '訳', engine: 'plamo' };
        await gate;
        if (options.signal.aborted) return;
        yield { id: segment.id, final: '訳文です。', engine: 'plamo' };
      }),
    );

    const pending = session.translate();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (document.body.textContent?.includes('訳')) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(document.body.textContent).toContain('訳');

    const view = document.defaultView;
    view?.history.replaceState({}, '', `${view.location.pathname}${view.location.search}`);
    view?.history.replaceState({}, '', '#section');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aborted).toBe(false);

    release();
    await pending;
    await session.whenIdle();
    expect(document.body.textContent).toContain('訳文です。');
  });

  it('restarts translation when the history path changes', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world from the article.</p>';
    let aborted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        const segment = segments[0];
        if (!segment) return;
        options.signal.addEventListener('abort', () => {
          aborted = true;
        });
        yield { id: segment.id, textDelta: '訳', engine: 'plamo' };
        await gate;
        if (options.signal.aborted) return;
        yield { id: segment.id, final: '訳文です。', engine: 'plamo' };
      }),
    );

    const pending = session.translate();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (document.body.textContent?.includes('訳')) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    document.defaultView?.history.pushState({}, '', '/wiki/Osaka');
    for (let attempt = 0; attempt < 20 && !aborted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(aborted).toBe(true);
    release();
    await pending;
  });

  it('replaces a stuck selection with an error instead of leaving it pending', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const session = start(
      document,
      engineOf(async function* () {
        await Promise.reject(new Error('model failed'));
        yield { id: 'unused', final: '', engine: 'plamo' as const };
      }),
    );

    session.translateSelection('Selected phrase', new DOMRect(8, 8, 24, 12));
    await session.whenIdle();

    const text = document.querySelector('sakutto-pop')?.shadowRoot?.textContent ?? '';
    expect(text).toContain('この選択範囲を翻訳できませんでした。');
    expect(text).not.toContain('翻訳しています…');
  });

  it('replaces a partial selection with the failure message', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const session = start(
      document,
      engineOf(async function* (segments) {
        const segment = segments[0];
        if (!segment) return;
        yield { id: segment.id, textDelta: '途中', engine: 'plamo' as const };
        throw new Error('model failed');
      }),
    );

    session.translateSelection('Selected phrase', new DOMRect(8, 8, 24, 12));
    await session.whenIdle();

    const text = document.querySelector('sakutto-pop')?.shadowRoot?.textContent ?? '';
    expect(text).toContain('この選択範囲を翻訳できませんでした。');
    expect(text).not.toContain('途中');
  });

  it('reports an empty selection translation as a failure', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const session = start(
      document,
      engineOf(async function* (segments) {
        const segment = segments[0];
        if (!segment) return;
        yield { id: segment.id, final: '', engine: 'plamo' as const };
      }),
    );

    session.translateSelection('Selected phrase', new DOMRect(8, 8, 24, 12));
    await session.whenIdle();

    const text = document.querySelector('sakutto-pop')?.shadowRoot?.textContent ?? '';
    expect(text).toContain('この選択範囲を翻訳できませんでした。');
    expect(text).not.toContain('翻訳しています…');
  });

  it('replaces an in-flight Chrome draft after PLaMo becomes ready', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Hello world from the article.</p>';
    const rect = new DOMRect(0, 0, 640, 80);
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let phase: 'chrome' | 'plamo' = 'chrome';
    const session = start(
      document,
      engineOf(async function* (segments) {
        const segment = segments[0];
        if (!segment) return;
        if (phase === 'chrome') {
          yield { id: segment.id, textDelta: '簡易', engine: 'chrome' as const };
          await gate;
          yield { id: segment.id, final: '簡易訳です。', engine: 'chrome' as const };
          return;
        }
        yield { id: segment.id, final: `高品質:${segment.text}`, engine: 'plamo' as const };
      }),
    );

    try {
      const pending = session.translate();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (document.querySelector('#lead')?.textContent?.includes('簡易')) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(document.querySelector('#lead')?.textContent).toContain('簡易');

      phase = 'plamo';
      session.upgradeChromeSegments();
      release();
      await pending;
      await session.whenIdle();

      expect(document.querySelector('#lead')?.textContent).toContain('高品質:');
      expect(document.querySelector('#lead')?.textContent).not.toContain('簡易訳です。');
    } finally {
      spy.mockRestore();
    }
  });

  it('stops page work when the page is hidden', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    let signal: AbortSignal | undefined;
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        signal = options.signal;
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) {
            resolve();
            return;
          }
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (options.signal.aborted) return;
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    const pending = session.translate();
    for (let attempt = 0; attempt < 20 && !signal; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    document.defaultView?.dispatchEvent(new Event('pagehide'));
    await pending;
    await session.whenIdle();

    expect(signal?.aborted).toBe(true);
    expect(document.body.textContent).toContain('Hello world');
    expect(document.body.textContent).not.toContain('訳:');
  });

  it('switches an English page off an English default and restores the language', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const patches: string[] = [];
    const session = new PageSession(document, {
      engine: immediate((text) => `訳:${text}`),
      labels,
      preferences: preferences({ targetLanguage: 'en', targetExplicit: false }),
      scheduleFrame: (callback) => callback(),
      onSitePatch: (patch) => {
        if (patch.targetLanguage) patches.push(patch.targetLanguage);
      },
    });
    sessions.push(session);

    await session.translate();
    await session.whenIdle();

    expect(patches).toEqual(['ja']);
    expect(document.documentElement.lang).toBe('ja');
    expect(document.body.textContent).toContain('訳:Hello world');

    session.restore();
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.hasAttribute('data-sakutto-source-lang')).toBe(false);
  });

  it('keeps navigation on one line in bilingual view and skips the original tooltip', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <nav><ul><li><a href="#etymology">Etymology</a></li></ul></nav>
      <h2>Etymology</h2>
      <p id="lead">Hello world</p>
    `;
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
      { display: 'bilingual' },
    );

    await session.translate();
    await session.whenIdle();

    expect(document.querySelector('#lead sakutto-line')?.textContent).toContain('訳:Hello world');
    expect(document.querySelector('nav sakutto-line')).toBeNull();
    expect(document.querySelector('h2 sakutto-line')).toBeNull();
    expect(document.querySelector('h2')?.textContent).toContain('訳:Etymology');
    expect(document.querySelector('nav')?.textContent).toContain('訳:');
    document
      .querySelector('#lead')
      ?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    const tip = document.querySelector('sakutto-tip');
    expect(tip instanceof HTMLElement && tip.hidden).toBe(true);

    await session.toggleDisplay();
    expect(document.querySelector('sakutto-status')?.textContent).toContain('置換');
  });

  it('translates the lead before a hatnote on the same screen', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <div class="hatnote">For other uses, see Osaka disambiguation and the places that share this name.</div>
      <div id="coordinates">Coordinates 34 north 135 east</div>
      <p id="lead">Osaka is a designated city in the Kansai region.</p>
    `;
    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          seen.push(segment.text);
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();

    expect(seen[0]).toContain('designated city');
    expect(document.querySelector('#lead')?.textContent).toContain('訳:');
  });

  it('translates a selected passage from Alt+S and closes it with Escape', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Osaka is a designated city.</p>';
    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          seen.push(segment.text);
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    const lead = document.querySelector('#lead');
    const range = document.createRange();
    if (!lead) throw new Error('missing lead');
    range.selectNodeContents(lead);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    document.defaultView?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await session.whenIdle();

    expect(seen).toContain('Osaka is a designated city.');
    expect(document.querySelector('sakutto-pop')?.shadowRoot?.textContent).toContain('訳:');

    document.defaultView?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    const popover = document.querySelector('sakutto-pop');
    expect(popover instanceof HTMLElement && popover.hidden).toBe(true);
  });

  it('starts a second pass after restore without waiting for the cancelled pass', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    let calls = 0;
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            if (options.signal.aborted) {
              resolve();
              return;
            }
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return;
        }
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    const first = session.translate();
    for (let attempt = 0; attempt < 20 && calls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    session.restore();
    await first;
    await session.translate();
    await session.whenIdle();

    expect(calls).toBe(2);
    expect(document.body.textContent).toContain('訳:Hello world');
  });

  it('shows a linked paragraph while its translation is still arriving', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">See <a href="/osaka">Osaka</a> today.</p>';
    let release!: () => void;
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        const segment = segments[0];
        if (!segment) return;
        yield { id: segment.id, textDelta: '大阪', engine: 'plamo' as const };
        await new Promise<void>((resolve) => {
          release = resolve;
          if (options.signal.aborted) resolve();
        });
        if (options.signal.aborted) return;
        yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
      }),
    );

    const pending = session.translate();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (document.querySelector('#lead')?.textContent?.includes('大阪')) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(document.querySelector('#lead')?.textContent).toContain('大阪');
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/osaka');

    release();
    await pending;
    await session.whenIdle();
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/osaka');
    expect(document.querySelector('#lead')?.textContent).toContain('訳:');
  });

  it('shows a page bar and restores the original from it', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );

    await session.translate();
    await session.whenIdle();

    const bar = document.querySelector('sakutto-bar');
    expect(bar?.shadowRoot?.textContent).toContain('翻訳しました。');
    expect(document.querySelector('sakutto-bar button')).toBeNull();
    expect(document.documentElement.style.paddingTop).toBe('40px');
    const original = bar?.shadowRoot?.querySelector('button');
    expect(original).toBeInstanceOf(HTMLButtonElement);
    original?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.body.textContent).toContain('Hello world');
    expect(document.querySelector('sakutto-bar') instanceof HTMLElement).toBe(true);
    expect((document.querySelector('sakutto-bar') as HTMLElement).hidden).toBe(true);
    expect(document.documentElement.style.paddingTop).toBe('');
  });
});

describe('page translation corrections', () => {
  it('paints a built-in draft of a linked paragraph and then restores the link', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">See <a href="/osaka">Osaka</a> today.</p>';
    const rect = new DOMRect(0, 0, 120, 24);
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments) {
        const segment = segments[0];
        if (!segment) return;
        yield { id: segment.id, final: '今日の大阪をご覧ください。', engine: 'chrome' };
        await gate;
        yield { id: segment.id, final: '今日の<i1>大阪</i1>をご覧ください。', engine: 'plamo' };
      }),
    );

    try {
      const pending = session.translate();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (document.querySelector('sakutto-note')) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const lead = document.querySelector('#lead');
      expect(lead?.querySelector('sakutto-note')?.textContent).toBe('簡易訳');
      expect(lead?.querySelector('a')?.getAttribute('href')).toBe('/osaka');
      expect(lead?.textContent).toContain('今日の大阪をご覧ください。');

      release();
      await pending;
      await session.whenIdle();
      expect(lead?.querySelector('sakutto-note')).toBeNull();
      expect(lead?.querySelector('a')?.textContent).toBe('大阪');
      expect(lead?.querySelector('a')?.getAttribute('href')).toBe('/osaka');
    } finally {
      spy.mockRestore();
    }
  });

  it('restores the original nodes exactly after a partial paint', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello <a href="/osaka">Osaka</a> today.</p>';
    const before = snapshot(document.body);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        const segment = segments[0];
        if (!segment) return;
        yield { id: segment.id, textDelta: '大阪', engine: 'plamo' };
        await gate;
        if (options.signal.aborted) return;
        yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' };
      }),
    );

    const pending = session.translate();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (document.body.textContent?.includes('大阪')) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(document.body.textContent).toContain('大阪');
    session.restore();
    release();
    await pending;
    expect(snapshot(document.body)).toEqual(before);
  });

  it('does not apply a queued paint after navigation', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const frames: Array<() => void> = [];
    const gates: Array<() => void> = [];
    let started = 0;
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments, options) {
        const segment = segments[0];
        if (!segment) return;
        const mine = ++started;
        yield { id: segment.id, textDelta: `delta${String(mine)}`, engine: 'plamo' };
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        if (options.signal.aborted) return;
        yield { id: segment.id, final: `final${String(mine)}`, engine: 'plamo' };
      }),
      labels,
      preferences: preferences(),
      scheduleFrame: (callback) => {
        frames.push(callback);
      },
      debounceMs: 20,
    });
    sessions.push(session);

    const pending = session.translate();
    for (let attempt = 0; attempt < 20 && frames.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    document.defaultView?.dispatchEvent(new Event('popstate'));
    for (let attempt = 0; attempt < 20 && started < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    frames[0]?.();
    gates[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).not.toContain('delta1');
    expect(document.body.textContent).not.toContain('final1');

    gates[1]?.();
    for (const frame of frames) frame();
    await pending;
    await session.whenIdle();
    expect(document.body.textContent).toContain('final2');
    expect(document.body.textContent).not.toContain('final1');
  });

  it('keeps the detected page language after translating a page with no lang attribute', async () => {
    document.documentElement.lang = '';
    document.body.innerHTML = '<p>Hello world</p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
      {
        targetLanguage: 'en',
        targetExplicit: false,
      },
    );
    session.setDetectedLanguage('en');

    await session.translate();
    await session.whenIdle();

    expect(session.state().pageLanguage).toBe('en');
    expect(session.state().targetLanguage).toBe('ja');
  });

  it('shows the original heading in bilingual mode and leaves body copy alone', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<h2>Title</h2><p>Hello world</p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
      { display: 'bilingual' },
    );

    await session.translate();
    await session.whenIdle();

    document.querySelector('h2')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    const tip = document.querySelector('sakutto-tip');
    expect(tip instanceof HTMLElement && tip.hidden).toBe(false);
    expect(tip?.shadowRoot?.textContent).toContain('Title');

    document.querySelector('sakutto-tip')?.setAttribute('hidden', '');
    if (tip instanceof HTMLElement) tip.hidden = true;
    document.querySelector('p')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    expect(tip instanceof HTMLElement && tip.hidden).toBe(true);
  });

  it('adds the bar height to existing page padding and restores the inline value', async () => {
    document.documentElement.lang = 'en';
    document.documentElement.style.paddingTop = '12px';
    document.body.innerHTML = '<p>Hello world</p>';
    vi.spyOn(document.defaultView!, 'getComputedStyle').mockImplementation(
      () => ({ paddingTop: '12px' }) as CSSStyleDeclaration,
    );
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );

    await session.translate();
    await session.whenIdle();
    expect(document.documentElement.style.paddingTop).toBe('calc(12px + 40px)');

    session.restore();
    expect(document.documentElement.style.paddingTop).toBe('12px');
  });

  it('does not remember the site until access is granted', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const patches: Array<{ auto?: string }> = [];
    let granted = false;
    const session = new PageSession(document, {
      engine: immediate((text) => `訳:${text}`),
      labels,
      preferences: preferences(),
      scheduleFrame: (callback) => callback(),
      debounceMs: 20,
      onGrantSite: async () => granted,
      onSitePatch: (patch) => {
        patches.push(patch);
      },
    });
    sessions.push(session);

    await session.translate();
    await session.whenIdle();
    const always = document.querySelector('sakutto-bar')?.shadowRoot?.querySelectorAll('button')[1];
    always?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.state().auto).toBe('ask');
    expect(patches.some((patch) => patch.auto === 'always')).toBe(false);

    granted = true;
    always?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.state().auto).toBe('always');
    expect(patches.some((patch) => patch.auto === 'always')).toBe(true);
  });

  it('translates one Alt+S request once, including inside a same-origin frame', async () => {
    document.body.innerHTML = '<iframe srcdoc="<p>Inside</p>"></iframe>';
    const frame = document.querySelector('iframe');
    const child = frame?.contentDocument;
    const view = child?.defaultView;
    if (!child || !view) throw new Error('missing frame window');
    child.body.innerHTML = '<p>Inside</p>';
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'Inside',
      getRangeAt: () => ({ getBoundingClientRect: () => new DOMRect(1, 1, 10, 10) }),
    } as unknown as Selection;
    vi.spyOn(child, 'getSelection').mockReturnValue(selection);

    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments) {
        calls += 1;
        const segment = segments[0];
        if (!segment) return;
        await gate;
        yield { id: segment.id, final: '内部', engine: 'plamo' };
      }),
    );

    const press = (): void => {
      view.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 's',
          code: 'KeyS',
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    press();
    await new Promise((resolve) => setTimeout(resolve, 0));
    press();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    release();
    await session.whenIdle();
  });
});
