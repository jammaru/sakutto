// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSegment } from '@/dom/segment';
import { applyTranslation, restoreSegment } from '@/dom/render';
import { SELECTION_ICON_PX, selectionIconBox, translationPageStyle } from '@/dom/overlay';
import { translationStyleKeepsContrast } from '@/dom/overlay';
import { PageSession, type PageEngine, type SessionPreferences } from '@/dom/session';
import type { TranslateOptions } from '@/engine/types';

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

  it('paints a Chrome-only pair without a badge next to the text', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    // Czech is one of the pairs the model does not translate, so the built-in translator
    // is the page's real engine here rather than a stand-in.
    const session = start(
      document,
      immediate((text) => `訳:${text}`, 'chrome'),
      { targetLanguage: 'cs' },
    );

    await session.translate();
    await session.whenIdle();

    expect(document.body.textContent).toContain('訳:Hello world');
    expect(document.querySelector('sakutto-note')).toBeNull();
    expect(document.body.textContent).not.toContain('簡易訳');
    document.querySelector('p')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    expect(document.querySelector('sakutto-tip')?.shadowRoot?.textContent).toContain(
      'Chrome の内蔵翻訳',
    );
  });

  it('paints a Chrome-only pair without a badge on the bilingual line', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`, 'chrome'),
      { targetLanguage: 'cs', display: 'bilingual' },
    );

    await session.translate();
    await session.whenIdle();

    const line = document.querySelector('sakutto-line');
    if (!line) throw new Error('missing bilingual line');
    expect(line.textContent).toBe('訳:Hello world');
    expect(line.querySelector('sakutto-note')).toBeNull();
    expect(document.body.textContent).not.toContain('簡易訳');
    expect(translationPageStyle()).not.toMatch(/sakutto-note/);
    expect(translationPageStyle()).not.toContain('簡易訳');
  });

  it('never requests a built-in draft or preview for a PLaMo pair', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Hello world</p>';
    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        seen.push(
          JSON.stringify(options, (_key, value) =>
            value instanceof AbortSignal ? 'signal' : value,
          ),
        );
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();

    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call).not.toContain('"draft"');
      expect(call).not.toContain('"preview"');
    }
    expect(document.querySelector('#lead')?.textContent).toBe('訳:Hello world');
  });

  it('drops a badge painted into the page by an older build', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<p id="lead">Hello world<sakutto-note data-mode="replace">簡易訳</sakutto-note></p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );

    await session.translate();
    await session.whenIdle();

    expect(document.querySelector('sakutto-note')).toBeNull();
    expect(document.querySelector('#lead')?.textContent).not.toContain('簡易訳');
  });

  it('drops a badge an older build left in a block it had already translated', async () => {
    // An extension update re-injects the content script into a tab whose DOM still holds
    // the old paint: the block already reads as the target language, so the scan skips it
    // and the per-block cleanup never runs. The badge has to be swept away separately.
    document.documentElement.lang = 'ja';
    document.documentElement.setAttribute('data-sakutto-source-lang', 'en');
    document.body.innerHTML =
      '<p id="lead">今日はよく晴れています。<sakutto-note data-mode="replace">簡易訳</sakutto-note></p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );

    await session.translate();
    await session.whenIdle();

    expect(document.querySelector('sakutto-note')).toBeNull();
    expect(document.querySelector('#lead')?.textContent).not.toContain('簡易訳');
  });

  it('drops a badge an older build left inside a bilingual line', async () => {
    document.documentElement.lang = 'ja';
    document.documentElement.setAttribute('data-sakutto-source-lang', 'en');
    document.body.innerHTML =
      '<p id="lead">Hello world<sakutto-line lang="ja">今日はよく晴れています。' +
      '<sakutto-note data-mode="bilingual">簡易訳</sakutto-note></sakutto-line></p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );

    await session.translate();
    await session.whenIdle();

    expect(document.querySelector('sakutto-note')).toBeNull();
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
    session.retryUntranslated();
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

  it('shows no built-in text while PLaMo is still streaming a paragraph', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Hello world from the article.</p>';
    const rect = new DOMRect(0, 0, 640, 80);
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
        await gate;
        yield { id: segment.id, textDelta: '高', engine: 'plamo' as const };
        yield { id: segment.id, final: '高品質の訳です。', engine: 'plamo' as const };
      }),
    );

    try {
      const pending = session.translate();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      // Before PLaMo produces anything the source text stays on the page: no draft.
      const lead = document.querySelector('#lead');
      expect(lead?.textContent).toBe('Hello world from the article.');
      expect(lead?.hasAttribute('data-sakutto-engine')).toBe(false);
      expect(lead?.hasAttribute('data-sakutto-pending')).toBe(true);

      release();
      await pending;
      await session.whenIdle();

      expect(lead?.textContent).toBe('高品質の訳です。');
      expect(lead?.getAttribute('data-sakutto-engine')).toBe('plamo');
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
  it('keeps the source paragraph and its link until PLaMo paints markup', async () => {
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
        await gate;
        yield { id: segment.id, final: '今日の<i1>大阪</i1>をご覧ください。', engine: 'plamo' };
      }),
    );

    try {
      const pending = session.translate();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const lead = document.querySelector('#lead');
      // Nothing has been painted yet, so the paragraph is still its own source text with
      // the link in place. A Chrome draft used to replace it here.
      expect(lead?.textContent).toBe('See Osaka today.');
      expect(lead?.querySelector('sakutto-note')).toBeNull();
      expect(lead?.querySelector('a')?.getAttribute('href')).toBe('/osaka');

      release();
      await pending;
      await session.whenIdle();
      expect(lead?.textContent).toBe('今日の大阪をご覧ください。');
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

function overlapsRect(
  left: number,
  top: number,
  size: number,
  anchor: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>,
): boolean {
  return (
    left < anchor.right &&
    left + size > anchor.left &&
    top < anchor.bottom &&
    top + size > anchor.top
  );
}

describe('selection icon placement', () => {
  it('sits beside a highlight and moves below or above when the edge is tight', () => {
    const besideAnchor = new DOMRect(20, 40, 120, 18);
    const beside = selectionIconBox(besideAnchor, { width: 800, height: 600 });
    expect(overlapsRect(beside.left, beside.top, SELECTION_ICON_PX, besideAnchor)).toBe(false);
    expect(beside.left).toBeGreaterThan(besideAnchor.right);

    const belowAnchor = new DOMRect(160, 40, 30, 18);
    const below = selectionIconBox(belowAnchor, { width: 200, height: 800 });
    expect(overlapsRect(below.left, below.top, SELECTION_ICON_PX, belowAnchor)).toBe(false);
    expect(below.top).toBeGreaterThanOrEqual(belowAnchor.bottom);

    const aboveAnchor = new DOMRect(20, 70, 760, 18);
    const above = selectionIconBox(aboveAnchor, { width: 800, height: 100 });
    expect(overlapsRect(above.left, above.top, SELECTION_ICON_PX, aboveAnchor)).toBe(false);
    expect(above.top + SELECTION_ICON_PX).toBeLessThanOrEqual(aboveAnchor.top);
  });
});

describe('selection icon', () => {
  function icon(): HTMLElement {
    const node = document.querySelector('sakutto-select');
    if (!(node instanceof HTMLElement)) throw new Error('missing selection icon');
    return node;
  }

  function iconButton(): HTMLButtonElement {
    const button = icon().shadowRoot?.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('missing selection button');
    return button;
  }

  async function selectElement(element: Element): Promise<void> {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    if (!selection) throw new Error('missing selection');
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
  });

  it('shows a small icon beside the selection and translates only that text when it is used', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<p id="lead">Osaka is a designated city.</p><p id="next">Leave this page text.</p>';
    const anchor = new DOMRect(20, 40, 120, 18);
    const rects = vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(
      () =>
        ({
          length: 1,
          item: (index: number) => (index === 0 ? anchor : null),
        }) as unknown as DOMRectList,
    );
    const box = vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(anchor);
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments) {
        seen.push(segments.map((segment) => segment.text).join('|'));
        const segment = segments[0];
        if (!segment) return;
        await gate;
        yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
      }),
    );

    try {
      const lead = document.querySelector('#lead');
      if (!lead) throw new Error('missing lead');
      await selectElement(lead);

      expect(seen).toEqual(['Osaka is a designated city.']);
      expect(icon().hidden).toBe(false);
      expect(icon().style.width).toBe(`${String(SELECTION_ICON_PX)}px`);
      expect(icon().style.height).toBe(`${String(SELECTION_ICON_PX)}px`);
      const left = Number.parseFloat(icon().style.left);
      const top = Number.parseFloat(icon().style.top);
      expect(
        overlapsRect(left, top, SELECTION_ICON_PX, {
          left: anchor.left,
          top: anchor.top,
          right: anchor.right,
          bottom: anchor.bottom,
        }),
      ).toBe(false);
      expect(iconButton().getAttribute('aria-label')).toBe('選択したテキストを翻訳します');
      expect(iconButton().querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 128 128');
      expect(iconButton().querySelectorAll('polygon')).toHaveLength(10);
      const popover = document.querySelector('sakutto-pop');
      expect(popover instanceof HTMLElement && popover.hidden).toBe(true);

      release();
      await session.whenIdle();
      expect(popover instanceof HTMLElement && popover.hidden).toBe(true);
      expect(seen).toEqual(['Osaka is a designated city.']);

      iconButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(document.querySelector('sakutto-pop')?.shadowRoot?.textContent).toContain(
        '訳:Osaka is a designated city.',
      );
      expect(seen).toEqual(['Osaka is a designated city.']);
      expect(document.querySelector('#next')?.textContent).toBe('Leave this page text.');
      expect(icon().hidden).toBe(true);
    } finally {
      rects.mockRestore();
      box.mockRestore();
    }
  });

  it('ignores a blank selection and hides the icon when the highlight is cleared or clicked away', async () => {
    document.body.innerHTML = '<p id="blank">   </p><p id="lead">Hello world</p>';
    const seen: string[] = [];
    start(
      document,
      engineOf(async function* (segments) {
        seen.push(segments.map((segment) => segment.text).join('|'));
        yield { id: segments[0]?.id ?? 's', final: '訳', engine: 'plamo' as const };
      }),
    );

    const blank = document.querySelector('#blank');
    const lead = document.querySelector('#lead');
    if (!blank || !lead) throw new Error('missing text');
    await selectElement(blank);
    expect(document.querySelector('sakutto-select') instanceof HTMLElement).toBe(true);
    expect((document.querySelector('sakutto-select') as HTMLElement).hidden).toBe(true);
    expect(seen).toEqual([]);

    await selectElement(lead);
    expect(icon().hidden).toBe(false);
    expect(seen).toEqual(['Hello world']);

    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(icon().hidden).toBe(true);

    await selectElement(lead);
    expect(icon().hidden).toBe(false);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(icon().hidden).toBe(true);

    await selectElement(lead);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
    expect(icon().hidden).toBe(false);

    document.defaultView?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(icon().hidden).toBe(true);
  });

  it('still opens the selection popover from Alt+S and the selection command', async () => {
    document.body.innerHTML = '<p id="lead">Selected phrase</p>';
    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        seen.push(segments.map((segment) => segment.text).join('|'));
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead');
    await selectElement(lead);
    expect(seen).toEqual(['Selected phrase']);
    const popover = (): HTMLElement => {
      const node = document.querySelector('sakutto-pop');
      if (!(node instanceof HTMLElement)) throw new Error('missing popover');
      return node;
    };
    expect(popover().hidden).toBe(true);

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
    expect(popover().hidden).toBe(false);
    expect(popover().shadowRoot?.textContent).toContain('訳:Selected phrase');
    expect(seen).toEqual(['Selected phrase']);

    document.body.innerHTML = '<p id="other">Another phrase</p>';
    const other = document.querySelector('#other');
    if (!other) throw new Error('missing other');
    await selectElement(other);
    await session.handle('selection');
    await session.whenIdle();
    expect(popover().shadowRoot?.textContent).toContain('訳:Another phrase');
    expect(seen).toContain('Another phrase');
    expect(document.body.textContent).toContain('Another phrase');
  });
});

describe('long page translation', () => {
  function longParagraph(id: string, label: string): string {
    return `<p id="${id}">${`${label} stays on its own because it is long. `.repeat(30)}</p>`;
  }

  function installBands(): () => void {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      const id = this.id;
      if (id === 'far') return new DOMRect(0, 5000, 640, 120);
      if (id === 'a' || id === 'b' || id === 'c' || id === 'd') {
        return new DOMRect(0, 40, 640, 120);
      }
      return new DOMRect(0, 0, 0, 0);
    };
    return () => {
      Element.prototype.getBoundingClientRect = original;
    };
  }

  it('translates visible prose before off-screen text with PLaMo alone', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = ['a', 'b', 'c', 'd', 'far']
      .map((id) => longParagraph(id, id === 'far' ? 'Farther' : id.toUpperCase()))
      .join('');
    const restore = installBands();
    const seen: string[] = [];
    const engines: (string | undefined)[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        const text = segments.map((segment) => segment.text).join('\n');
        const label = text.includes('Farther')
          ? 'far'
          : text.includes('A stays')
            ? 'a'
            : text.includes('B stays')
              ? 'b'
              : text.includes('C stays')
                ? 'c'
                : text.includes('D stays')
                  ? 'd'
                  : 'other';
        seen.push(label);
        for (const segment of segments) {
          engines.push('plamo');
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
      { pace: 'fast' },
    );

    try {
      await session.translate();
      await session.whenIdle();
    } finally {
      restore();
    }

    // Every request went to PLaMo: there is no separate preview pass over Chrome.
    expect(engines.every((engine) => engine === 'plamo')).toBe(true);
    const firstVisible = ['b', 'c', 'd']
      .map((label) => seen.indexOf(label))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    expect(firstVisible).toBeGreaterThanOrEqual(0);
    const farAt = seen.indexOf('far');
    if (farAt >= 0) expect(farAt).toBeGreaterThan(firstVisible ?? 0);
    for (const id of ['a', 'b', 'c', 'd', 'far']) {
      expect(document.querySelector(`#${id}`)?.textContent).toContain('訳:');
    }
  });

  it('prefetches further below the fold when the look-ahead is widened', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = [
      longParagraph('a', 'A'),
      longParagraph('b', 'B'),
      longParagraph('far', 'Farther'),
    ].join('');
    const restore = installBands();
    const queuedAtStart: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        const text = segments.map((segment) => segment.text).join('\n');
        const label = text.includes('Farther') ? 'far' : text.includes('B stays') ? 'b' : 'a';
        queuedAtStart.push(label);
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
      { pace: 'fast' },
    );

    try {
      await session.translate();
      await session.whenIdle();
    } finally {
      restore();
    }

    // The widened look-ahead means the off-screen block is queued too, and PLaMo — not a
    // Chrome preview — is what fills it.
    expect(queuedAtStart).toContain('far');
    expect(document.querySelector('#far')?.textContent).toContain('訳:');
    expect(document.querySelector('#far')?.getAttribute('data-sakutto-engine')).toBe('plamo');
  });

  it('streams PLaMo pieces into a long paragraph without a built-in sentence', async () => {
    document.documentElement.lang = 'en';
    const sentence = 'This is one sentence about the release. ';
    document.body.innerHTML = `<p id="lead">${sentence.repeat(12)}</p>`;
    const spy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 20, 640, 80));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paintedBeforePieces: string[] = [];

    try {
      const session = start(
        document,
        engineOf(async function* (segments) {
          const first = segments[0];
          if (!first) return;
          // The paragraph has no text of its own until PLaMo streams its first piece.
          paintedBeforePieces.push(document.querySelector('#lead')?.textContent ?? '');
          await gate;
          for (const segment of segments) {
            yield { id: segment.id, final: `高:${segment.text}`, engine: 'plamo' as const };
          }
        }),
      );

      const pending = session.translate();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (paintedBeforePieces.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      release();
      await pending;
      await session.whenIdle();

      expect(paintedBeforePieces[0]).toContain(sentence.trim());
      expect(paintedBeforePieces[0]).not.toContain('簡易');
      expect(document.querySelector('#lead')?.textContent).toContain('高:');
      expect(document.querySelector('#lead')?.getAttribute('data-sakutto-engine')).toBe('plamo');
    } finally {
      spy.mockRestore();
    }
  });

  it('moves the count while a long paragraph still has pieces left', async () => {
    document.documentElement.lang = 'en';
    const sentence = 'This is one sentence about the release. ';
    document.body.innerHTML = `<p id="lead">${sentence.repeat(12)}</p>`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let yielded = 0;
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          yielded += 1;
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
          if (yielded === 1) await gate;
        }
      }),
    );

    const pending = session.translate();
    for (let attempt = 0; attempt < 30 && session.state().done <= 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const mid = session.state();
    expect(mid.total).toBe(1);
    expect(mid.done).toBeGreaterThan(0);
    expect(mid.done).toBeLessThan(1);
    expect(document.querySelector('#lead')?.getAttribute('data-sakutto-pending')).toBe('1');

    release();
    await pending;
    await session.whenIdle();
    expect(session.state().done).toBe(1);
    expect(session.state().pending).toBe(0);
  });

  it('finishes the rest of the page when one block keeps failing', async () => {
    document.documentElement.lang = 'en';
    const poison = 'Poison paragraph should stay alone. '.repeat(40);
    document.body.innerHTML = `<p id="bad">${poison}</p><p id="good">Hello world</p>`;
    let failures = 0;
    const session = start(
      document,
      engineOf(async function* (segments) {
        const text = segments.map((segment) => segment.text).join('\n');
        if (text.includes('Poison')) {
          failures += 1;
          throw new Error('context overflow');
        }
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();

    expect(failures).toBeGreaterThan(1);
    expect(document.querySelector('#good')?.textContent).toContain('訳:Hello world');
    expect(document.querySelector('#bad')?.textContent).toContain('Poison paragraph');
    expect(session.state().pending).toBe(0);
    // The failed block stayed in English, so the page is not finished. Reporting
    // `translated` here is the false completion the reported page hit.
    expect(session.state().skipped).toBe(1);
    expect(document.documentElement.dataset.sakuttoState).toBe('partial');
  });

  it('keeps a recent rate instead of a lifetime average that collapses during a pause', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<p id="a">Hello world from the article</p><p id="b">Second block of text</p>';
    let now = 1_000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const session = start(
      document,
      engineOf(async function* (segments) {
        now += 800;
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
          now += 800;
        }
      }),
    );

    try {
      await session.translate();
      await session.whenIdle();
      const live = session.state();
      expect(live.tokensPerSecond).not.toBeNull();
      expect(live.segmentsPerSecond).not.toBeNull();
      const tokens = live.tokensPerSecond ?? 0;
      now += 30_000;
      const later = session.state();
      expect(later.tokensPerSecond === null || later.tokensPerSecond >= tokens * 0.5).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('counts batches and pieces for the page bench', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <p id="a">Hello world from the article</p>
      <p id="b">Second block of text</p>
      <p id="c">Third block, also short</p>
    `;
    let batches = 0;
    const session = start(
      document,
      engineOf(async function* (segments) {
        batches += 1;
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();

    const raw = document.querySelector('sakutto-perf')?.textContent ?? '';
    const perf = JSON.parse(raw) as {
      batches: number;
      pieces: number;
      engineMs: number;
    };
    expect(perf.batches).toBe(batches);
    expect(perf.batches).toBeGreaterThan(0);
    // Every translated block is one piece, and pieces can share a batch.
    expect(perf.pieces).toBeGreaterThanOrEqual(perf.batches);
    expect(perf.engineMs).toBeGreaterThanOrEqual(0);
  });

  it('streams PLaMo tokens into an on-screen paragraph that has no built-in draft', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Hello world from the article.</p>';
    const spy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 20, 640, 80));
    const painted: string[] = [];

    try {
      const session = start(
        document,
        engineOf(async function* (segments) {
          const segment = segments[0];
          if (!segment) return;
          for (const delta of ['こんに', 'ちは', '、世界', '。']) {
            yield { id: segment.id, textDelta: delta, engine: 'plamo' as const };
            await new Promise((resolve) => setTimeout(resolve, 0));
            painted.push(document.querySelector('#lead')?.textContent ?? '');
          }
          yield { id: segment.id, final: 'こんにちは、世界。', engine: 'plamo' as const };
        }),
      );

      await session.translate();
      await session.whenIdle();

      expect(painted).toEqual(['こんに', 'こんにちは', 'こんにちは、世界', 'こんにちは、世界。']);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not keep half-decoded fragments as the translation of a failed block', async () => {
    document.documentElement.lang = 'en';
    const sentence = 'This is one sentence about the release. ';
    document.body.innerHTML = `<p id="lead">${sentence.repeat(12)}</p><p id="next">Hello world</p>`;
    const spy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 20, 640, 80));
    let attempts = 0;

    try {
      const session = start(
        document,
        engineOf(async function* (segments) {
          const poison = segments.find((segment) => segment.text.includes('This is one sentence'));
          if (poison) {
            attempts += 1;
            yield { id: poison.id, textDelta: '途中', engine: 'plamo' as const };
            throw new Error('context overflow');
          }
          for (const segment of segments) {
            yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
          }
        }),
      );

      await session.translate();
      await session.whenIdle();

      expect(attempts).toBeGreaterThan(1);
      expect(document.querySelector('#lead')?.textContent).not.toContain('途中');
      expect(document.querySelector('#lead')?.textContent).toContain('This is one sentence');
      expect(document.querySelector('#next')?.textContent).toContain('訳:Hello world');
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * The reported fade: translated Japanese arrived with the right words but at 58% opacity
 * and a `color-mix` gray, so it was harder to read than the English it replaced. These
 * tests pin both paint paths — the stylesheet and the DOM the session writes — so the
 * translation cannot lose contrast again in either display mode.
 */
describe('translated text contrast', () => {
  function styleText(): string {
    return document.querySelector('#sakutto-style')?.textContent ?? '';
  }

  function opacityOf(element: Element): string {
    return getComputedStyle(element).opacity || '1';
  }

  it('never dims, shimmers or mixes color into translated text', () => {
    const css = translationPageStyle();
    expect(translationStyleKeepsContrast(css)).toBe(true);
    expect(css).not.toMatch(/opacity:\s*0?\.\d+/i);
    expect(css).not.toContain('sakutto-shimmer');
    expect(css).not.toContain('color-mix(');
    expect(css).toMatch(/sakutto-line\s*\{[^}]*color:\s*inherit/i);
  });

  it('does not paint over a host block that dims or hides itself', () => {
    // `opacity: 1` on the pending marker read as "full contrast" but overrode the host:
    // a carousel slide at `opacity: 0` popped into view the moment its block started
    // streaming, and a disabled row lost its dimming. The marker must paint nothing.
    expect(translationStyleKeepsContrast(translationPageStyle())).toBe(true);
    expect(translationPageStyle()).not.toMatch(/\[data-sakutto-pending="1"\]\s*\{/);
  });

  it('keeps a streamed block at full opacity while its text is still arriving', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Hello world from the article.</p>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments) {
        const segment = segments[0];
        if (!segment) return;
        yield { id: segment.id, textDelta: 'こんにちは', engine: 'plamo' as const };
        await gate;
        yield { id: segment.id, final: 'こんにちは、世界。', engine: 'plamo' as const };
      }),
    );

    const pending = session.translate();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (document.querySelector('#lead')?.textContent?.includes('こんにちは')) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead');
    expect(lead.getAttribute('data-sakutto-pending')).toBe('1');
    expect(opacityOf(lead)).toBe('1');

    release();
    await pending;
    await session.whenIdle();
    expect(opacityOf(lead)).toBe('1');
  });

  it('does not fade a bilingual line below the original', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Hello world</p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
      { display: 'bilingual' },
    );

    await session.translate();
    await session.whenIdle();

    const line = document.querySelector('#lead sakutto-line');
    if (!line) throw new Error('missing bilingual line');
    expect(opacityOf(line)).toBe('1');
    expect(getComputedStyle(line).color).toBe(getComputedStyle(line.parentElement!).color);
    expect(styleText()).not.toMatch(/sakutto-line[^}]*mix/i);
  });

  it('leaves no pending attribute or badge on a finished PLaMo block', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Hello world from the article.</p>';
    const rect = new DOMRect(0, 20, 640, 80);
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect);

    try {
      const session = start(
        document,
        engineOf(async function* (segments) {
          const segment = segments[0];
          if (!segment) return;
          yield { id: segment.id, final: '高品質の訳です。', engine: 'plamo' as const };
        }),
      );

      await session.translate();
      await session.whenIdle();

      const lead = document.querySelector('#lead');
      if (!lead) throw new Error('missing lead');
      expect(lead.textContent).toBe('高品質の訳です。');
      expect(lead.hasAttribute('data-sakutto-pending')).toBe(false);
      expect(lead.getAttribute('data-sakutto-engine')).toBe('plamo');
      expect(lead.querySelector('sakutto-note')).toBeNull();
      expect(opacityOf(lead)).toBe('1');
    } finally {
      spy.mockRestore();
    }
  });

  it('restores full contrast after a block fails and falls back to its source', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Hello world from the article.</p>';
    const session = start(
      document,
      engineOf(async function* () {
        await Promise.reject(new Error('model failed'));
        yield { id: 'unused', final: '', engine: 'plamo' as const };
      }),
    );

    await session.translate();
    await session.whenIdle();

    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead');
    expect(lead.textContent).toContain('Hello world');
    expect(lead.hasAttribute('data-sakutto-pending')).toBe(false);
    expect(opacityOf(lead)).toBe('1');
  });
});

/**
 * The reported no-op: on Hugging Face model cards the button flipped to "Restore the
 * original" and the bar said the page was translated while the model card, the sidebar
 * and the tabs stayed in English. Both causes are covered here.
 */
describe('whole-page coverage', () => {
  it('translates a sidebar whose short labels have no language of their own', async () => {
    // Hugging Face ships `<html class="">` with no lang attribute at all. The page
    // language is detected separately, and short Latin labels like "spaces" or "docs"
    // carry no script signal, so nothing but an ancestor tag could ever classify them.
    document.documentElement.lang = '';
    document.body.innerHTML = `
      <main><p id="card">Model card body copy stays readable.</p></main>
      <aside>
        <dl><dt id="downloads">Downloads last month</dt><dd>1,305</dd></dl>
        <div id="size">Model size</div>
        <div id="spaces">spaces</div>
        <div id="docs">docs</div>
      </aside>
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
    session.setDetectedLanguage('en');

    await session.translate();
    await session.whenIdle();

    expect(document.querySelector('#card')?.textContent).toContain('訳:');
    expect(document.querySelector('#downloads')?.textContent).toContain('訳:');
    expect(document.querySelector('#size')?.textContent).toContain('訳:');
    expect(document.querySelector('#spaces')?.textContent).toContain('訳:');
    expect(document.querySelector('#docs')?.textContent).toContain('訳:');
    expect(seen).toContain('Downloads last month');
    expect(document.documentElement.dataset.sakuttoState).toBe('translated');
  });

  it('translates a sidebar that mounts after the first scan', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<main><p>Article body</p></main>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );

    await session.translate();
    await session.whenIdle();

    const aside = document.createElement('aside');
    aside.innerHTML = '<p id="late">Downloads last month</p>';
    document.body.append(aside);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await session.whenIdle();

    expect(document.querySelector('#late')?.textContent).toContain('訳:');
  });

  it('repaints a sidebar tab that swaps its content in place', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <main><div id="panel"><p>Overview copy</p></div></main>
    `;
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );

    await session.translate();
    await session.whenIdle();
    expect(document.querySelector('#panel')?.textContent).toContain('訳:Overview copy');

    document.querySelector('#panel')!.innerHTML = '<p>Files and versions</p>';
    await new Promise((resolve) => setTimeout(resolve, 60));
    await session.whenIdle();

    expect(document.querySelector('#panel')?.textContent).toContain('訳:Files and versions');
    expect(document.querySelector('#panel')?.textContent).not.toContain('Overview copy');
  });

  it('does not claim success while visible prose has no translation', async () => {
    document.documentElement.lang = 'en';
    // A block whose requests all fail falls back to its source text and the bar used to
    // say the page was done. A frozen citation is different: the builder keeps it on
    // purpose, so it is not a coverage gap and must not be reported as one.
    document.body.innerHTML = `
      <p id="ok">Readable sentence</p>
      <p id="odd">This paragraph never translates</p>
    `;
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          if (segment.text.includes('never translates')) throw new Error('model failed');
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();

    const view = session.state();
    expect(view.pending).toBe(0);
    expect(view.skipped).toBe(1);
    expect(document.documentElement.dataset.sakuttoState).toBe('partial');
    expect(document.querySelector('#ok')?.textContent).toContain('訳:');
    expect(document.querySelector('#odd')?.textContent).toContain(
      'This paragraph never translates',
    );

    const bar = document.querySelector('sakutto-bar');
    expect(bar?.shadowRoot?.textContent).toContain('翻訳できない箇所が 1 件残っています。');
  });

  it('never reports a frozen citation or a language link as untranslated', async () => {
    // Wikipedia keeps citations, IPA and interlanguage links in inline elements the
    // segment builder leaves alone. Counting them made every real article report
    // "25 parts of this page could not be translated" over a page that was done.
    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <p>Osaka (<span class="IPA">oːsaka</span>) is a city.<sup>[1]</sup></p>
      <ul>
        <li><a lang="af" href="/af">Afrikaans</a></li>
        <li><a lang="de" href="/de">Deutsch</a></li>
      </ul>
      <table><tr><td><span lang="ja">阿倍野区</span></td></tr></table>
    `;
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );

    await session.translate();
    await session.whenIdle();

    expect(session.state().skipped).toBe(0);
    expect(document.documentElement.dataset.sakuttoState).toBe('translated');
  });

  it('reports a fully translated page as translated', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Readable sentence</p><p>Another sentence</p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );

    await session.translate();
    await session.whenIdle();

    expect(session.state().skipped).toBe(0);
    expect(document.documentElement.dataset.sakuttoState).toBe('translated');
  });

  it('finishes a page whose only region has nothing to translate', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<div><pre>const answer = 42;</pre></div>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );

    await session.translate();
    await session.whenIdle();

    expect(session.state().pending).toBe(0);
    expect(document.documentElement.dataset.sakuttoState).toBe('translated');
    expect(document.querySelector('pre')?.textContent).toBe('const answer = 42;');
  });
});

describe('throughput bookkeeping', () => {
  it('keeps the live rate on a long page without re-counting every block per token', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = Array.from(
      { length: 40 },
      (_, index) =>
        `<p id="p${String(index)}">${`Paragraph ${String(index)} has a sentence. `.repeat(8)}</p>`,
    ).join('');
    let now = 1_000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          now += 400;
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    try {
      await session.translate();
      await session.whenIdle();
      const live = session.state();
      expect(live.tokensPerSecond).not.toBeNull();
      expect(live.segmentsPerSecond).not.toBeNull();
      expect(live.pending).toBe(0);
      expect(document.querySelectorAll('[data-sakutto-id]').length).toBeGreaterThan(10);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('coverage reporting does not over-report', () => {
  it('does not count a container whose text belongs to nested blocks', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <nav><ul><li><a href="#a">Etymology</a></li><li><a href="#b">History</a></li></ul></nav>
      <form><p>Your name</p><p>Price</p></form>
      <p>Body copy</p>
    `;
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );

    await session.translate();
    await session.whenIdle();

    expect(session.state().skipped).toBe(0);
    expect(document.documentElement.dataset.sakuttoState).toBe('translated');
  });
});
