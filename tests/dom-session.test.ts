// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTranslationExcluded } from '@/dom/blocks';
import { Revealer } from '@/dom/reveal';
import { REVEAL_STREAM_AFTER_MS } from '@/dom/reveal';
import { buildSegment } from '@/dom/segment';
import { applyTranslation, restoreSegment, showBilingual } from '@/dom/render';
import {
  POPUP_TEXT_SCALE_VAR,
  popupCardMetrics,
  SELECTION_ICON_PX,
  selectionIconBox,
  translationPageStyle,
  translationStyleKeepsContrast,
  uiShadow,
} from '@/dom/overlay';
import {
  PAGE_SHORTCUT_DEDUP_MS,
  PageSession,
  capturePageSelection,
  type PageEngine,
  type SessionPreferences,
} from '@/dom/session';
import { CAPTION_PLAYHEAD_PRIORITY } from '@/captions/engine';
import { CaptionOverlay } from '@/captions/overlay';
import { abortError, modelChangedError } from '@/engine/errors';
import { JobScheduler } from '@/engine/queue/scheduler';
import type { TranslateOptions } from '@/engine/types';

const labels = {
  original: '原文',
  chromeNote: 'Chrome の内蔵翻訳',
  machine: 'PLaMo による機械翻訳です。',
  selectionPending: '翻訳しています…',
  selectionFailed: 'この選択範囲を翻訳できませんでした。',
  selectionTitle: '選択したテキスト',
  selectionIcon: '選択したテキストを翻訳します',
  selectionResize: '翻訳ポップアップの幅を変更します',
  selectionCopy: '訳文をコピー',
  selectionCopied: 'コピーしました',
  selectionCopyFailed: 'コピーできませんでした。訳文を選んでコピーしてください。',
  close: '閉じる',
  bilingualOn: 'このサイトの表示を対訳にしました。',
  replaceOn: 'このサイトの表示を置換にしました。',
  barLabel: '翻訳の進み具合',
  barProgress: (done: number, total: number) => `翻訳中 ${String(done)} / ${String(total)}`,
  barRate: (tokens: string, segments: string) => `${tokens} tok/s · ${segments} seg/s`,
  barDone: '翻訳しました。',
  barPartial: (blocks: number) => `翻訳できない箇所が ${String(blocks)} 件残っています。`,
  modelMissing: '翻訳モデルがありません。ダウンロードしてください。',
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

function stalled(): PageEngine {
  return engineOf(async function* (segments, options) {
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      if (options.signal.aborted) {
        done();
        return;
      }
      options.signal.addEventListener('abort', done, { once: true });
    });
    if (options.signal.aborted) return;
    for (const segment of segments) {
      yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
    }
  });
}

const sessions: PageSession[] = [];

function start(
  doc: Document,
  engine: PageEngine,
  overrides: Partial<SessionPreferences> = {},
  onPopupWidth?: (widthEm: number) => void,
): PageSession {
  const session = new PageSession(doc, {
    engine,
    labels,
    preferences: preferences(overrides),
    scheduleFrame: (callback) => callback(),
    debounceMs: 20,
    ...(onPopupWidth ? { onPopupWidth } : {}),
  });
  sessions.push(session);
  return session;
}

/**
 * A later piece may grow after an earlier piece restarts with a shorter prefix. The
 * already-shown sentences must survive in both the below-fold sentence path and the
 * above-fold token path, whether the chunks land in separate frames or one coalesced
 * frame. Returns the page text after both pieces decoded, after the restart/growth,
 * and after the final settle.
 */
async function multiPieceRestartSnapshots(rect: DOMRect, queuedFrame: boolean): Promise<string[]> {
  document.documentElement.lang = 'en';
  const source =
    'The harbour office logs every crossing and publishes the delays each month. '.repeat(10);
  document.body.innerHTML = `<p>${source}</p>`;
  const block = document.querySelector('p');
  if (!block) throw new Error('missing paragraph');
  block.getBoundingClientRect = () => rect;
  const frames: (() => void)[] = [];
  const shown: string[] = [];
  let reachedFirst!: () => void;
  let reachedSecond!: () => void;
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstReached = new Promise<void>((resolve) => {
    reachedFirst = resolve;
  });
  const secondReached = new Promise<void>((resolve) => {
    reachedSecond = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const session = new PageSession(document, {
    engine: engineOf(async function* (segments) {
      const [first, second] = segments;
      if (!first || !second || segments.length !== 2) throw new Error('expected two pieces');
      yield { id: first.id, textDelta: 'One. Two. ', engine: 'plamo' as const };
      yield { id: second.id, textDelta: 'Three. Four. ', engine: 'plamo' as const };
      reachedFirst();
      await firstGate;
      yield { id: first.id, textDelta: 'One. ', restart: true, engine: 'plamo' as const };
      yield { id: second.id, textDelta: 'Five. Six. ', engine: 'plamo' as const };
      reachedSecond();
      await secondGate;
      yield { id: first.id, final: 'One. Two. ', engine: 'plamo' as const };
      yield { id: second.id, final: 'Three. Four. Five. Six. ', engine: 'plamo' as const };
    }),
    labels,
    preferences: preferences({ reveal: 'sentence', targetLanguage: 'de' }),
    scheduleFrame: queuedFrame
      ? (callback) => {
          frames.push(callback);
        }
      : (callback) => callback(),
    debounceMs: 20,
  });
  sessions.push(session);
  const flush = (): void => {
    while (frames.length > 0) frames.shift()?.();
  };

  await session.translate();
  let idleReached = false;
  const idle = session.whenIdle().then(() => {
    idleReached = true;
  });
  await firstReached;
  if (queuedFrame) flush();
  shown.push(block.textContent ?? '');
  releaseFirst();
  await secondReached;
  if (queuedFrame) {
    // A below-fold sentence write goes through the revealer, which leaves off-screen
    // entries resting until the next input; run the paint frame, then wake it so the
    // queued write is applied before the snapshot.
    flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified' }));
    flush();
  }
  shown.push(block.textContent ?? '');
  releaseSecond();
  if (queuedFrame) {
    for (let attempt = 0; attempt < 20 && !idleReached; attempt += 1) {
      flush();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await idle;
  shown.push(block.textContent ?? '');
  return shown;
}

afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions.length = 0;
  document.body.innerHTML = '';
  document.documentElement.lang = '';
  document.title = '';
  Reflect.deleteProperty(document, 'hidden');
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

  it('distributes flattened CJK output across bilingual source paragraphs', () => {
    document.body.innerHTML =
      '<div data-testid="tweetText"><span>一つ目の短い段落</span><br /><br />' +
      '<span>二つ目の少し長めの段落です</span><br /><br /><span>三つ目の段落</span></div>';
    const block = document.querySelector('[data-testid="tweetText"]');
    if (!block) throw new Error('missing tweet');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');

    showBilingual(model, '最初の訳文二番目の訳文です最後の訳文', []);

    const line = block.querySelector('sakutto-line');
    const chunks = Array.from(line?.childNodes ?? [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue ?? '');
    expect(line?.querySelectorAll('br')).toHaveLength(4);
    expect(chunks).toHaveLength(5);
    expect(chunks[0]?.trim()).not.toBe('');
    expect(chunks[2]?.trim()).not.toBe('');
    expect(chunks[4]?.trim()).not.toBe('');
    expect(chunks.join('')).toBe('最初の訳文二番目の訳文です最後の訳文');
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

  it('keeps page nodes and page translation out of the caption overlay host', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <div id="player">
        <h1 id="title">A trip through Hokkaido</h1>
        <div id="author">Rail films</div>
        <div id="potato">Potato recipes</div>
        <div id="eye">👀 12,345 views</div>
        <div id="si">SI</div>
        <video></video>
      </div>
    `;
    const player = document.querySelector('#player');
    if (!(player instanceof HTMLElement)) throw new Error('missing player');
    const overlay = new CaptionOverlay(document, {
      label: 'Translated captions',
      pending: 'Translating caption…',
      showOriginal: 'Show original caption',
      hideOriginal: 'Hide original caption',
    });
    overlay.attach(player);
    overlay.show({
      original: 'The station opens at dawn.',
      translation: '駅は夜明けに開きます。',
      display: 'bilingual',
      pending: false,
    });
    const host = player.querySelector('sakutto-captions');
    if (!(host instanceof HTMLElement)) throw new Error('missing caption host');
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
    overlay.show({
      original: 'A red train waits at platform two.',
      translation: '赤い列車が二番線に停まっています。',
      display: 'bilingual',
      pending: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await session.whenIdle();

    const lines = [...(overlay.shadow()?.querySelectorAll('.line') ?? [])];
    expect(lines.map((line) => line.textContent)).toEqual([
      'A red train waits at platform two.',
      '赤い列車が二番線に停まっています。',
    ]);
    expect(host.textContent).toBe('');
    expect(host.childNodes).toHaveLength(0);
    expect(host.querySelector('#title, #author, #potato, #eye, #si')).toBeNull();
    for (const id of ['title', 'author', 'potato', 'eye', 'si']) {
      const element = document.getElementById(id);
      expect(element).not.toBeNull();
      expect(host.contains(element)).toBe(false);
    }
    for (const caption of [
      'The station opens at dawn.',
      '駅は夜明けに開きます。',
      'A red train waits at platform two.',
      '赤い列車が二番線に停まっています。',
    ]) {
      expect(seen.every((source) => !source.includes(caption))).toBe(true);
    }
    overlay.detach();
  });

  it('clears the navigation stop after a persisted BFCache restore', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );

    window.dispatchEvent(new Event('pagehide'));
    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);

    await session.handle('toggle');
    await session.whenIdle();

    expect(document.body.textContent).toContain('訳:Hello world');
  });

  it('captures the document selection before later awaits can clear it', () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Hello world</p>';
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead');
    const range = document.createRange();
    range.selectNodeContents(lead);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const snapshot = capturePageSelection(document);
    expect(snapshot?.text).toBe('Hello world');
    expect(snapshot?.rect).toBeInstanceOf(DOMRect);

    selection?.removeAllRanges();
    expect(capturePageSelection(document)).toBeNull();
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

  it('keeps the source while a block is translated when finished blocks are swapped', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello</p>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let streamed = false;
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: '途中', engine: 'plamo' as const };
          streamed = true;
          await gate;
          if (options.signal.aborted) return;
          yield { id: segment.id, final: '完了', engine: 'plamo' as const };
        }
      }),
      { reveal: 'smooth' },
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(streamed).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).toBe('Hello');

    release();
    await session.whenIdle();
    expect(document.body.textContent).toBe('完了');
  });

  it('writes each finished sentence in sentence mode and settles the block once', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>First source sentence. Second source sentence.</p>';
    const reserve = vi.spyOn(Revealer.prototype, 'reserve');
    const settle = vi.spyOn(Revealer.prototype, 'settle');
    let afterFirst: string | null = null;
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: 'One. ', engine: 'plamo' as const };
          afterFirst = (document.body.textContent ?? '').trim();
          await new Promise((resolve) => setTimeout(resolve, 0));
          yield { id: segment.id, textDelta: 'Two.', engine: 'plamo' as const };
          yield { id: segment.id, final: 'One. Two.', engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();
    expect(afterFirst).toBe('One.');
    expect(document.body.textContent?.trim()).toBe('One. Two.');
    expect(reserve).toHaveBeenCalledTimes(1);
    // The final paint settles the block; `complete` releases any leftover reservation.
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it('writes the first paragraph on screen at once without a reveal frame', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>First source. Second source.</p>';
    const paragraph = document.querySelector('p');
    if (!paragraph) throw new Error('missing paragraph');
    paragraph.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    const offer = vi.spyOn(Revealer.prototype, 'offer');
    let afterFirst: string | null = null;
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: 'One. ', engine: 'plamo' as const };
          afterFirst = (document.body.textContent ?? '').trim();
          yield { id: segment.id, final: 'One. Two.', engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();
    expect(afterFirst).toBe('One.');
    expect(offer).not.toHaveBeenCalled();
    expect(document.body.textContent?.trim()).toBe('One. Two.');
  });

  it('keeps a bilingual line growing as sentences arrive in sentence mode', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>First source. Second source.</p>';
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: 'One. ', engine: 'plamo' as const };
          await new Promise((resolve) => setTimeout(resolve, 0));
          yield { id: segment.id, final: 'One. Two.', engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence', display: 'bilingual' },
    );

    await session.translate();
    await session.whenIdle();
    expect(document.querySelector('p')?.textContent).toContain('First source.');
    expect(document.querySelector('sakutto-line')?.textContent?.trim()).toBe('One. Two.');
  });

  it('does not fade a bilingual sentence line the reader has already seen', async () => {
    document.documentElement.lang = 'en';
    // Two visible blocks: the second one is not the first on screen, so its final text
    // gets the settle motion rather than being written at once.
    document.body.innerHTML =
      '<p style="height:40px">Opening source.</p>' +
      '<p style="height:80px">First source. Second source.</p>';
    const blocks = [...document.querySelectorAll('p')];
    const opening = blocks[0];
    const block = blocks[1];
    if (!opening || !block) throw new Error('missing paragraphs');
    opening.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    block.getBoundingClientRect = () => new DOMRect(0, 60, 300, 80);
    // The final settle can fade the block, dimming the line through its ancestor.
    // Watch every animation on the block, on its subtree (each write recreates the
    // line) and on its ancestors.
    const originalAnimate = Element.prototype.animate;
    const fades: { element: Element; frames: Keyframe[] }[] = [];
    Element.prototype.animate = function (this: Element, frames: Keyframe[]) {
      if (
        (this === block || block.contains(this) || this.contains(block)) &&
        frames.some((frame) => frame.opacity !== undefined)
      ) {
        fades.push({ element: this, frames });
      }
      return { pause() {}, cancel() {}, currentTime: 0 } as unknown as Animation;
    } as typeof Element.prototype.animate;

    try {
      const session = start(
        document,
        engineOf(async function* (segments) {
          for (const segment of segments) {
            if (segment.text === 'Opening source.') {
              yield { id: segment.id, final: 'Opening.', engine: 'plamo' as const };
              continue;
            }
            yield { id: segment.id, textDelta: 'One. ', engine: 'plamo' as const };
            await new Promise((resolve) => setTimeout(resolve, 0));
            yield { id: segment.id, final: 'One. Two.', engine: 'plamo' as const };
          }
        }),
        { reveal: 'sentence', display: 'bilingual' },
      );

      await session.translate();
      await session.whenIdle();
      expect(block.querySelector('sakutto-line')?.textContent?.trim()).toBe('One. Two.');
      // The final settle must not fade a line the reader has already been reading,
      // directly or through the block or an ancestor of it.
      expect(fades.map(({ element, frames }) => ({ element: element.localName, frames }))).toEqual(
        [],
      );
    } finally {
      Element.prototype.animate = originalAnimate;
    }
  });

  it('keeps the source until a sentence terminator arrives, then writes only finished sentences', async () => {
    document.documentElement.lang = 'en';
    const source = 'First source. Second source.';
    document.body.innerHTML = `<p>${source}</p>`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let afterUnterminated: string | null = null;
    let afterTail: string | null = null;
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: 'Hel', engine: 'plamo' as const };
          afterUnterminated = document.querySelector('p')?.textContent ?? null;
          await gate;
          if (options.signal.aborted) return;
          yield { id: segment.id, textDelta: 'lo. Tw', engine: 'plamo' as const };
          afterTail = document.querySelector('p')?.textContent ?? null;
          yield { id: segment.id, final: 'Hello. Two.', engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(afterUnterminated).not.toBeNull();
    });
    expect(afterUnterminated).toBe(source);

    release();
    await vi.waitFor(() => {
      expect(afterTail).not.toBeNull();
    });
    expect(afterTail).toBe('Hello.');

    await session.whenIdle();
    expect(document.querySelector('p')?.textContent).toBe('Hello. Two.');
  });

  it('does not join a piece without a terminator to a later piece in sentence mode', async () => {
    document.documentElement.lang = 'en';
    const source =
      'The harbour office logs every crossing and publishes the delays each month. '.repeat(10);
    document.body.innerHTML = `<p>${source}</p>`;
    let afterLaterPiece: string | null = null;
    let afterUnterminatedPiece: string | null = null;
    const session = start(
      document,
      engineOf(async function* (segments) {
        const [first, second] = segments;
        if (!first || !second || segments.length !== 2) throw new Error('expected two pieces');
        // The later piece has whole sentences while the first has no text yet.
        yield { id: second.id, textDelta: '出発。到着。', engine: 'plamo' as const };
        afterLaterPiece = document.querySelector('p')?.textContent ?? null;
        // A prefix without a terminator still may not close against the later piece.
        yield { id: first.id, textDelta: '港の事務所は', engine: 'plamo' as const };
        afterUnterminatedPiece = document.querySelector('p')?.textContent ?? null;
        yield { id: first.id, final: '港の事務所は出発。', engine: 'plamo' as const };
        yield { id: second.id, final: '到着。', engine: 'plamo' as const };
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();
    expect(afterLaterPiece).toBe(source);
    expect(afterUnterminatedPiece).toBe(source);
    expect(document.querySelector('p')?.textContent).toBe('港の事務所は出発。到着。');
  });

  it('streams unterminated tokens into a visible sentence-mode block at once', async () => {
    document.documentElement.lang = 'en';
    const source = 'First source sentence. Second source sentence.';
    document.body.innerHTML = `<p id="lead">${source}</p>`;
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    const reserve = vi.spyOn(Revealer.prototype, 'reserve');
    const offer = vi.spyOn(Revealer.prototype, 'offer');
    let afterUnterminated: string | null = null;
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: 'Hel', engine: 'plamo' as const };
          afterUnterminated = document.querySelector('p')?.textContent ?? null;
          yield { id: segment.id, textDelta: 'lo. Tw', engine: 'plamo' as const };
          yield { id: segment.id, final: 'Hello. Two.', engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();
    // The first delta has no sentence terminator, yet it is already on the page: this is
    // the above-fold fast path that brings first visible text back to stream-mode speed.
    expect(afterUnterminated).toBe('Hel');
    expect(reserve).toHaveBeenCalled();
    // The write happens in the paint frame we are already in; no second reveal frame.
    expect(offer).not.toHaveBeenCalled();
    expect(document.querySelector('p')?.textContent).toBe('Hello. Two.');
  });

  it('writes the first fast-path token without waiting for a paint frame', async () => {
    document.documentElement.lang = 'en';
    const source =
      'The harbour office logs every crossing and publishes the delays each month. '.repeat(6);
    document.body.innerHTML = `<p id="lead">${source}</p>`;
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead paragraph');
    lead.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    const frames: (() => void)[] = [];
    let afterFirst: string | null = null;
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: '最初の節', engine: 'plamo' as const };
          afterFirst = lead.textContent ?? '';
          yield { id: segment.id, final: '最初の節。次の節。', engine: 'plamo' as const };
        }
      }),
      labels,
      preferences: preferences({ reveal: 'sentence' }),
      scheduleFrame: (callback) => {
        frames.push(callback);
      },
      debounceMs: 20,
    });
    sessions.push(session);

    await session.translate();
    await vi.waitFor(() => {
      expect(afterFirst).not.toBeNull();
    });
    // The prefix has no clause or sentence terminator. It is on the page in the same
    // turn as the decoded chunk, with no paint frame having run for this block.
    expect(afterFirst).toBe('最初の節');

    let idle = false;
    const done = session.whenIdle().then(() => {
      idle = true;
    });
    for (let attempt = 0; attempt < 30 && !idle; attempt += 1) {
      while (frames.length > 0) frames.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await done;
    expect(lead.textContent).toBe('最初の節。次の節。');
  });

  it('writes the first chunk of a visible heading without a paint frame or a clause', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<main><h1 id="title">What the tide gauges recorded during the outage</h1></main>';
    const title = document.querySelector('#title');
    if (!title) throw new Error('missing title');
    title.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    const frames: (() => void)[] = [];
    const reserve = vi.spyOn(Revealer.prototype, 'reserve');
    const offer = vi.spyOn(Revealer.prototype, 'offer');
    let afterFirst: string | null = null;
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        for (const segment of segments) {
          // No terminator and no clause mark: the old sentence path held this chunk
          // until the final, which made the page's first paint wait for the heading.
          yield { id: segment.id, textDelta: '停電中に潮位計が記録した', engine: 'plamo' as const };
          afterFirst = title.textContent ?? '';
          yield { id: segment.id, final: '停電中に潮位計が記録した値。', engine: 'plamo' as const };
        }
      }),
      labels,
      preferences: preferences({ reveal: 'sentence' }),
      scheduleFrame: (callback) => {
        frames.push(callback);
      },
      debounceMs: 20,
    });
    sessions.push(session);

    await session.translate();
    await vi.waitFor(() => {
      expect(afterFirst).not.toBeNull();
    });
    expect(afterFirst).toBe('停電中に潮位計が記録した');
    expect(frames).toHaveLength(0);
    expect(reserve).toHaveBeenCalledWith(title);
    expect(offer.mock.calls.some(([call]) => call.block === title)).toBe(false);

    let idle = false;
    const done = session.whenIdle().then(() => {
      idle = true;
    });
    for (let attempt = 0; attempt < 30 && !idle; attempt += 1) {
      while (frames.length > 0) frames.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await done;
    expect(title.textContent).toBe('停電中に潮位計が記録した値。');
  });

  it('paints the first chunk and first clause of a split long paragraph without a frame', async () => {
    document.documentElement.lang = 'en';
    const long =
      'When the survey closed the team expected a few hundred replies and received slightly more than four thousand, which was more than enough to make the original plan of reading every answer by hand impossible. '.repeat(
        8,
      );
    document.body.innerHTML =
      '<h1 id="title">A single paragraph about the survey</h1>' +
      '<p id="byline">Methods notebook / 24 October</p>' +
      '<p id="long">' +
      long +
      '</p>';
    for (const block of document.querySelectorAll('h1, p')) {
      block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    }
    const lead = document.querySelector('#long');
    if (!lead) throw new Error('missing long paragraph');
    const source = lead.textContent ?? '';
    const pieces: string[][] = [];
    const reserve = vi.spyOn(Revealer.prototype, 'reserve');
    const offer = vi.spyOn(Revealer.prototype, 'offer');
    const frames: (() => void)[] = [];
    const shown: string[] = [];
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        pieces.push(segments.map((segment) => segment.text));
        for (const segment of segments) {
          if (!segment.text.includes('When the survey closed')) {
            yield { id: segment.id, final: '見出し', engine: 'plamo' as const };
            continue;
          }
          yield { id: segment.id, textDelta: '調査が閉じたとき', engine: 'plamo' as const };
          shown.push(lead.textContent ?? '');
          yield { id: segment.id, textDelta: '、チームは数百件', engine: 'plamo' as const };
          shown.push(lead.textContent ?? '');
          yield { id: segment.id, textDelta: 'の回答を予想していた、', engine: 'plamo' as const };
          shown.push(lead.textContent ?? '');
          yield { id: segment.id, final: '訳:長い最初の文。次の文。', engine: 'plamo' as const };
        }
      }),
      labels,
      preferences: preferences({ reveal: 'sentence' }),
      scheduleFrame: (callback) => {
        frames.push(callback);
      },
      debounceMs: 20,
    });
    sessions.push(session);

    await session.translate();
    await vi.waitFor(() => {
      expect(shown.length).toBeGreaterThan(0);
    });
    expect(pieces.flat().length).toBeGreaterThan(1);
    // All three snapshots are read in the decode turn, before any queued frame runs:
    // the first chunk paints at once, the next one waits for a clause, and the clause
    // paints at once. No paint frame or flush timer stands before the first two words.
    expect(shown.slice(0, 3)).toEqual([
      '調査が閉じたとき',
      '調査が閉じたとき',
      '調査が閉じたとき、チームは数百件の回答を予想していた、',
    ]);
    expect(reserve).toHaveBeenCalledWith(lead);
    expect(offer.mock.calls.some(([call]) => call.block === lead)).toBe(false);

    let idle = false;
    const done = session.whenIdle().then(() => {
      idle = true;
    });
    for (let attempt = 0; attempt < 30 && !idle; attempt += 1) {
      while (frames.length > 0) frames.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await done;
    expect(lead.textContent).toContain('訳:長い最初の文。次の文。');
    expect(document.querySelector('#long')?.textContent).not.toBe(source);
  });

  it('writes the first chunk of a late-mounted visible paragraph without a frame', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<main><p id="early">The early article body is short.</p></main>';
    const frames: (() => void)[] = [];
    let lateAfterFirst: string | null = null;
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: '最初の節、', engine: 'plamo' as const };
          if (segment.text.includes('late')) {
            lateAfterFirst = document.querySelector('#late')?.textContent ?? null;
          }
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
      labels,
      preferences: preferences({ reveal: 'sentence' }),
      scheduleFrame: (callback) => {
        frames.push(callback);
      },
      debounceMs: 20,
    });
    sessions.push(session);

    await session.translate();
    let idle = false;
    let done = session.whenIdle().then(() => {
      idle = true;
    });
    for (let attempt = 0; attempt < 30 && !idle; attempt += 1) {
      while (frames.length > 0) frames.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await done;

    const late = document.createElement('p');
    late.id = 'late';
    late.textContent = 'A late paragraph mounted after the first paint of the article.';
    late.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    document.querySelector('main')?.append(late);

    await vi.waitFor(() => {
      expect(lateAfterFirst).not.toBeNull();
    });
    expect(lateAfterFirst).toBe('最初の節、');
    expect(frames).toHaveLength(0);

    idle = false;
    done = session.whenIdle().then(() => {
      idle = true;
    });
    for (let attempt = 0; attempt < 30 && !idle; attempt += 1) {
      while (frames.length > 0) frames.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await done;
    expect(late.textContent).toContain('訳:');
  });

  it('requests and paints the main paragraph before model-card tags and chrome', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<header><p id="logo">Meridian Hub</p>' +
      '<nav><ul><li id="nav-1">Models</li><li id="nav-2">Datasets</li></ul></nav></header>' +
      '<div class="tabs"><p id="tab-1">Model card</p><p id="tab-2">Files and versions</p></div>' +
      '<div class="layout"><div class="column">' +
      '<h1 id="title">riverlight / plamo-diffusion-1b</h1>' +
      '<p id="subtitle">A masked diffusion language model fine-tuned for short document translation and released for research.</p>' +
      '<ul class="tags"><li id="tag-1">diffusion</li><li id="tag-2">translation</li><li id="tag-3">multilingual</li></ul>' +
      '<p id="lead">This model converts an autoregressive checkpoint into a masked diffusion decoder and drops the causal mask before sampling.</p>' +
      '</div><aside><h2 id="aside-title">Model details</h2><dl><dt id="dt-size">Model size</dt><dd id="dd-size">0.8B params</dd></dl></aside></div>';
    for (const element of document.querySelectorAll('p, li, dt, dd, h1, h2')) {
      element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    }
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead paragraph');
    const tag = document.querySelector('#tag-1');
    if (!tag) throw new Error('missing tag');
    const frames: (() => void)[] = [];
    const batches: string[][] = [];
    let leadAfterFirst: string | null = null;
    let tagAfterFirst: string | null = null;
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        batches.push(segments.map((segment) => segment.text));
        for (const segment of segments) {
          if (segment.text.includes('autoregressive')) {
            yield { id: segment.id, textDelta: '最初の節', engine: 'plamo' as const };
            leadAfterFirst = lead.textContent ?? '';
            tagAfterFirst = tag.textContent ?? '';
            yield { id: segment.id, final: '最初の節。次の節。', engine: 'plamo' as const };
          } else {
            yield {
              id: segment.id,
              final: `訳:${segment.text.slice(0, 4)}`,
              engine: 'plamo' as const,
            };
          }
        }
      }),
      labels,
      preferences: preferences({ reveal: 'sentence' }),
      scheduleFrame: (callback) => {
        frames.push(callback);
      },
      debounceMs: 20,
    });
    sessions.push(session);

    await session.translate();
    await vi.waitFor(() => {
      expect(leadAfterFirst).not.toBeNull();
    });
    // The tag cloud and the row of tabs sit before the lead in document order, but
    // they are labels, not body copy: they neither take an early model slot nor a
    // fast-path slot. The lead decodes with the subtitle and paints its first prefix.
    const leadBatch = batches.findIndex((texts) =>
      texts.some((text) => text.includes('autoregressive')),
    );
    const tagBatch = batches.findIndex((texts) => texts.includes('diffusion'));
    const tabBatch = batches.findIndex((texts) => texts.includes('Model card'));
    expect(leadBatch).toBeGreaterThanOrEqual(0);
    expect(tagBatch).toBeGreaterThan(leadBatch);
    expect(tabBatch).toBeGreaterThan(leadBatch);
    expect(leadAfterFirst).toBe('最初の節');
    expect(tagAfterFirst).toBe('diffusion');

    let idle = false;
    const done = session.whenIdle().then(() => {
      idle = true;
    });
    for (let attempt = 0; attempt < 30 && !idle; attempt += 1) {
      while (frames.length > 0) frames.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await done;
    expect(lead.textContent).toBe('最初の節。次の節。');
  });

  it('flushes a long first sentence of the lead paragraph past a visible heading and byline', async () => {
    document.documentElement.lang = 'en';
    const long =
      'When the survey closed the team expected a few hundred replies and received slightly more than four thousand which was more than enough to make the original plan of reading every answer by hand impossible';
    document.body.innerHTML =
      '<h1 id="title">A single paragraph about the survey</h1>' +
      '<p id="byline">Methods notebook / 24 October</p>' +
      '<p id="long">' +
      long +
      '. A second sentence follows here.</p>';
    for (const block of document.querySelectorAll('h1, p')) {
      block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    }
    const lead = document.querySelector('#long');
    if (!lead) throw new Error('missing long paragraph');
    const source = lead.textContent ?? '';
    const reserve = vi.spyOn(Revealer.prototype, 'reserve');
    const offer = vi.spyOn(Revealer.prototype, 'offer');
    const settle = vi.spyOn(Revealer.prototype, 'settle');
    const first: string[] = [];
    const second: string[] = [];
    const clause: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          if (!segment.text.includes('When the survey closed')) {
            yield { id: segment.id, final: '見出し', engine: 'plamo' as const };
            continue;
          }
          yield { id: segment.id, textDelta: '調査が閉じたとき', engine: 'plamo' as const };
          first.push(lead.textContent ?? '');
          yield { id: segment.id, textDelta: '、チームは数百件', engine: 'plamo' as const };
          second.push(lead.textContent ?? '');
          yield { id: segment.id, textDelta: 'の回答を予想していた、', engine: 'plamo' as const };
          clause.push(lead.textContent ?? '');
          yield { id: segment.id, final: '訳:長い最初の文。次の文。', engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();

    // No sentence terminator has decoded at either partial write. The heading and byline
    // are prose to the segment builder but must not spend the fast-path slot budget.
    expect(first[0]).toBe('調査が閉じたとき');
    // The next token lands in the same paint burst; the budget holds it back.
    expect(second[0]).toBe('調査が閉じたとき');
    // A clause arrives before any terminator and is written at once, still in reserved height.
    expect(clause[0]).toBe('調査が閉じたとき、チームは数百件の回答を予想していた、');
    expect(reserve).toHaveBeenCalledWith(lead);
    expect(offer.mock.calls.some(([call]) => call.block === lead)).toBe(false);
    expect(lead.textContent).toBe('訳:長い最初の文。次の文。');
    // This lead painted into a reservation, so its final settle stays cheap.
    const onLead = settle.mock.calls.filter(([target]) => target === lead);
    expect(onLead.some(([, , motion]) => motion?.cheap === true)).toBe(true);
    expect(document.querySelector('#long')?.textContent).not.toBe(source);
  });

  it('keeps the cheap final fade for the first body paragraph under a heading', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<h1 id="title">A survey of readers</h1>' +
      '<p id="lead">A single long paragraph that streams its first tokens into a reserved box.</p>';
    for (const block of document.querySelectorAll('h1, p')) {
      block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    }
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead paragraph');
    const settle = vi.spyOn(Revealer.prototype, 'settle');
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: 'First', engine: 'plamo' as const };
          yield { id: segment.id, final: 'First sentence. Second.', engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();
    // A heading above it does not make this the "instant" first block: it painted into
    // reserved height, so settle must use the cheap fade, not measure/glide the screen.
    const onLead = settle.mock.calls.filter(([target]) => target === lead);
    expect(onLead.length).toBeGreaterThan(0);
    expect(onLead.some(([, , motion]) => motion?.cheap === true)).toBe(true);
  });

  it('flushes held fast-path text when the decode time budget expires without another chunk', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<p>Hello world, a source long enough to keep this paragraph in the first paint.</p>';
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    const clock = vi.spyOn(performance, 'now');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        for (const segment of segments) {
          clock.mockReturnValue(1000);
          yield { id: segment.id, textDelta: 'Hel', engine: 'plamo' as const };
          clock.mockReturnValue(1000);
          yield { id: segment.id, textDelta: 'lo. Tw', engine: 'plamo' as const };
          held.push(block?.textContent ?? '');
          // Decode stalls here: no later chunk queues a paint. Only the clock moves on.
          clock.mockReturnValue(1000 + 41);
          await gate;
          if (options.signal.aborted) return;
          yield { id: segment.id, final: 'Hello. Two.', engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    for (let attempt = 0; attempt < 50 && held.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(held).toEqual(['Hel']);
    for (let attempt = 0; attempt < 50 && block?.textContent !== 'Hello. Tw'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The 40 ms budget fired on its own timer, with no comma and no following chunk.
    expect(block?.textContent).toBe('Hello. Tw');
    release();
    await session.whenIdle();
    expect(block?.textContent).toBe('Hello. Two.');
    clock.mockRestore();
  });

  it('keeps the third visible model-card paragraph in sentence discipline', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<header><h1 id="title">riverlight / plamo-diffusion-1b</h1></header>' +
      '<p id="subtitle">A masked diffusion language model fine-tuned for short document translation.</p>' +
      '<p id="p1">This model converts an autoregressive checkpoint into a masked diffusion decoder and drops the causal mask.</p>' +
      '<p id="p2">The practical effect for translation is that latency depends on the number of refinement steps.</p>';
    const subtitle = document.querySelector('#subtitle');
    const p1 = document.querySelector('#p1');
    const p2 = document.querySelector('#p2');
    if (!subtitle || !p1 || !p2) throw new Error('missing model card paragraphs');
    for (const block of document.querySelectorAll('h1, p')) {
      block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    }
    const snapshots: Record<string, string> = {};
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          const name = segment.text.includes('riverlight')
            ? 'title'
            : segment.text.includes('masked diffusion')
              ? 'subtitle'
              : segment.text.includes('autoregressive')
                ? 'p1'
                : 'p2';
          if (name === 'title') {
            yield { id: segment.id, final: 'モデル', engine: 'plamo' as const };
            continue;
          }
          const target = name === 'subtitle' ? subtitle : name === 'p1' ? p1 : p2;
          yield { id: segment.id, textDelta: '最初の節、', engine: 'plamo' as const };
          if (!(name in snapshots)) snapshots[name] = target.textContent ?? '';
          if (name === 'p2') {
            // A later unterminated delta must still wait, even after the first chunk.
            yield { id: segment.id, textDelta: 'まだ途中', engine: 'plamo' as const };
            expect(p2.textContent).toBe('最初の節、');
          }
          yield { id: segment.id, final: '訳:最初の節。次の節。', engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();

    expect(snapshots['subtitle']).toBe('最初の節、');
    // The third visible body block has no fast-path slot, but its first decoded chunk
    // is the page's first painted word on a page with a slow lead: it goes straight to
    // the page. Only the text after that first chunk stays in sentence discipline.
    expect(snapshots['p2']).toBe('最初の節、');
    expect(subtitle.textContent).toBe('訳:最初の節。次の節。');
    expect(p1.textContent).toBe('訳:最初の節。次の節。');
    expect(p2.textContent).toBe('訳:最初の節。次の節。');
  });
  it('does not show a later piece before an earlier one in a visible block', async () => {
    document.documentElement.lang = 'en';
    const source =
      'The harbour office logs every crossing and publishes the delays each month. '.repeat(10);
    document.body.innerHTML = `<p>${source}</p>`;
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    let afterLaterPiece: string | null = null;
    let afterUnterminatedPiece: string | null = null;
    const session = start(
      document,
      engineOf(async function* (segments) {
        const [first, second] = segments;
        if (!first || !second || segments.length !== 2) throw new Error('expected two pieces');
        // The later piece has whole sentences while the first has no text yet. The
        // visible fast path may not write it on its own (B1).
        yield { id: second.id, textDelta: '出発。到着。', engine: 'plamo' as const };
        afterLaterPiece = document.querySelector('p')?.textContent ?? null;
        yield { id: first.id, textDelta: '港の事務所は', engine: 'plamo' as const };
        afterUnterminatedPiece = document.querySelector('p')?.textContent ?? null;
        yield { id: first.id, final: '港の事務所は出発。', engine: 'plamo' as const };
        yield { id: second.id, final: '到着。', engine: 'plamo' as const };
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();
    expect(afterLaterPiece).toBe(source);
    expect(afterUnterminatedPiece).toBe('港の事務所は出発。到着。');
    expect(document.querySelector('p')?.textContent).toBe('港の事務所は出発。到着。');
  });

  it('does not let a restart replace text already shown in a visible block', async () => {
    document.documentElement.lang = 'en';
    const source = 'First source. Second source.';
    document.body.innerHTML = `<p>${source}</p>`;
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    const shown: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: 'One. Two.', engine: 'plamo' as const };
          shown.push(document.querySelector('p')?.textContent ?? '');
          yield { id: segment.id, textDelta: 'On', restart: true, engine: 'plamo' as const };
          shown.push(document.querySelector('p')?.textContent ?? '');
          yield { id: segment.id, final: 'One. Three.', engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();
    // A restart's shorter prefix must not replace the sentences the reader already saw.
    expect(shown).toEqual(['One. Two.', 'One. Two.']);
    expect(document.querySelector('p')?.textContent).toBe('One. Three.');
  });

  it('keeps earlier sentences when a later piece grows after an earlier piece restarts below the fold', async () => {
    const shown = await multiPieceRestartSnapshots(new DOMRect(0, 2400, 300, 40), false);
    expect(shown).toEqual([
      'One. Two. Three. Four.',
      'One. Two. Three. Four. Five. Six.',
      'One. Two. Three. Four. Five. Six.',
    ]);
  });

  it('keeps earlier tokens when a later piece grows after an earlier piece restarts above the fold', async () => {
    const shown = await multiPieceRestartSnapshots(new DOMRect(0, 0, 300, 40), false);
    expect(shown).toEqual([
      'One. Two. Three. Four.',
      'One. Two. Three. Four. Five. Six.',
      'One. Two. Three. Four. Five. Six.',
    ]);
  });

  it('keeps shown sentences when a restart and later growth share one visible frame', async () => {
    const shown = await multiPieceRestartSnapshots(new DOMRect(0, 0, 300, 40), true);
    expect(shown).toEqual([
      'One. Two. Three. Four.',
      'One. Two. Three. Four. Five. Six.',
      'One. Two. Three. Four. Five. Six.',
    ]);
  });

  it('keeps shown sentences when a restart and later growth share one below-fold frame', async () => {
    const shown = await multiPieceRestartSnapshots(new DOMRect(0, 2400, 300, 40), true);
    expect(shown).toEqual([
      'One. Two. Three. Four.',
      'One. Two. Three. Four. Five. Six.',
      'One. Two. Three. Four. Five. Six.',
    ]);
  });

  it('keeps sentence discipline for a block below the fold', async () => {
    document.documentElement.lang = 'en';
    const source = 'First source sentence. Second source sentence.';
    document.body.innerHTML = `<p id="tail">${source}</p>`;
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    block.getBoundingClientRect = () => new DOMRect(0, 2400, 300, 40);
    let afterUnterminated: string | null = null;
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: 'Hel', engine: 'plamo' as const };
          afterUnterminated = document.querySelector('p')?.textContent ?? null;
          yield { id: segment.id, textDelta: 'lo. Tw', engine: 'plamo' as const };
          yield { id: segment.id, final: 'Hello. Two.', engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();
    expect(afterUnterminated).toBe(source);
    expect(document.querySelector('p')?.textContent).toBe('Hello. Two.');
  });

  it('reserves the source height of a visible block before the first token arrives', async () => {
    document.documentElement.lang = 'en';
    const source = 'First source sentence. Second source sentence.';
    document.body.innerHTML = `<p id="lead">${source}</p>`;
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    const seenAtReserve: (string | null)[] = [];
    const reserve = vi.spyOn(Revealer.prototype, 'reserve').mockImplementation((el: Element) => {
      seenAtReserve.push(el.textContent ?? null);
    });
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: 'Hel', engine: 'plamo' as const };
          yield { id: segment.id, final: 'Hello. Two.', engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();
    expect(reserve).toHaveBeenCalled();
    // Measured while the source was still in the box, never after a token replaced it.
    expect(seenAtReserve[0]).toBe(source);
  });

  it('gives a later visible block only a cheap fade at the final settle', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<p id="first">Opening source.</p><p id="second">First source. Second source.</p>';
    const first = document.querySelector('#first');
    const second = document.querySelector('#second');
    if (!first || !second) throw new Error('missing paragraphs');
    first.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    second.getBoundingClientRect = () => new DOMRect(0, 60, 300, 40);
    const settle = vi.spyOn(Revealer.prototype, 'settle');
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: 'Hel', engine: 'plamo' as const };
          yield { id: segment.id, final: 'Hello.', engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();
    const onSecond = settle.mock.calls.filter(([block]) => block === second);
    expect(onSecond.length).toBeGreaterThan(0);
    expect(onSecond.some(([, , motion]) => motion?.cheap === true)).toBe(true);
  });

  it('reports request, token and paint milestones on sakutto-perf', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world from the article</p>';
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: 'Hel', engine: 'plamo' as const };
          yield { id: segment.id, final: 'Hello world.', engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();
    const raw = document.querySelector('sakutto-perf')?.textContent ?? '';
    const perf = JSON.parse(raw) as {
      startedAt: number;
      firstRequestAt: number | null;
      firstTokenAt: number | null;
      firstDomWriteAt: number | null;
      requestMs: number | null;
      ttfbMs: number | null;
      paintMs: number | null;
      domWriteMs: number | null;
    };
    expect(perf.firstRequestAt).not.toBeNull();
    expect(perf.firstTokenAt).not.toBeNull();
    expect(perf.firstDomWriteAt).not.toBeNull();
    expect(perf.firstRequestAt).toBeGreaterThanOrEqual(perf.startedAt);
    expect(perf.firstTokenAt!).toBeGreaterThanOrEqual(perf.firstRequestAt!);
    expect(perf.firstDomWriteAt!).toBeGreaterThanOrEqual(perf.firstTokenAt!);
    // The three stages account for the time to the first painted word.
    // Stages are rounded separately, so allow a millisecond of drift.
    expect(
      Math.abs(perf.requestMs! + perf.ttfbMs! + perf.paintMs! - perf.domWriteMs!),
    ).toBeLessThanOrEqual(2);
    expect(perf.domWriteMs).toBeGreaterThanOrEqual(0);
  });

  it('tells the reveal which translations are the last of the page', async () => {
    document.documentElement.lang = 'en';
    const long = 'The harbour office logs every crossing and publishes the delays each month. ';
    document.body.innerHTML = Array.from(
      { length: 6 },
      (_, index) => `<p>${String(index)} ${long.repeat(6)}</p>`,
    ).join('');
    const offers = vi.spyOn(Revealer.prototype, 'offer');
    const session = start(
      document,
      immediate((text) => `訳 ${text.slice(0, 1)}`),
      { reveal: 'smooth' },
    );

    await session.translate();
    await session.whenIdle();
    const last = offers.mock.calls.map(([offer]) => offer.last === true);
    expect(last.length).toBeGreaterThanOrEqual(6);
    // While other requests run or wait, a block is not the last; the one that ends the page is.
    expect(last[0]).toBe(false);
    expect(last.at(-1)).toBe(true);
  });

  it('counts a finished block as pending until its text is on the page', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello</p>';
    const frames: (() => void)[] = [];
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, final: '完了', engine: 'plamo' as const };
        }
      }),
      labels,
      preferences: preferences({ reveal: 'smooth' }),
      scheduleFrame: (callback) => frames.push(callback),
      debounceMs: 20,
    });
    sessions.push(session);
    let idle = false;

    await session.translate();
    await vi.waitFor(() => {
      expect(session.state().pending).toBe(1);
      expect(frames.length).toBeGreaterThan(0);
    });
    void session.whenIdle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).toBe('Hello');
    expect(idle).toBe(false);

    while (frames.length > 0) frames.shift()?.();
    await vi.waitFor(() => {
      expect(idle).toBe(true);
    });
    expect(document.body.textContent).toBe('完了');
    expect(session.state().pending).toBe(0);
  });

  it('does not resolve a waiting idle call when a language change replaces a pending reveal', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello</p>';
    const frames: (() => void)[] = [];
    const prefs = preferences({ reveal: 'smooth' });
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, final: '完了', engine: 'plamo' as const };
        }
      }),
      labels,
      preferences: prefs,
      scheduleFrame: (callback) => frames.push(callback),
      debounceMs: 20,
    });
    sessions.push(session);
    let idle = false;

    await session.translate();
    await vi.waitFor(() => {
      expect(session.state().pending).toBe(1);
    });
    void session.whenIdle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(idle).toBe(false);

    // The reveal is cleared before the replacement batch is queued.
    session.setPreferences({ ...prefs, targetLanguage: 'de' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(idle).toBe(false);
    expect(session.state().pending).toBeGreaterThan(0);

    while (frames.length > 0) frames.shift()?.();
    await vi.waitFor(() => {
      expect(idle).toBe(true);
    });
    expect(session.state().pending).toBe(0);
  });

  it('does not resolve a waiting idle call when a language change aborts a running request', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello</p>';
    const prefs = preferences();
    let started!: () => void;
    const firstStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments) {
        started();
        await gate;
        for (const segment of segments) {
          yield { id: segment.id, final: '完了', engine: 'plamo' as const };
        }
      }),
      prefs,
    );
    let idle = false;

    await session.translate();
    await firstStart;
    void session.whenIdle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(idle).toBe(false);
    expect(session.state().pending).toBe(1);

    // The language change aborts the in-flight request before the replacements are
    // enqueued. An idle observation in that gap must not release the waiter.
    session.setPreferences({ ...prefs, targetLanguage: 'de' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(idle).toBe(false);
    expect(session.state().pending).toBeGreaterThan(0);

    release();
    await vi.waitFor(() => {
      expect(idle).toBe(true);
    });
    expect(session.state().pending).toBe(0);
  });

  it('does not resolve whenIdle before an in-place block change is registered', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello</p>';
    const frames: (() => void)[] = [];
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, final: '完了', engine: 'plamo' as const };
        }
      }),
      labels,
      preferences: preferences({ reveal: 'smooth' }),
      scheduleFrame: (callback) => frames.push(callback),
      debounceMs: 20,
    });
    sessions.push(session);
    let idle = false;

    await session.translate();
    await vi.waitFor(() => {
      expect(session.state().pending).toBe(1);
    });
    void session.whenIdle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(idle).toBe(false);

    // An SPA changes the source of a block whose final text is still waiting in the revealer.
    const block = document.querySelector('p');
    if (!block || !(block.firstChild instanceof Text)) throw new Error('missing block text');
    block.firstChild.nodeValue = 'New source';
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(idle).toBe(false);
    expect(session.state().pending).toBeGreaterThan(0);

    // The replacement is a new job: let its final text reach the revealer before
    // releasing the frame that writes it.
    await vi.waitFor(() => {
      expect(frames.length).toBeGreaterThan(0);
    });
    for (let attempt = 0; attempt < 10 && !idle; attempt += 1) {
      while (frames.length > 0) frames.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(idle).toBe(true);
    expect(session.state().pending).toBe(0);
  });

  it('writes a translation that waits to be shown when the page navigates in place', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello</p>';
    const frames: (() => void)[] = [];
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, final: '完了', engine: 'plamo' as const };
        }
      }),
      labels,
      preferences: preferences({ reveal: 'smooth' }),
      scheduleFrame: (callback) => frames.push(callback),
      debounceMs: 20,
    });
    sessions.push(session);

    await session.translate();
    await vi.waitFor(() => {
      expect(session.state().pending).toBe(1);
    });
    expect(document.body.textContent).toBe('Hello');

    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(document.body.textContent).toBe('完了');
  });

  it('streams a block that is still being translated long after its first text', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello</p>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clock = vi.spyOn(performance, 'now');
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        for (const segment of segments) {
          clock.mockReturnValue(1000);
          yield { id: segment.id, textDelta: '途', engine: 'plamo' as const };
          clock.mockReturnValue(1000 + REVEAL_STREAM_AFTER_MS + 1);
          yield { id: segment.id, textDelta: '中', engine: 'plamo' as const };
          await gate;
          if (options.signal.aborted) return;
          yield { id: segment.id, final: '完了', engine: 'plamo' as const };
        }
      }),
      { reveal: 'smooth' },
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('途中');
    });

    release();
    await session.whenIdle();
    expect(document.body.textContent).toBe('完了');
    clock.mockRestore();
  });

  it('starts to stream a block early when its speed says it will be slow', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = `<p>${'A sentence of the source text. '.repeat(8)}</p>`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clock = vi.spyOn(performance, 'now');
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        for (const segment of segments) {
          clock.mockReturnValue(1000);
          yield { id: segment.id, textDelta: '訳文のはじめの部分', engine: 'plamo' as const };
          // A second and a half in, a tenth of the expected text is there: at that speed
          // the block takes much longer than a reader should look at the source.
          clock.mockReturnValue(2500);
          yield { id: segment.id, textDelta: 'です', engine: 'plamo' as const };
          await gate;
          if (options.signal.aborted) return;
          yield { id: segment.id, final: '完了', engine: 'plamo' as const };
        }
      }),
      { reveal: 'smooth' },
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('訳文のはじめの部分です');
    });

    release();
    await session.whenIdle();
    expect(document.body.textContent).toBe('完了');
    clock.mockRestore();
  });

  it('expects English to take about twice the letters of its Japanese source', async () => {
    document.documentElement.lang = 'ja';
    // Fifty-four letters of Japanese.
    document.body.innerHTML = `<p>${'フェリーは七時に島を出て、潮が変わる前に戻ってきます。'.repeat(2)}</p>`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clock = vi.spyOn(performance, 'now');
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        for (const segment of segments) {
          clock.mockReturnValue(1000);
          yield { id: segment.id, textDelta: 'The ferry leaves at ', engine: 'plamo' as const };
          // Twenty-four letters in a second. Of a translation as long as the source that is
          // nearly half, and the block would be finished soon; of one twice as long it is not.
          clock.mockReturnValue(2000);
          yield { id: segment.id, textDelta: 'four', engine: 'plamo' as const };
          await gate;
          if (options.signal.aborted) return;
          yield { id: segment.id, final: 'Done', engine: 'plamo' as const };
        }
      }),
      { reveal: 'smooth', targetLanguage: 'en' },
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('The ferry leaves at four');
    });

    release();
    await session.whenIdle();
    expect(document.body.textContent).toBe('Done');
    clock.mockRestore();
  });

  /**
   * Three paragraphs. The first one comes at `firstMs` for its twenty letters, which tells
   * the page how fast a block comes. The second gets eight letters, then waits `waitMs`
   * before its next letter, and is held open until `release` is called. A second paragraph
   * of many `sentences` is sent as several pieces: only the first of them starts, unless
   * they come `sideBySide`. The third paragraph gets a letter beside the second one, as where
   * many requests are decoded at a time, unless the second is decoded `alone`.
   */
  function afterOneBlock(
    firstMs: number,
    waitMs: number,
    sentences = 3,
    sideBySide = false,
    alone = false,
  ): { session: PageSession; second: () => Element | undefined; release: () => void } {
    document.documentElement.lang = 'en';
    const first = 'The ferry leaves the island at seven and is back before the tide turns.';
    const long = 'The harbour office logs every crossing of the season and reads it back. '
      .repeat(sentences)
      .trim();
    // Too long to share a request with another block.
    const third = 'The lighthouse keeper writes the weather into the same book each night. '
      .repeat(5)
      .trim();
    document.body.innerHTML = `<p>${first}</p><p>${long}</p><p>${third}</p>`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The third paragraph may be asked for in a request of its own: it waits there for the
    // second one to begin.
    let begin!: () => void;
    const begun = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const beside = (segment: { text: string }): boolean => segment.text.includes('lighthouse');
    // The two paragraphs can be asked for in two requests that run side by side: the second
    // one starts when the first has finished and the page knows its speed.
    let learned!: () => void;
    const known = new Promise<void>((resolve) => {
      learned = resolve;
    });
    const clock = vi.spyOn(performance, 'now');
    clock.mockReturnValue(1000);
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        for (const segment of segments) {
          if (segment.text.includes('tide')) {
            clock.mockReturnValue(1000);
            yield { id: segment.id, textDelta: 'フェリーは七時に島を', engine: 'plamo' as const };
            clock.mockReturnValue(1000 + firstMs);
            yield { id: segment.id, textDelta: '出て潮の前に戻ります', engine: 'plamo' as const };
            yield {
              id: segment.id,
              final: 'フェリーは七時に島を出て潮の前に戻ります',
              engine: 'plamo' as const,
            };
            learned();
            continue;
          }
          const pieces = segments.filter((piece) => !piece.text.includes('tide') && !beside(piece));
          const neighbour = segments.find(beside);
          if (beside(segment)) {
            if (pieces.length > 0) continue;
            // In a request of its own.
            await begun;
            if (!alone) yield { id: segment.id, textDelta: '灯', engine: 'plamo' as const };
            await gate;
            if (options.signal.aborted) return;
            yield { id: segment.id, final: '灯台', engine: 'plamo' as const };
            continue;
          }
          if (segment !== pieces[0]) continue;
          await known;
          const from = 1000 + firstMs + 100;
          clock.mockReturnValue(from);
          for (const piece of sideBySide ? pieces : [segment]) {
            yield { id: piece.id, textDelta: '港の事務所は毎回', engine: 'plamo' as const };
          }
          if (neighbour && !alone) {
            yield { id: neighbour.id, textDelta: '灯', engine: 'plamo' as const };
          }
          begin();
          // The request of the third paragraph, if it has one, sends its letter now.
          await new Promise((resolve) => setTimeout(resolve, 0));
          clock.mockReturnValue(from + waitMs);
          yield { id: segment.id, textDelta: 'の', engine: 'plamo' as const };
          await gate;
          if (options.signal.aborted) return;
          for (const piece of pieces) {
            yield { id: piece.id, final: '完了', engine: 'plamo' as const };
          }
          if (neighbour) yield { id: neighbour.id, final: '灯台', engine: 'plamo' as const };
        }
      }),
      { reveal: 'smooth' },
    );
    return { session, second: () => document.querySelectorAll('p')[1], release };
  }

  it('does not take a block for slow that waited after its first letters, as blocks here do', async () => {
    // Finished blocks came at a tenth of a letter a millisecond. The second block has nine
    // letters after 2.5 s: by its own speed it would take half a minute, at the speed of the
    // page under a second more.
    const { session, second, release } = afterOneBlock(200, 2500);
    await session.translate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(second()?.textContent).toContain('The harbour office');
    expect(second()?.textContent).not.toContain('港の事務所');

    release();
    vi.mocked(performance.now).mockRestore();
    await session.whenIdle();
    expect(second()?.textContent).toBe('完了');
  });

  it('takes a long block by the piece of it that lacks the most while the others can still start', async () => {
    // Twenty letters in a second. The block is long enough to be sent as several pieces: each
    // lacks about six seconds, all of them together more than eight. So soon after the first
    // piece the others may still start beside it.
    const { session, second, release } = afterOneBlock(1000, 300, 13);
    await session.translate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(second()?.textContent).toContain('The harbour office');
    expect(second()?.textContent).not.toContain('港の事務所');

    release();
    vi.mocked(performance.now).mockRestore();
    await session.whenIdle();
    expect(second()?.textContent).toMatch(/^(?:完了)+$/u);
    expect(second()?.textContent?.length).toBeGreaterThan(2);
  });

  it('keeps the source of a long block whose pieces all come side by side', async () => {
    // Twenty letters in 0.8 s. A second and a half in, both pieces have text: the block
    // ends with the one that lacks the most, in about six seconds.
    const { session, second, release } = afterOneBlock(800, 1500, 11, true);
    await session.translate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(second()?.textContent).toContain('The harbour office');
    expect(second()?.textContent).not.toContain('港の事務所');

    release();
    vi.mocked(performance.now).mockRestore();
    await session.whenIdle();
    // More than one piece: otherwise this says nothing about pieces.
    expect(second()?.textContent).toMatch(/^(?:完了){2,}$/u);
  });

  it('streams a long block whose other pieces have not started in time', async () => {
    // A second and a half in, only the first piece has text: the pieces come one after
    // another, as where one request is decoded at a time, and take eight and a half seconds
    // together.
    const { session, second, release } = afterOneBlock(800, 1500, 11);
    await session.translate();
    await vi.waitFor(() => {
      expect(second()?.textContent).toContain('港の事務所は毎回の');
    });

    release();
    vi.mocked(performance.now).mockRestore();
    await session.whenIdle();
    // More than one piece: otherwise this says nothing about pieces.
    expect(second()?.textContent).toMatch(/^(?:完了){2,}$/u);
  });

  /**
   * Menu words. The first one of a page is asked for by itself; the three after it share a
   * request. Of those the first gets its text, then the second begins; the request answers
   * for all three when `release` is called, with `answer` for the first.
   */
  function sharedRequest(
    answer: string,
    reveal: 'smooth' | 'stream' = 'smooth',
    failed = false,
  ): { session: PageSession; items: () => Element[]; release: () => void } {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<ul><li>Harbour</li><li>Departures</li><li>Arrivals</li><li>Timetable</li></ul>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        const [first, second, third] = segments;
        if (!first) return;
        if (!second || !third) {
          for (const segment of segments) {
            yield { id: segment.id, final: '港', engine: 'plamo' as const };
          }
          return;
        }
        yield { id: first.id, textDelta: '出', engine: 'plamo' as const };
        yield { id: first.id, textDelta: '発', engine: 'plamo' as const };
        yield { id: second.id, textDelta: '到', engine: 'plamo' as const };
        await gate;
        if (options.signal.aborted) return;
        yield { id: second.id, textDelta: '着', engine: 'plamo' as const };
        yield { id: third.id, textDelta: '時刻表', engine: 'plamo' as const };
        yield {
          id: first.id,
          final: answer,
          engine: 'plamo' as const,
          ...(failed ? { error: true } : {}),
        };
        yield { id: second.id, final: '到着', engine: 'plamo' as const };
        yield { id: third.id, final: '時刻表', engine: 'plamo' as const };
      }),
      { reveal },
    );
    return { session, items: () => [...document.querySelectorAll('li')].slice(1), release };
  }

  it('shows a line that shares its request as soon as the next line begins', async () => {
    const { session, items, release } = sharedRequest('出発');
    await session.translate();
    await vi.waitFor(() => {
      expect(items()[0]?.textContent).toBe('出発');
    });
    // The request is still open: the line that has begun keeps its source.
    expect(items()[1]?.textContent).toBe('Arrivals');
    expect(items()[2]?.textContent).toBe('Timetable');

    release();
    await session.whenIdle();
    expect(items().map((item) => item.textContent)).toEqual(['出発', '到着', '時刻表']);
  });

  it('takes the answer of the request for a line where it says something else', async () => {
    const { session, items, release } = sharedRequest('出発便');
    await session.translate();
    await vi.waitFor(() => {
      expect(items()[0]?.textContent).toBe('出発');
    });

    release();
    await session.whenIdle();
    expect(items().map((item) => item.textContent)).toEqual(['出発便', '到着', '時刻表']);
  });

  it('honours a failed final for a line that was finished when the next line began', async () => {
    const { session, items, release } = sharedRequest('Departures', 'smooth', true);
    await session.translate();
    await vi.waitFor(() => {
      expect(items()[0]?.textContent).toBe('出発');
    });

    release();
    await session.whenIdle();
    // The answer carries fallback text, not a translation: the early optimistic text goes.
    expect(items()[0]?.textContent).toBe('Departures');
  });

  it('counts a failed early final that restored its source as skipped prose', async () => {
    const { session, items, release } = sharedRequest('Departures', 'smooth', true);
    await session.translate();
    await vi.waitFor(() => {
      expect(items()[0]?.textContent).toBe('出発');
    });

    release();
    await session.whenIdle();
    expect(items()[0]?.textContent).toBe('Departures');
    expect(session.state().skipped).toBe(1);
    expect(document.documentElement.dataset.sakuttoState).toBe('partial');
  });

  it('does not let a stale request final overwrite a block the page replaced', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<ul><li>Harbour</li><li>Departures</li><li>Arrivals</li><li>Timetable</li></ul>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        const ids = new Map(segments.map((segment) => [segment.text, segment.id]));
        for (const segment of segments) {
          if (segment.text === 'New source') {
            yield { id: segment.id, final: '新しい:New source', engine: 'plamo' as const };
            continue;
          }
          if (segment.text === 'Departures') {
            const departures = segment.id;
            const arrivals = ids.get('Arrivals');
            if (!arrivals) return;
            yield { id: departures, textDelta: '出', engine: 'plamo' as const };
            yield { id: departures, textDelta: '発', engine: 'plamo' as const };
            // The next line starts: the request has answered for Departures for now.
            yield { id: arrivals, textDelta: '到', engine: 'plamo' as const };
            await gate;
            if (options.signal.aborted) return;
            yield { id: departures, final: '出発便', engine: 'plamo' as const };
            yield { id: arrivals, final: '到着', engine: 'plamo' as const };
            const timetable = ids.get('Timetable');
            if (timetable) yield { id: timetable, final: '時刻表', engine: 'plamo' as const };
            continue;
          }
          yield { id: segment.id, final: '港', engine: 'plamo' as const };
        }
      }),
      { reveal: 'smooth' },
    );
    const items = (): Element[] => [...document.querySelectorAll('li')].slice(1);

    await session.translate();
    await vi.waitFor(() => {
      expect(items()[0]?.textContent).toBe('出発');
    });

    // An in-place page change replaces the block while the old request is still open.
    const block = items()[0];
    if (!block || !(block.firstChild instanceof Text)) throw new Error('missing block text');
    block.firstChild.nodeValue = 'New source';
    await vi.waitFor(() => {
      expect(items()[0]?.textContent).toBe('新しい:New source');
    });

    release();
    await session.whenIdle();
    expect(items()[0]?.textContent).toBe('新しい:New source');
  });

  it('retranslates a block whose text the page changes while its request is running', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          if (segment.text === 'Hello world') {
            yield { id: segment.id, textDelta: '途中。', engine: 'plamo' as const };
            await gate;
            // The stale request still answers even though the block changed under it.
            yield { id: segment.id, final: '古い訳', engine: 'plamo' as const };
            continue;
          }
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(document.querySelector('p')?.textContent).toBe('途中。');
    });

    const block = document.querySelector('p');
    if (!block || !(block.firstChild instanceof Text)) throw new Error('missing block text');
    block.firstChild.nodeValue = 'New source';
    // Let the mutation observer register the in-place change before the stale final lands.
    await new Promise((resolve) => setTimeout(resolve, 0));

    release();
    await session.whenIdle();
    expect(document.querySelector('p')?.textContent).toBe('訳:New source');
    expect(session.state()).toMatchObject({ pending: 0, done: 1, total: 1, skipped: 0 });
  });

  it('retranslates a block whose text node the page replaces while its request is running', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          if (segment.text === 'Hello world') {
            yield { id: segment.id, textDelta: '途中。', engine: 'plamo' as const };
            await gate;
            yield { id: segment.id, final: '古い訳', engine: 'plamo' as const };
            continue;
          }
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(document.querySelector('p')?.textContent).toBe('途中。');
    });

    const block = document.querySelector('p');
    if (!block) throw new Error('missing block');
    // Replacing the text node detaches the slot the old request would write its final into.
    block.textContent = 'New source';
    await new Promise((resolve) => setTimeout(resolve, 0));

    release();
    await session.whenIdle();
    expect(document.querySelector('p')?.textContent).toBe('訳:New source');
    expect(session.state()).toMatchObject({ pending: 0, done: 1, total: 1, skipped: 0 });
  });

  it('retranslates a smooth block the page changes before its final arrives', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Hello world</p>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          if (segment.text === 'Hello world') {
            await gate;
            // A stale answer that must not overwrite the page's newer source.
            yield { id: segment.id, final: '古い訳', engine: 'plamo' as const };
            continue;
          }
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
      { reveal: 'smooth' },
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(session.state().pending).toBe(1);
    });
    const lead = document.querySelector('#lead');
    if (!lead || !(lead.firstChild instanceof Text)) throw new Error('missing lead text');
    expect(lead.textContent).toBe('Hello world');

    // Nothing has been painted yet: the running block must still be claimed.
    lead.firstChild.nodeValue = 'New source';
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await session.whenIdle();

    expect(lead.textContent).toBe('訳:New source');
    expect(session.state()).toMatchObject({ pending: 0, done: 1, total: 1, skipped: 0 });
  });

  it('retranslates a third visible sentence block changed before its first write', async () => {
    document.documentElement.lang = 'en';
    const body = (seed: string): string => Array.from({ length: 8 }, () => seed).join(' ');
    document.body.innerHTML =
      `<p id="p1">${body('First paragraph')}</p>` +
      `<p id="p2">${body('Second paragraph')}</p>` +
      `<p id="p3">${body('Third paragraph')}</p>`;
    for (const block of document.querySelectorAll('p')) {
      block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let thirdStarted!: () => void;
    const thirdRequest = new Promise<void>((resolve) => {
      thirdStarted = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          if (segment.text.startsWith('Third paragraph')) {
            thirdStarted();
            // An unterminated partial that sentence discipline holds back: no paint, no claim.
            yield { id: segment.id, textDelta: '途中', engine: 'plamo' as const };
            await gate;
            yield { id: segment.id, final: '古い訳', engine: 'plamo' as const };
            continue;
          }
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await thirdRequest;
    const third = document.querySelector('#p3');
    if (!third || !(third.firstChild instanceof Text)) throw new Error('missing third text');
    expect(third.textContent).toBe(body('Third paragraph').trim());

    third.firstChild.nodeValue = 'New source';
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await session.whenIdle();

    expect(third.textContent).toBe('訳:New source');
    expect(session.state()).toMatchObject({ pending: 0, done: 3, total: 3, skipped: 0 });
  });

  it('rebuilds inline source from the snapshot after a partial paint and a link edit', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Hello <a href="/world">world</a> today.</p>';
    const lead = document.querySelector('#lead');
    if (!(lead instanceof HTMLElement)) throw new Error('missing lead');
    lead.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          requests.push(segment.text);
          if (segment.text.includes('<i1>world</i1>')) {
            yield { id: segment.id, textDelta: '途中', engine: 'plamo' as const };
            await gate;
            yield { id: segment.id, final: '古い訳', engine: 'plamo' as const };
            continue;
          }
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(lead.textContent).toBe('途中');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const link = lead.querySelector('a');
    if (!link || !(link.firstChild instanceof Text)) throw new Error('missing link text');
    link.firstChild.nodeValue = 'there';
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await session.whenIdle();

    expect(requests).toEqual(['Hello <i1>world</i1> today.', 'Hello <i1>there</i1> today.']);
    expect(lead.textContent).toContain('there');
    expect(lead.textContent).not.toBe('古い訳');
  });

  it('streams a block that is decoded by itself and will take more than three seconds', async () => {
    // No other block gets text beside it, as where one request is decoded at a time. Nine
    // letters in 0.6 s of the sixty it will have: four seconds, by its own speed. The speed
    // of the block before it would say half a second.
    const { session, second, release } = afterOneBlock(200, 600, 3, false, true);
    await session.translate();
    await vi.waitFor(() => {
      expect(second()?.textContent).toContain('港の事務所は毎回の');
    });

    release();
    vi.mocked(performance.now).mockRestore();
    await session.whenIdle();
    expect(second()?.textContent).toBe('完了');
  });

  it('keeps the source of a block that is decoded by itself and will be finished soon', async () => {
    // Nine letters in 0.3 s of sixty: two seconds, by its own speed. The block before it was
    // slow, and its speed would say ten.
    const { session, second, release } = afterOneBlock(4000, 300, 3, false, true);
    await session.translate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(second()?.textContent).toContain('The harbour office');
    expect(second()?.textContent).not.toContain('港の事務所');

    release();
    vi.mocked(performance.now).mockRestore();
    await session.whenIdle();
    expect(second()?.textContent).toBe('完了');
  });

  it('streams a block early on a page whose blocks have come slowly', async () => {
    // Twenty letters in four seconds: the hundred letters this block still lacks take twenty.
    const { session, second, release } = afterOneBlock(4000, 300);
    await session.translate();
    await vi.waitFor(() => {
      expect(second()?.textContent).toContain('港の事務所は毎回の');
    });

    release();
    vi.mocked(performance.now).mockRestore();
    await session.whenIdle();
    expect(second()?.textContent).toBe('完了');
  });

  it('keeps the source of a block whose speed says it will be finished soon', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = `<p>${'A sentence of the source text. '.repeat(8)}</p>`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let streamed = false;
    const clock = vi.spyOn(performance, 'now');
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        for (const segment of segments) {
          clock.mockReturnValue(1000);
          yield { id: segment.id, textDelta: '訳'.repeat(40), engine: 'plamo' as const };
          clock.mockReturnValue(1300);
          yield { id: segment.id, textDelta: '文'.repeat(40), engine: 'plamo' as const };
          streamed = true;
          await gate;
          if (options.signal.aborted) return;
          yield { id: segment.id, final: '完了', engine: 'plamo' as const };
        }
      }),
      { reveal: 'smooth' },
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(streamed).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).toContain('A sentence of the source text.');

    release();
    await session.whenIdle();
    expect(document.body.textContent).toBe('完了');
    clock.mockRestore();
  });

  it('adds a bilingual line only when its translation is finished', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let streamed = false;
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        for (const segment of segments) {
          yield { id: segment.id, textDelta: '途中', engine: 'plamo' as const };
          streamed = true;
          await gate;
          if (options.signal.aborted) return;
          yield { id: segment.id, final: '完了', engine: 'plamo' as const };
        }
      }),
      { display: 'bilingual', reveal: 'smooth' },
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(streamed).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('sakutto-line')).toBeNull();

    release();
    await session.whenIdle();
    expect(document.querySelector('p')?.childNodes[0]?.nodeValue).toBe('Hello world');
    expect(document.querySelector('sakutto-line')?.textContent).toBe('完了');
  });

  it('does not grow a bilingual line while a slow block is translated', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let streamed = false;
    const clock = vi.spyOn(performance, 'now');
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        for (const segment of segments) {
          clock.mockReturnValue(1000);
          yield { id: segment.id, textDelta: '途', engine: 'plamo' as const };
          clock.mockReturnValue(1000 + REVEAL_STREAM_AFTER_MS + 1);
          yield { id: segment.id, textDelta: '中', engine: 'plamo' as const };
          streamed = true;
          await gate;
          if (options.signal.aborted) return;
          yield { id: segment.id, final: '完了', engine: 'plamo' as const };
        }
      }),
      { display: 'bilingual', reveal: 'smooth' },
    );

    try {
      await session.translate();
      await vi.waitFor(() => {
        expect(streamed).toBe(true);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.querySelector('sakutto-line')).toBeNull();

      release();
      await session.whenIdle();
      expect(document.querySelector('sakutto-line')?.textContent).toBe('完了');
    } finally {
      clock.mockRestore();
    }
  });

  it('does not grow a bilingual line when a streamed replace block switches display', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish!: () => void;
    const finalGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let switchDeltaSeen = false;
    let afterSwitchDelta: string | null = null;
    const clock = vi.spyOn(performance, 'now');
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        for (const segment of segments) {
          clock.mockReturnValue(1000);
          yield { id: segment.id, textDelta: '途', engine: 'plamo' as const };
          clock.mockReturnValue(1000 + REVEAL_STREAM_AFTER_MS + 1);
          yield { id: segment.id, textDelta: '中', engine: 'plamo' as const };
          await gate;
          if (options.signal.aborted) return;
          yield { id: segment.id, textDelta: 'です', engine: 'plamo' as const };
          switchDeltaSeen = true;
          afterSwitchDelta = document.querySelector('sakutto-line')?.textContent ?? null;
          await finalGate;
          if (options.signal.aborted) return;
          yield { id: segment.id, final: '完了', engine: 'plamo' as const };
        }
      }),
      { display: 'replace', reveal: 'smooth' },
    );

    try {
      await session.translate();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain('途中');
      });
      expect(document.querySelector('sakutto-line')).toBeNull();

      // The display switch clears the partial paint: the hold starts over in bilingual mode.
      session.setPreferences({ ...preferences(), display: 'bilingual', reveal: 'smooth' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      await vi.waitFor(() => {
        expect(switchDeltaSeen).toBe(true);
      });
      expect(afterSwitchDelta).toBeNull();
      expect(document.querySelector('sakutto-line')).toBeNull();

      finish();
      await session.whenIdle();
      expect(document.querySelector('sakutto-line')?.textContent).toBe('完了');
    } finally {
      clock.mockRestore();
    }
  });

  it('does not regrow a partial bilingual line after a display switch during sentence streaming', async () => {
    document.documentElement.lang = 'en';
    const first =
      'The harbour office logs every crossing and publishes the delays each month. '.repeat(2);
    const second =
      'The railway station posts every arrival and updates the departures each morning. '.repeat(2);
    const third =
      'The market beside the river records every delivery and shares the totals each week. '.repeat(
        2,
      );
    document.body.innerHTML = `<p id="p1">${first}</p><p id="p2">${second}</p><p id="p3">${third}</p>`;
    for (const block of document.querySelectorAll('p')) {
      block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    }
    const target = document.querySelector('#p3');
    if (!target) throw new Error('missing third paragraph');
    const frames: (() => void)[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let secondDeltaSeen!: () => void;
    const stalled = new Promise<void>((resolve) => {
      secondDeltaSeen = resolve;
    });
    let continued!: () => void;
    const continuedGate = new Promise<void>((resolve) => {
      continued = resolve;
    });
    let finish!: () => void;
    const finalGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments, options: TranslateOptions) {
        for (const segment of segments) {
          if (!segment.text.includes('market beside the river')) {
            yield { id: segment.id, final: '完了', engine: 'plamo' as const };
            continue;
          }
          // The third visible body block has no fast-path slot: its first chunk takes
          // paintSentences() -> writeFirstChunk(), the next delta only queues a frame.
          yield { id: segment.id, textDelta: '最初の部分', engine: 'plamo' as const };
          yield { id: segment.id, textDelta: 'と続き', engine: 'plamo' as const };
          secondDeltaSeen();
          await gate;
          if (options.signal.aborted) return;
          yield { id: segment.id, textDelta: 'が続く', engine: 'plamo' as const };
          continued();
          await finalGate;
          if (options.signal.aborted) return;
          yield { id: segment.id, final: '最初の部分と続き。次の文。', engine: 'plamo' as const };
        }
      }),
      labels,
      preferences: preferences({ reveal: 'sentence' }),
      scheduleFrame: (callback) => {
        frames.push(callback);
      },
      debounceMs: 20,
    });
    sessions.push(session);

    await session.translate();
    await stalled;
    expect(target.textContent).toBe('最初の部分');
    expect(target.querySelector('sakutto-line')).toBeNull();

    // Switch display while the second delta's paint frame is still queued.
    session.setPreferences({ ...preferences(), display: 'bilingual', reveal: 'sentence' });
    expect(target.textContent).toBe(third);
    expect(target.querySelector('sakutto-line')).toBeNull();

    while (frames.length > 0) frames.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The stale frame must not write the raw prefix as a bilingual line: the block
    // keeps its source until a whole sentence is finished.
    expect(target.textContent).toBe(third);
    expect(target.querySelector('sakutto-line')).toBeNull();

    release();
    await continuedGate;
    while (frames.length > 0) frames.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A delta decoded after the switch queues a fresh frame, but the first-chunk
    // exception belonged to the invalidated generation: it must not regrow either.
    expect(target.textContent).toBe(third);
    expect(target.querySelector('sakutto-line')).toBeNull();

    finish();
    let idle = false;
    const done = session.whenIdle().then(() => {
      idle = true;
    });
    for (let attempt = 0; attempt < 40 && !idle; attempt += 1) {
      while (frames.length > 0) frames.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await done;
    expect(target.querySelector('sakutto-line')?.textContent).toBe('最初の部分と続き。次の文。');
  });

  it('translates a block again when the page changes it before its translation is shown', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello</p>';
    const frames: (() => void)[] = [];
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
      labels,
      preferences: preferences({ reveal: 'smooth' }),
      scheduleFrame: (callback) => frames.push(callback),
      debounceMs: 20,
    });
    sessions.push(session);

    await session.translate();
    await vi.waitFor(() => {
      expect(session.state().pending).toBe(1);
    });
    const paragraph = document.querySelector('p');
    expect(paragraph?.textContent).toBe('Hello');
    expect(paragraph?.hasAttribute('data-sakutto-id')).toBe(true);

    const text = paragraph?.firstChild;
    if (!text) throw new Error('missing text');
    text.nodeValue = 'Goodbye';
    // The page's change is noticed before the next frame, as it is in a browser.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await vi.waitFor(() => {
      while (frames.length > 0) frames.shift()?.();
      expect(paragraph?.textContent).toBe('訳:Goodbye');
    });
  });

  it('clears unfinished page paint immediately when the model changes', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello</p>';
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
        if (calls === 1) {
          yield { id: segment.id, textDelta: 'こん', engine: 'plamo' as const };
          throw modelChangedError();
        }
        await gate;
        yield { id: segment.id, final: 'こんにちは', engine: 'plamo' as const };
      }),
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(calls).toBe(2);
    });
    expect(document.body.textContent).not.toContain('こん');
    expect(document.body.textContent).toContain('Hello');
    release();
    await session.whenIdle();
    expect(document.body.textContent).toContain('こんにちは');
  });

  it('drops a shown clause fragment of a multi-piece fast block when the model changes', async () => {
    document.documentElement.lang = 'en';
    const source =
      'The harbour office logs every crossing and publishes the delays each month. '.repeat(10);
    document.body.innerHTML = `<p>${source}</p>`;
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        calls += 1;
        if (calls === 1) {
          const [first, second] = segments;
          if (!first || !second || segments.length !== 2) throw new Error('expected two pieces');
          yield { id: first.id, final: 'One. Two.', engine: 'plamo' as const };
          yield { id: second.id, textDelta: 'Par,', engine: 'plamo' as const };
          seen.push(block?.textContent ?? '');
          throw modelChangedError();
        }
        // The retry only starts after discardUnfinishedPaint has repainted the block.
        // The finished piece is cached, so the retry only carries the unfinished one.
        await gate;
        const retry = segments[0];
        if (!retry || segments.length !== 1) throw new Error('expected one piece');
        seen.push(block?.textContent ?? '');
        yield { id: retry.id, textDelta: 'New,', engine: 'plamo' as const };
        seen.push(block?.textContent ?? '');
        yield { id: retry.id, final: 'New text,', engine: 'plamo' as const };
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(calls).toBe(2);
    });
    release();
    await session.whenIdle();
    expect(seen[0]).toBe('One. Two.Par,');
    expect(seen[1]).toBe('One. Two.');
    expect(seen[2]).toBe('One. Two.New,');
    expect(block?.textContent).not.toContain('Par,');
    expect(block?.textContent).toContain('New text,');
  });

  it('repaints a fast block from a clean high-water mark after a generic retry', async () => {
    document.documentElement.lang = 'en';
    const source =
      'The harbour office logs every crossing and publishes the delays each month. '.repeat(10);
    document.body.innerHTML = `<p>${source}</p>`;
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    let calls = 0;
    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        calls += 1;
        if (calls === 1) {
          const [first, second] = segments;
          if (!first || !second || segments.length !== 2) throw new Error('expected two pieces');
          yield { id: first.id, final: 'One. Two.', engine: 'plamo' as const };
          yield { id: second.id, textDelta: 'Par,', engine: 'plamo' as const };
          seen.push(block.textContent ?? '');
          // A transient engine error retries this block; only the second piece is unfinished.
          throw new Error('transient engine failure');
        }
        const retry = segments[0];
        if (!retry || segments.length !== 1) throw new Error('expected one piece');
        seen.push(block.textContent ?? '');
        yield { id: retry.id, textDelta: 'New,', engine: 'plamo' as const };
        seen.push(block.textContent ?? '');
        yield { id: retry.id, final: 'New text,', engine: 'plamo' as const };
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();
    expect(calls).toBe(2);
    expect(seen[0]).toBe('One. Two.Par,');
    expect(seen[1]).toContain('Par,');
    // The retry's clause must replace the failed attempt's fragment before the final
    // settle; a stale high-water mark would reject "New," and freeze the block.
    expect(seen[2]).toBe('One. Two.New,');
    expect(block.textContent).toBe('One. Two.New text,');
  });

  it('repaints a below-fold block from a clean mark after an engine-abort requeue', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>First source sentence. Second source sentence.</p>';
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    block.getBoundingClientRect = () => new DOMRect(0, 2400, 300, 40);
    let calls = 0;
    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        calls += 1;
        const first = segments[0];
        if (!first) throw new Error('expected a piece');
        if (calls === 1) {
          yield { id: first.id, textDelta: 'One. ', engine: 'plamo' as const };
          seen.push(block.textContent ?? '');
          // A caption preemption aborts the engine mid-clause. The requeue must not burn a
          // page retry, so the failed attempt's finished clause must not survive as a mark
          // and reject the replacement's first clause.
          throw abortError();
        }
        yield { id: first.id, textDelta: 'New. ', engine: 'plamo' as const };
        seen.push(block.textContent ?? '');
        yield { id: first.id, final: 'New. Two.', engine: 'plamo' as const };
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();
    expect(calls).toBe(2);
    expect(seen[0]).toBe('One.');
    // The retry's finished clause must land before the final settle, not only at the final.
    expect(seen[1]).toBe('New.');
    expect(block.textContent).toBe('New. Two.');
  });

  it('repaints a visible block from a clean mark after a broken-placeholder retry', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>See <a href="/osaka">Osaka</a> today.</p>';
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    block.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40);
    let calls = 0;
    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        calls += 1;
        const first = segments[0];
        if (!first) throw new Error('expected a piece');
        if (calls === 1) {
          yield { id: first.id, textDelta: '訳:See ', engine: 'plamo' as const };
          seen.push(block.textContent ?? '');
          // A final with a broken placeholder makes acceptTranslation discard the answer
          // and retry flattened. The retry's partial must replace this painted fragment
          // before the final settle; a retained mark would reject it.
          yield { id: first.id, final: '訳:See <i1 Osaka today', engine: 'plamo' as const };
          return;
        }
        yield { id: first.id, textDelta: '新しい訳:See,', engine: 'plamo' as const };
        seen.push(block.textContent ?? '');
        yield { id: first.id, final: '新しい訳:See Osaka today.', engine: 'plamo' as const };
      }),
      { reveal: 'sentence' },
    );

    await session.translate();
    await session.whenIdle();
    expect(calls).toBe(2);
    expect(seen[0]).toBe('訳:See');
    expect(seen[1]).toBe('新しい訳:See,');
    expect(block.textContent).toContain('新しい訳:See Osaka today.');
    expect(document.body.innerHTML).not.toMatch(/<i\d/);
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/osaka');
  });

  it('does not arm the selection folder timeout when the grant gate is off', async () => {
    vi.useFakeTimers();
    try {
      document.documentElement.lang = 'en';
      document.body.innerHTML = '<p>Hello world</p>';
      const session = new PageSession(document, {
        engine: stalled(),
        labels,
        preferences: preferences(),
        scheduleFrame: (callback) => callback(),
        debounceMs: 20,
        folderGrantUiActive: false,
      });
      sessions.push(session);
      const begin = vi.spyOn(session, 'beginFolderGrantWait');

      session.translateSelection('Hello world', new DOMRect(12, 12, 80, 18));
      await vi.advanceTimersByTimeAsync(12_500);

      expect(begin).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms the selection folder timeout when the grant needs action', async () => {
    vi.useFakeTimers();
    try {
      document.documentElement.lang = 'en';
      document.body.innerHTML = '<p>Hello world</p>';
      const session = new PageSession(document, {
        engine: stalled(),
        labels,
        preferences: preferences(),
        scheduleFrame: (callback) => callback(),
        debounceMs: 20,
        folderGrantUiActive: true,
      });
      sessions.push(session);
      const begin = vi.spyOn(session, 'beginFolderGrantWait').mockImplementation(() => undefined);

      session.translateSelection('Hello world', new DOMRect(12, 12, 80, 18));
      await vi.advanceTimersByTimeAsync(12_500);

      expect(begin).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops an active page and shows no-model text when the model is removed', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = Array.from(
      { length: 12 },
      (_, index) => `<p>Hello world ${String(index)}</p>`,
    ).join('');
    let signal: AbortSignal | undefined;
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        signal = options.signal;
        await new Promise<void>((resolve) => {
          const done = (): void => resolve();
          if (options.signal.aborted) {
            done();
            return;
          }
          options.signal.addEventListener('abort', done, { once: true });
        });
        if (options.signal.aborted) return;
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await vi.waitFor(() => {
      expect(signal).toBeDefined();
    });
    expect(session.state().pending).toBeGreaterThan(0);

    session.noteModelMissing();
    await session.whenIdle();

    expect(signal?.aborted).toBe(true);
    expect(session.state().pending).toBe(0);
    const bar = document.querySelector<HTMLElement>('sakutto-bar');
    expect(bar?.hidden).toBe(false);
    expect(uiShadow(bar)?.textContent).toContain(labels.modelMissing);
    expect(document.documentElement.dataset.sakuttoState).not.toBe('translating');
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
    expect(uiShadow(document.querySelector('sakutto-tip'))?.textContent).toContain(
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

  it('rebinds a cached translation when an SPA replaces children in the same block', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead"><span>Hello world</span></p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );
    await session.translate();
    await session.whenIdle();

    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead');
    lead.replaceChildren(document.createElement('span'));
    if (!lead.firstElementChild) throw new Error('missing replacement');
    lead.firstElementChild.textContent = 'Hello world';

    await vi.waitFor(() => expect(lead.textContent).toBe('訳:Hello world'));
    session.restore();
    expect(lead.textContent).toBe('Hello world');
  });

  it('rebinds a same-source child replacement while the request is still running', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead"><span>Hello world</span></p>';
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        calls += 1;
        const first = calls === 1;
        for (const segment of segments) {
          if (first) {
            yield { id: segment.id, textDelta: '…', engine: 'plamo' as const };
            await gate;
            if (options.signal.aborted) return;
          }
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await vi.waitFor(() => expect(lead.textContent).toContain('…'));

    // React replaces the child with the same source while the first request is in flight.
    lead.replaceChildren(document.createElement('span'));
    const fresh = lead.firstElementChild;
    if (!fresh) throw new Error('missing replacement');
    fresh.textContent = 'Hello world';
    // Let the mutation observer rebind the segment before the request finishes.
    await new Promise((resolve) => setTimeout(resolve, 40));
    release();
    await session.whenIdle();

    expect(calls).toBe(1);
    expect(lead.textContent).toBe('訳:Hello world');
    // The paint has to reach the live block; the old span was detached by the replacement.
    expect(
      [...lead.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? '').includes('訳:'),
      ),
    ).toBe(true);
    expect(fresh.textContent).toBe('Hello world');
  });

  it('rebuilds from original source after a partial replace paint and a source change', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead"><span>Hello</span> <span>world</span></p>';
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        calls += 1;
        for (const segment of segments) {
          if (calls === 1) {
            yield { id: segment.id, textDelta: '…', engine: 'plamo' as const };
            await gate;
            if (options.signal.aborted) return;
          }
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await vi.waitFor(() => expect(lead.querySelector('span')?.textContent).toBe(''));

    // The page edits the second span after our partial paint cleared both source slots.
    const second = lead.querySelectorAll('span')[1];
    if (!second) throw new Error('missing second span');
    second.textContent = 'WORLD';
    await new Promise((resolve) => setTimeout(resolve, 40));

    release();
    await session.whenIdle();

    expect(calls).toBe(2);
    expect(lead.textContent).toContain('Hello');
    expect(lead.textContent).toContain('WORLD');
    expect(lead.textContent).not.toContain('…');
  });

  it('keeps source line breaks in a bilingual translation', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<p id="lead"><span>First line.</span><br /><br /><span>Second line.</span></p>';
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
      { display: 'bilingual' },
    );
    await session.translate();
    await session.whenIdle();

    const line = document.querySelector('#lead > sakutto-line');
    expect(line?.querySelectorAll('br')).toHaveLength(2);
    expect(line?.childNodes[0]?.nodeValue).toBe('訳:First line.');
    expect(line?.childNodes[4]?.nodeValue).toBe('Second line.');
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
      popover = uiShadow(document.querySelector('sakutto-pop'))?.textContent ?? '';
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

  it('splits a paragraph longer than a piece into runs of sentences', async () => {
    document.documentElement.lang = 'en';
    const sentence = 'This is one sentence about the release. ';
    document.body.innerHTML = `<p>${sentence.repeat(30)}</p>`;
    const ids: string[] = [];
    const texts: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          ids.push(segment.id);
          texts.push(segment.text);
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();

    expect(ids.some((id) => id.includes('#'))).toBe(true);
    // Each piece carries several whole sentences, not one sentence cut off from the rest.
    for (const text of texts) {
      expect(text.split('. ').length).toBeGreaterThan(2);
      expect(text.endsWith('.')).toBe(true);
    }
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
      expect(order[leadIndex]).toContain('[1]');
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
      expect(uiShadow(tip)?.textContent).toContain('Osaka University, Osaka Metropolitan');
      expect(uiShadow(tip)?.textContent).not.toContain('UniversityOsaka');
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
    // The page keeps one request waiting inside the engine, as the real engine does. Like
    // the real engine, this double runs one completion at a time and takes the waiting
    // request with the lowest priority value next, so a selection overtakes the next page
    // chunk without cancelling the one already inside the model.
    const slot = new JobScheduler(1);
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        const label = segments.map((segment) => segment.text).join('|');
        let finish!: () => void;
        const finished = new Promise<void>((resolve) => {
          finish = resolve;
        });
        await new Promise<void>((admitted) => {
          slot.schedule({
            priority: options.priority,
            run: () => {
              admitted();
              return finished;
            },
          });
        });
        try {
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
        } finally {
          finish();
        }
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).not.toContain('start:Second paragraph');

    releasePage?.();
    for (let attempt = 0; attempt < 40 && !calls.includes('end:Selected phrase'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await pending;
    await session.whenIdle();

    const order = (prefix: string): number => calls.findIndex((call) => call.startsWith(prefix));
    expect(calls).not.toContain('aborted');
    expect(order('end:First paragraph')).toBeGreaterThanOrEqual(0);
    expect(order('start:Selected phrase')).toBeGreaterThan(order('end:First paragraph'));
    expect(order('end:Selected phrase')).toBeLessThan(order('start:Second paragraph'));
    expect(uiShadow(document.querySelector('sakutto-pop'))?.textContent).toContain(
      '訳:Selected phrase',
    );
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

    await new Promise((resolve) => setTimeout(resolve, PAGE_SHORTCUT_DEDUP_MS + 1));
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

  it('sends selection spacing unchanged in the historical none mode', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        const segment = segments[0];
        if (!segment) return;
        seen.push(segment.text);
        yield { id: segment.id, final: '訳文', engine: 'plamo' as const };
      }),
      { plainTextLineBreaks: 'none' },
    );

    session.translateSelection('  Hello,   world!  ', new DOMRect(8, 8, 24, 12));
    await session.whenIdle();

    expect(seen).toEqual(['Hello,   world!']);
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

    const text = uiShadow(document.querySelector('sakutto-pop'))?.textContent ?? '';
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

    const text = uiShadow(document.querySelector('sakutto-pop'))?.textContent ?? '';
    expect(text).toContain('この選択範囲を翻訳できませんでした。');
    expect(text).not.toContain('途中');
  });

  it('marks a collapsed selection retry as failed instead of offering the source', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const session = start(
      document,
      engineOf(async function* (segments) {
        const segment = segments[0];
        if (!segment) return;
        yield { id: segment.id, textDelta: ',3', engine: 'plamo' as const };
        yield {
          id: segment.id,
          textDelta: segment.text,
          engine: 'plamo' as const,
          restart: true,
        };
        yield { id: segment.id, final: segment.text, engine: 'plamo' as const, error: true };
      }),
    );

    session.translateSelection('Selected phrase', new DOMRect(8, 8, 24, 12));
    await session.whenIdle();

    const text = uiShadow(document.querySelector('sakutto-pop'))?.textContent ?? '';
    expect(text).toContain('この選択範囲を翻訳できませんでした。');
    expect(text).not.toContain('Selected phrase');
    expect(text).not.toContain(',3');
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

    const text = uiShadow(document.querySelector('sakutto-pop'))?.textContent ?? '';
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

  it('finishes the decoding block when the tab is hidden and cancels the waiting one', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>First paragraph here</p><p>Second paragraph here</p>';
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    const signals = new Map<string, AbortSignal>();
    let secondCalls = 0;
    let release: (() => void) | undefined;
    const session = start(
      document,
      engineOf(async function* (segments, options) {
        const first = segments[0];
        if (!first) return;
        signals.set(first.text, options.signal);
        if (first.text.startsWith('First')) {
          yield { id: first.id, textDelta: '訳:', engine: 'plamo' as const };
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        } else if (++secondCalls === 1) {
          await new Promise<void>((resolve) => {
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          if (options.signal.aborted) return;
        }
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    try {
      void session.translate();
      for (let attempt = 0; attempt < 50 && (!release || signals.size < 2); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(release).toBeDefined();
      expect(signals.size).toBe(2);
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));

      expect(signals.get('First paragraph here')?.aborted).toBe(false);
      expect(signals.get('Second paragraph here')?.aborted).toBe(true);

      release?.();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(document.body.textContent).toContain('訳:First paragraph here');
      expect(document.body.textContent).not.toContain('訳:Second paragraph here');

      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      await session.whenIdle();
      expect(document.body.textContent).toContain('訳:Second paragraph here');
    } finally {
      Reflect.deleteProperty(document, 'hidden');
    }
  });

  it('keeps translating after a beforeunload that does not leave the page', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>First paragraph here</p><p>Second paragraph here</p>';
    let release: (() => void) | undefined;
    let calls = 0;
    const session = start(
      document,
      engineOf(async function* (segments) {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    const pending = session.translate();
    for (let attempt = 0; attempt < 20 && !release; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // A download link or a cancelled "Leave site?" prompt fires beforeunload and stays.
    document.defaultView?.dispatchEvent(new Event('beforeunload'));
    release?.();
    await pending;
    await session.whenIdle();

    expect(document.body.textContent).toContain('訳:First paragraph here');
    expect(document.body.textContent).toContain('訳:Second paragraph here');
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

    expect(patches).toEqual([]);
    expect(document.documentElement.lang).toBe('ja');
    expect(document.body.textContent).toContain('訳:Hello world');

    session.restore();
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.hasAttribute('data-sakutto-source-lang')).toBe(false);
  });

  it('keeps a saved Japanese target on a Japanese page and does not store a site language', async () => {
    document.documentElement.lang = 'ja';
    document.body.innerHTML = '<p>こんにちは</p>';
    const patches: Array<{ targetLanguage?: string }> = [];
    const session = new PageSession(document, {
      engine: immediate((text) => `EN:${text}`),
      labels,
      preferences: preferences({ targetLanguage: 'ja', targetExplicit: true }),
      scheduleFrame: (callback) => callback(),
      onSitePatch: (patch) => {
        patches.push(patch);
      },
    });
    sessions.push(session);

    await session.translate();
    await session.whenIdle();

    expect(session.state().targetLanguage).toBe('ja');
    expect(patches.some((patch) => patch.targetLanguage !== undefined)).toBe(false);
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

  it('translates a selected passage from a native command and closes it with Escape', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([]);

    await session.handle('selection');
    await session.whenIdle();
    expect(seen).toContain('Osaka is a designated city.');
    expect(uiShadow(document.querySelector('sakutto-pop'))?.textContent).toContain('訳:');

    document.defaultView?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    const popover = document.querySelector('sakutto-pop');
    expect(popover instanceof HTMLElement && popover.hidden).toBe(true);
  });

  /**
   * Ctrl+A in a focused field reports the typed value through `window.getSelection()`, with
   * the range on `<body>`. Nothing about that is a page passage, so it must not reach the
   * engine: the reader did not ask for it, and the text may be private.
   */
  it('does not translate the value of the field the reader is typing in', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<textarea id="message">Draft to a friend</textarea>';
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

    const field = document.querySelector('#message');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();

    const selection = document.getSelection();
    selection?.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(document.body);
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

    expect(seen).not.toContain('Draft to a friend');
    expect(seen).toEqual([]);
  });

  it('does not offer a selection icon for the value of a focused field', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<textarea id="message">Draft to a friend</textarea>';
    const seen: string[] = [];
    sessions.push(
      start(
        document,
        engineOf(async function* (segments) {
          for (const segment of segments) {
            seen.push(segment.text);
            yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
          }
        }),
      ),
    );

    const field = document.querySelector('#message');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();

    const selection = document.getSelection();
    selection?.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(document.body);
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));

    const icon = document.querySelector('sakutto-select');
    expect(icon instanceof HTMLElement && icon.hidden).toBe(true);
    expect(seen).toEqual([]);
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
    expect(bar?.shadowRoot).toBeNull();
    expect(uiShadow(bar)?.textContent).toContain('翻訳しました。');
    expect(document.querySelector('sakutto-bar button')).toBeNull();
    expect(document.documentElement.style.paddingTop).toBe('40px');
    const original = uiShadow(bar)?.querySelector('button');
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
    expect(uiShadow(tip)?.textContent).toContain('Title');

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
    // The style stub would otherwise leak into later tests and change their block layout.
    vi.mocked(document.defaultView!.getComputedStyle).mockRestore();
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
    const always = uiShadow(document.querySelector('sakutto-bar'))?.querySelectorAll('button')[1];
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

  it('does not translate from Alt+S keydown inside a same-origin frame', async () => {
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
    start(
      document,
      engineOf(async function* (segments) {
        calls += 1;
        const segment = segments[0];
        if (!segment) return;
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
    expect(calls).toBe(0);
  });

  it('runs the page fallback callbacks the content script enables under all-sites', async () => {
    document.body.innerHTML = '<p>Hello world</p>';
    const commands: string[] = [];
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' };
        }
      }),
      labels,
      preferences: preferences(),
      scheduleFrame: (callback) => callback(),
      pageKey: (event) => event.altKey && event.code === 'KeyA',
      bilingualKey: (event) => event.altKey && event.code === 'KeyB',
      onPageCommand: (command) => commands.push(command),
    });
    sessions.push(session);

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a',
        code: 'KeyA',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'b',
        code: 'KeyB',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(commands).toEqual(['toggle', 'bilingual']);
  });

  it('runs the selection callback only when there is a page selection', () => {
    document.body.innerHTML = '<p id="lead">Selected phrase</p>';
    const commands: string[] = [];
    const session = new PageSession(document, {
      engine: engineOf(async function* () {}),
      labels,
      preferences: preferences(),
      scheduleFrame: (callback) => callback(),
      selectionKey: (event) => event.altKey && event.code === 'KeyS',
      onPageCommand: (command) => commands.push(command),
    });
    sessions.push(session);
    document.getSelection()?.removeAllRanges();
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(commands).toEqual([]);

    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead');
    const range = document.createRange();
    range.selectNodeContents(lead);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(commands).toEqual(['selection']);
  });

  it('ignores page-owned selection keydown commands', () => {
    document.body.innerHTML = '<p id="lead">Selected phrase</p>';
    const seen: string[] = [];
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        seen.push(...segments.map((segment) => segment.text));
        yield { id: segments[0]?.id ?? 's', final: '訳', engine: 'plamo' };
      }),
      labels,
      preferences: preferences(),
      scheduleFrame: (callback) => callback(),
    });
    sessions.push(session);
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead');
    const range = document.createRange();
    range.selectNodeContents(lead);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(seen).toEqual([]);
  });

  it('ignores page keydown with or without IME and uses the native command', async () => {
    document.body.innerHTML = '<p>Hello world</p>';
    let calls = 0;
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        calls += 1;
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' };
        }
      }),
      labels,
      preferences: preferences(),
      scheduleFrame: (callback) => callback(),
    });
    sessions.push(session);

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a',
        code: 'KeyA',
        altKey: true,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(0);

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a',
        code: 'KeyA',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await session.handle('toggle');
    await session.whenIdle();
    expect(calls).toBeGreaterThan(0);
  });

  it('ignores Alt+A keydown and toggles only through the native command', async () => {
    document.body.innerHTML = '<p>Hello world</p>';
    let calls = 0;
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        calls += 1;
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' };
        }
      }),
      labels,
      preferences: preferences(),
      scheduleFrame: (callback) => callback(),
    });
    sessions.push(session);

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a',
        code: 'KeyA',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(0);

    await session.handle('toggle');
    await session.whenIdle();
    expect(calls).toBeGreaterThan(0);
    expect(session.state().active).toBe(true);
    expect(document.body.textContent).toContain('訳:Hello world');

    await new Promise((resolve) => setTimeout(resolve, PAGE_SHORTCUT_DEDUP_MS + 1));
    await session.handle('toggle');
    expect(session.state().active).toBe(false);
  });

  /** Page keydown never translates or steals Option+letter; native commands use onCommand. */
  it('does not steal Option+letter while the reader is typing in a field', async () => {
    document.body.innerHTML = '<textarea id="draft">hello</textarea><p>Hello world</p>';
    let calls = 0;
    const session = new PageSession(document, {
      engine: engineOf(async function* (segments) {
        calls += 1;
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' };
        }
      }),
      labels,
      preferences: preferences(),
      scheduleFrame: (callback) => callback(),
    });
    sessions.push(session);

    const field = document.querySelector('#draft');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    field.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'å',
        code: 'KeyA',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(0);
    expect(field.value).toBe('hello');
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
    const button = uiShadow(icon())?.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('missing selection button');
    return button;
  }

  async function selectRange(range: Range): Promise<void> {
    const selection = document.getSelection();
    if (!selection) throw new Error('missing selection');
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  async function selectElement(node: Node): Promise<void> {
    const range = document.createRange();
    range.selectNodeContents(node);
    await selectRange(range);
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
      expect(uiShadow(document.querySelector('sakutto-pop'))?.textContent).toContain(
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

  it('does not restart a selection when only the joined engine text differs', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<pre id="lead">Hello.\nWorld.</pre>';
    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        const segment = segments[0];
        if (!segment) return;
        seen.push(segment.text);
        yield { id: segment.id, final: 'こんにちは。世界。', engine: 'plamo' as const };
      }),
      { plainTextLineBreaks: 'keep' },
    );

    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead');
    await selectElement(lead);
    await session.whenIdle();
    expect(seen).toEqual(['Hello. World.']);
    expect(icon().hidden).toBe(false);

    iconButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const popover = document.querySelector('sakutto-pop');
    expect(popover instanceof HTMLElement && popover.hidden).toBe(false);

    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(seen).toEqual(['Hello. World.']);
    expect(popover instanceof HTMLElement && popover.hidden).toBe(false);
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

  it('opens the selection popover only from the native selection command', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(popover().hidden).toBe(true);

    await session.handle('selection');
    await session.whenIdle();
    expect(popover().hidden).toBe(false);
    expect(uiShadow(popover())?.textContent).toContain('訳:Selected phrase');
    expect(seen).toEqual(['Selected phrase']);

    await new Promise((resolve) => setTimeout(resolve, PAGE_SHORTCUT_DEDUP_MS + 1));
    document.body.innerHTML = '<p id="other">Another phrase</p>';
    const other = document.querySelector('#other');
    if (!other) throw new Error('missing other');
    await selectElement(other);
    await session.handle('selection');
    await session.whenIdle();
    expect(uiShadow(popover())?.textContent).toContain('訳:Another phrase');
    expect(seen).toContain('Another phrase');
    expect(document.body.textContent).toContain('Another phrase');
  });

  describe('selection after page translation', () => {
    function recordingEngine(requests: string[]): PageEngine {
      return immediate((source) => {
        requests.push(source);
        return `訳:${source}`;
      });
    }

    it.each(['icon', 'command'] as const)(
      'defers translated text until the %s is used',
      async (action) => {
        document.documentElement.lang = 'en';
        document.body.innerHTML = '<p id="lead">Osaka is a designated city.</p>';
        const requests: string[] = [];
        const session = start(document, recordingEngine(requests));
        await session.translate();
        await session.whenIdle();
        const lead = document.querySelector('#lead');
        if (!lead) throw new Error('missing paragraph');

        await selectElement(lead);
        await session.whenIdle();
        expect(requests).toEqual(['Osaka is a designated city.']);
        expect(icon().hidden).toBe(false);

        if (action === 'icon') {
          iconButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        } else {
          await session.handle('selection');
        }
        await session.whenIdle();
        expect(requests).toEqual(['Osaka is a designated city.', '訳:Osaka is a designated city.']);
        expect(icon().hidden).toBe(true);
      },
    );

    it('prefetches untranslated inline text inside a translated paragraph', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML =
        '<p id="lead">Osaka is a designated city. <span id="kept" translate="no">Kyoto is older.</span></p>';
      const requests: string[] = [];
      const session = start(document, recordingEngine(requests));
      await session.translate();
      await session.whenIdle();
      expect(document.querySelector('#lead')?.textContent).toContain('訳:');
      const kept = document.querySelector('#kept');
      if (!kept) throw new Error('missing untranslated text');
      const before = requests.length;

      await selectElement(kept);
      await session.whenIdle();
      expect(requests.slice(before)).toEqual(['Kyoto is older.']);
    });

    it.each([false, true])(
      'inspects the text between endpoints (untranslated block: %s)',
      async (mixed) => {
        document.documentElement.lang = 'en';
        document.body.innerHTML = [
          '<p id="first">Osaka is a designated city.</p>',
          mixed ? '<p translate="no">Kyoto is older.</p>' : '',
          '<p id="last">Kobe is a port city.</p>',
        ].join('');
        const requests: string[] = [];
        const session = start(document, recordingEngine(requests));
        await session.translate();
        await session.whenIdle();
        const first = document.querySelector('#first')?.firstChild;
        const last = document.querySelector('#last')?.firstChild;
        if (!first || !last) throw new Error('missing selection endpoints');
        expect(first.textContent).toContain('訳:');
        expect(last.textContent).toContain('訳:');
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(last, last.textContent?.length ?? 0);
        const before = requests.length;

        await selectRange(range);
        await session.whenIdle();
        expect(icon().hidden).toBe(false);
        expect(requests.slice(before)).toEqual(mixed ? [range.toString()] : []);
      },
    );

    it('bounds the scan for a full selection and still prefetches it', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML =
        '<main><p>Osaka is a designated city.</p>' +
        '<span></span>'.repeat(2048) +
        '<p id="late" translate="no">Kyoto is older.</p></main>';
      const requests: string[] = [];
      const session = start(document, recordingEngine(requests));
      await session.translate();
      await session.whenIdle();
      const page = document.querySelector('main');
      const late = document.querySelector('#late')?.firstChild;
      if (!page || !late) throw new Error('missing page content');
      const before = requests.length;

      const classifyLateText = vi.spyOn(late, 'parentElement', 'get');
      try {
        await selectElement(page);
        await session.whenIdle();
        expect(classifyLateText).not.toHaveBeenCalled();
        expect(requests.slice(before)).toEqual([page.textContent]);
        expect(icon().hidden).toBe(false);
      } finally {
        classifyLateText.mockRestore();
      }

      await session.handle('selection');
      await session.whenIdle();
      // The prefetched translation is reused; the command only reveals it.
      expect(requests.slice(before)).toEqual([page.textContent]);
    });

    it('prefetches the original in bilingual mode and defers its translated line', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = '<p id="lead">Osaka is a designated city.</p>';
      const requests: string[] = [];
      const session = start(document, recordingEngine(requests), { display: 'bilingual' });
      await session.translate();
      await session.whenIdle();
      const line = document.querySelector('sakutto-line');
      const original = document.querySelector('#lead')?.firstChild;
      if (!line || !original) throw new Error('missing bilingual text');

      await selectElement(line);
      await session.whenIdle();
      expect(requests).toEqual(['Osaka is a designated city.']);

      await selectElement(original);
      await session.whenIdle();
      expect(requests).toEqual(['Osaka is a designated city.', 'Osaka is a designated city.']);
    });

    it('prefetches the original while page translation is still running', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = '<p id="lead">Osaka is a designated city.</p>';
      const requests: string[] = [];
      const gate = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const session = start(
        document,
        engineOf(async function* (segments) {
          for (const segment of segments) {
            requests.push(segment.text);
            if (requests.length === 1) {
              started.resolve();
              await gate.promise;
            }
            yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' };
          }
        }),
      );
      await session.translate();
      await started.promise;
      const lead = document.querySelector('#lead');
      if (!lead) throw new Error('missing paragraph');

      try {
        await selectElement(lead);
        expect(icon().hidden).toBe(false);
      } finally {
        gate.resolve();
      }
      await session.whenIdle();
      expect(requests).toEqual(['Osaka is a designated city.', 'Osaka is a designated city.']);
    });
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
    document.body.innerHTML = `<p id="lead">${sentence.repeat(30)}</p>`;
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

  it('finishes a page block after a live caption preempts it', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<p id="lead">Hello world from the article that needs a translation.</p>';
    const scheduler = new JobScheduler(1);
    let pageStarts = 0;
    let holdFirstPage = true;
    const engine = engineOf(async function* (segments, options) {
      const local = new AbortController();
      const forward = (): void => local.abort();
      options.signal.addEventListener('abort', forward, { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          scheduler.schedule({
            priority: options.priority,
            ...(options.preempt === true ? { preempt: true } : {}),
            cancel: () => local.abort(),
            run: async () => {
              try {
                if (options.preempt !== true && holdFirstPage) {
                  holdFirstPage = false;
                  pageStarts += 1;
                  await new Promise<void>((_, fail) => {
                    const onAbort = (): void => fail(abortError());
                    if (local.signal.aborted) {
                      onAbort();
                      return;
                    }
                    local.signal.addEventListener('abort', onAbort, { once: true });
                  });
                }
                if (local.signal.aborted) throw abortError();
                resolve();
              } catch (error) {
                reject(error);
              }
            },
          });
        });
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      } finally {
        options.signal.removeEventListener('abort', forward);
      }
    });

    const session = start(document, engine);
    const pending = session.translate();
    await vi.waitFor(() => expect(pageStarts).toBe(1));

    for await (const chunk of engine.translate(
      [{ id: 'cue', text: 'The station opens at dawn.' }],
      {
        tgt: 'ja',
        form: 'polite',
        priority: CAPTION_PLAYHEAD_PRIORITY,
        preempt: true,
        signal: new AbortController().signal,
      },
    )) {
      void chunk;
    }

    await pending;
    await session.whenIdle();
    expect(document.querySelector('#lead')?.textContent).toContain('訳:');
    expect(session.state().skipped).toBe(0);
    expect(session.state().done).toBe(1);
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

  it('counts the last batch in engineMs, not just the batches before it', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="a">Hello world from the article</p>';

    let calls = 0;
    const session = start(
      document,
      engineOf(async function* (segments) {
        calls += 1;
        // Each batch burns real time, so a payload that stopped at the last `complete()`
        // would report one batch less than the page actually spent.
        await new Promise((resolve) => setTimeout(resolve, 60));
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();

    const raw = document.querySelector('sakutto-perf')?.textContent ?? '';
    const perf = JSON.parse(raw) as { batches: number; engineMs: number };
    expect(perf.batches).toBe(calls);
    expect(perf.engineMs).toBeGreaterThanOrEqual(calls * 55);
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
    expect(uiShadow(bar)?.textContent).toContain('翻訳できない箇所が 1 件残っています。');
  });

  it('counts a collapsed retry that fell back to the source as untranslated', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <p id="ok">Readable sentence</p>
      <p id="odd">This paragraph never translates</p>
    `;
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          if (segment.text.includes('never translates')) {
            yield { id: segment.id, textDelta: ',3', engine: 'plamo' as const };
            yield {
              id: segment.id,
              textDelta: segment.text,
              engine: 'plamo' as const,
              restart: true,
            };
            yield { id: segment.id, final: segment.text, engine: 'plamo' as const, error: true };
            continue;
          }
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    await session.translate();
    await session.whenIdle();

    expect(session.state().pending).toBe(0);
    expect(session.state().skipped).toBe(1);
    expect(document.documentElement.dataset.sakuttoState).toBe('partial');
    expect(document.querySelector('#ok')?.textContent).toContain('訳:');
    expect(document.querySelector('#odd')?.textContent).toContain(
      'This paragraph never translates',
    );
    expect(document.querySelector('#odd')?.textContent).not.toContain(',3');

    const bar = document.querySelector('sakutto-bar');
    expect(uiShadow(bar)?.textContent).toContain('翻訳できない箇所が 1 件残っています。');
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

describe('translation popup text size', () => {
  it('scales the tooltip, selection popover, and status without translating again', () => {
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
      { popupSize: 150 },
    );
    const hosts = ['sakutto-tip', 'sakutto-pop', 'sakutto-status'].map((tag) => {
      const host = document.querySelector<HTMLElement>(tag);
      if (!host) throw new Error(`missing ${tag}`);
      return host;
    });

    for (const host of hosts) {
      expect(host.style.getPropertyValue(POPUP_TEXT_SCALE_VAR)).toBe('1.5');
    }
    const tipCard = uiShadow(document.querySelector('sakutto-tip'))?.querySelector('.card');
    if (!(tipCard instanceof HTMLElement)) throw new Error('missing tip card');
    expect(tipCard.style.getPropertyValue(POPUP_TEXT_SCALE_VAR)).toBe('1.5');
    const bubbleStyle =
      uiShadow(document.querySelector('sakutto-tip'))?.querySelector('style')?.textContent ?? '';
    expect(bubbleStyle).toContain(`var(${POPUP_TEXT_SCALE_VAR}, 1)`);

    session.setPreferences(preferences({ popupSize: 80 }));
    for (const host of hosts) {
      expect(host.style.getPropertyValue(POPUP_TEXT_SCALE_VAR)).toBe('0.8');
    }

    // The setting is clamped and a record saved before the setting existed means 100%.
    session.setPreferences(preferences({ popupSize: 400 }));
    for (const host of hosts) {
      expect(host.style.getPropertyValue(POPUP_TEXT_SCALE_VAR)).toBe('2');
    }
    session.setPreferences(preferences({}));
    for (const host of hosts) {
      expect(host.style.getPropertyValue(POPUP_TEXT_SCALE_VAR)).toBe('1');
    }
  });

  it('scales the selection popover font size and card width', async () => {
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
      { popupSize: 100 },
    );
    const long =
      'This paragraph is long enough that the selection popover should grow wider when the text size increases instead of staying in a narrow column.';
    session.translateSelection(long, new DOMRect(40, 40, 220, 18));
    await vi.waitFor(() => {
      expect(uiShadow(document.querySelector('sakutto-pop'))?.textContent).toContain('訳:');
    });
    const popHost = document.querySelector('sakutto-pop');
    const at100 = popupCardMetrics(popHost);
    expect(at100?.fontSizePx).toBeCloseTo(12, 0);
    expect(at100?.maxWidthPx).toBeCloseTo(360, 0);

    session.setPreferences(preferences({ popupSize: 150 }));
    const at150 = popupCardMetrics(popHost);
    expect(at150?.fontSizePx).toBeCloseTo(18, 0);
    expect(at150?.maxWidthPx).toBeGreaterThan((at100?.maxWidthPx ?? 0) * 1.4);
    if ((at100?.widthPx ?? 0) > 0 && (at150?.widthPx ?? 0) > 0) {
      expect(at150?.widthPx).toBeGreaterThan(at100?.widthPx ?? 0);
    }
  });
});

describe('selection popup width', () => {
  interface PopupParts {
    host: HTMLElement;
    card: HTMLElement;
    left: HTMLButtonElement;
    right: HTMLButtonElement;
  }

  function popupParts(): PopupParts {
    const host = document.querySelector('sakutto-pop');
    if (!(host instanceof HTMLElement)) throw new Error('missing pop host');
    const shadow = uiShadow(host);
    const card = shadow?.querySelector('.card');
    const left = shadow?.querySelector('.resize-handle.left');
    const right = shadow?.querySelector('.resize-handle.right');
    if (!(card instanceof HTMLElement)) throw new Error('missing popup card');
    if (!(left instanceof HTMLButtonElement)) throw new Error('missing left handle');
    if (!(right instanceof HTMLButtonElement)) throw new Error('missing right handle');
    return { host, card, left, right };
  }

  async function showPopup(
    session: PageSession,
    rect = new DOMRect(40, 40, 220, 18),
  ): Promise<void> {
    session.translateSelection(
      'This paragraph is long enough that the selection popover has a useful width to drag.',
      rect,
    );
    await vi.waitFor(() => {
      expect(uiShadow(document.querySelector('sakutto-pop'))?.textContent).toContain('訳:');
    });
  }

  it('shows a right handle and only shows the left handle near the right edge', async () => {
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
    );
    await showPopup(session);
    const { left, right, card } = popupParts();
    expect(right.hidden).toBe(false);
    expect(right.getAttribute('aria-label')).toBe(labels.selectionResize);
    expect(left.hidden).toBe(true);
    const style = uiShadow(document.querySelector('sakutto-pop'))?.querySelector(
      'style',
    )?.textContent;
    expect(style).toContain('cursor: ew-resize');
    expect(card.style.cursor).toBe('');

    session.translateSelection(
      'This paragraph is long enough that the selection popover has a useful width to drag.',
      new DOMRect(700, 40, 80, 18),
    );
    expect(left.hidden).toBe(false);
    expect(left.getAttribute('aria-label')).toBe(labels.selectionResize);
  });

  it('resizes with pointer capture, keeps the popup open, and reports the chosen width', async () => {
    const saved: number[] = [];
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
      {},
      (width) => saved.push(width),
    );
    await showPopup(session);
    const { host, card, right } = popupParts();

    right.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        pointerId: 1,
      }),
    );
    document.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        clientX: 172,
        pointerId: 1,
      }),
    );
    document.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        clientX: 172,
        pointerId: 1,
      }),
    );

    expect(host.hidden).toBe(false);
    expect(card.dataset.resized).toBe('1');
    expect(Number.parseFloat(card.style.width)).toBeGreaterThan(14);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toBeGreaterThan(14);
  });

  it('resets to auto width on double-click and with a stored zero', async () => {
    const saved: number[] = [];
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
      { popupWidth: 20 },
      (width) => saved.push(width),
    );
    await showPopup(session);
    const { card, right } = popupParts();
    expect(card.style.width).toBe('20em');
    expect(card.style.maxWidth).toBe('calc(100vw - 16px)');

    right.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(card.style.width).toBe('');
    expect(card.style.maxWidth).toBe('');
    expect(card.dataset.resized).toBeUndefined();
    expect(saved).toEqual([0]);

    session.setPreferences(preferences({ popupWidth: 18 }));
    expect(card.style.width).toBe('18em');
    session.setPreferences(preferences({ popupWidth: 0 }));
    expect(card.style.width).toBe('');
  });

  it('resizes from the keyboard and keeps the width in em when text size changes', async () => {
    const saved: number[] = [];
    const session = start(
      document,
      immediate((text) => `訳:${text}`),
      { popupWidth: 20 },
      (width) => saved.push(width),
    );
    await showPopup(session);
    const { card, right } = popupParts();
    right.focus();
    right.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(card.style.width).toBe('21em');
    expect(saved).toEqual([21]);

    right.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
        cancelable: true,
        shiftKey: true,
      }),
    );
    expect(card.style.width).toBe('19em');
    expect(saved).toEqual([21, 19]);

    session.setPreferences(preferences({ popupSize: 150, popupWidth: 19 }));
    expect(card.style.width).toBe('19em');
    expect(card.style.maxWidth).toBe('calc(100vw - 16px)');
    expect(card.style.getPropertyValue(POPUP_TEXT_SCALE_VAR)).toBe('1.5');
  });
});

describe('selection popup translated-text scroll', () => {
  it('streams into the capped scroller: opens at the top, then pins the bottom', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments) {
        const segment = segments[0];
        if (!segment) return;
        yield { id: segment.id, textDelta: 'あ'.repeat(120), engine: 'plamo' as const };
        await gate;
        yield { id: segment.id, textDelta: 'あ'.repeat(240), engine: 'plamo' as const };
        yield { id: segment.id, final: 'あ'.repeat(360), engine: 'plamo' as const };
      }),
    );

    const body = uiShadow(document.querySelector('sakutto-pop'))?.querySelector('.body');
    if (!(body instanceof HTMLElement)) throw new Error('missing pop body');
    // A stand-in for the capped scroller's layout: a 300px port whose content grows a
    // pixel per character while the translation streams in.
    let scrollTop = 0;
    Object.defineProperty(body, 'scrollHeight', {
      configurable: true,
      get: () => 300 + (body.textContent?.length ?? 0),
    });
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    session.translateSelection('Hello world', new DOMRect(8, 8, 24, 12));
    // The pending placeholder opens the popup, and the capped area starts at the top.
    expect(body.textContent).toBe(labels.selectionPending);
    expect(scrollTop).toBe(0);

    await vi.waitFor(() => {
      expect(body.textContent).toBe('あ'.repeat(120));
    });
    // The placeholder gave way to the first chunk without jumping to the end.
    expect(scrollTop).toBe(0);

    // The reader wheels to the bottom of what has arrived; the gesture stays inside.
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      composed: true,
      deltaY: 200,
    });
    body.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(scrollTop).toBe(120);

    // The next chunk keeps the newest text in view instead of hiding it below the fold.
    release();
    await vi.waitFor(() => {
      expect(body.textContent).toBe('あ'.repeat(360));
    });
    expect(scrollTop).toBe(360);
    await session.whenIdle();
    expect(scrollTop).toBe(360);
  });
});

describe('selection offers on a never host and at init', () => {
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
  });

  function icon(): HTMLElement {
    const node = document.querySelector('sakutto-select');
    if (!(node instanceof HTMLElement)) throw new Error('missing selection icon');
    return node;
  }

  function selectLead(): void {
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing lead');
    const range = document.createRange();
    range.selectNodeContents(lead);
    const selection = document.getSelection();
    if (!selection) throw new Error('missing selection');
    selection.removeAllRanges();
    selection.addRange(range);
  }

  it('stays quiet while suppressed, then offers again once suppression lifts', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Osaka is a designated city.</p>';
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
    const session = start(
      document,
      engineOf(async function* (segments) {
        seen.push(segments.map((segment) => segment.text).join('|'));
        const segment = segments[0];
        if (!segment) return;
        yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
      }),
    );

    try {
      session.setSelectionOffersSuppressed(true);
      selectLead();
      document.dispatchEvent(new Event('selectionchange'));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(icon().hidden).toBe(true);
      expect(seen).toEqual([]);

      session.setSelectionOffersSuppressed(false);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(icon().hidden).toBe(false);
      expect(seen).toEqual(['Osaka is a designated city.']);
    } finally {
      rects.mockRestore();
      box.mockRestore();
    }
  });

  it('offers a selection that already existed when the script initialized, once', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p id="lead">Hello world</p>';
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
    start(
      document,
      engineOf(async function* (segments) {
        seen.push(segments.map((segment) => segment.text).join('|'));
        const segment = segments[0];
        if (!segment) return;
        yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
      }),
    );

    try {
      // The highlight is made without firing selectionchange or pointerup, the way a
      // selection that predates the content script looks to the page.
      selectLead();
      (sessions.at(-1) as PageSession).offerExistingSelection();
      expect(icon().hidden).toBe(false);
      expect(seen).toEqual(['Hello world']);

      // One offer, no loop: a repeat does not queue the same selection twice.
      (sessions.at(-1) as PageSession).offerExistingSelection();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(seen).toEqual(['Hello world']);
    } finally {
      rects.mockRestore();
      box.mockRestore();
    }
  });

  it('does not translate the page when offering an existing selection', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML =
      '<p id="lead">Selected phrase</p><p id="rest">This page text stays.</p>';
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
    const session = start(
      document,
      engineOf(async function* (segments) {
        seen.push(segments.map((segment) => segment.text).join('|'));
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
        }
      }),
    );

    try {
      selectLead();
      session.offerExistingSelection();
      await session.whenIdle();
      expect(seen).toEqual(['Selected phrase']);
      expect(document.querySelector('#rest')?.textContent).toBe('This page text stays.');
      expect(document.body.textContent).not.toContain('訳:This');
    } finally {
      rects.mockRestore();
      box.mockRestore();
    }
  });

  it('offers nothing when no selection exists at init', () => {
    document.body.innerHTML = '<p id="lead">Hello world</p>';
    const session = start(
      document,
      immediate((source) => `訳:${source}`),
    );
    session.offerExistingSelection();
    expect(icon().hidden).toBe(true);
  });
});

describe('X detail conversation', () => {
  function xEngine(seen: string[]): PageEngine {
    return engineOf(async function* (segments) {
      for (const segment of segments) {
        seen.push(segment.text);
        yield { id: segment.id, final: `§en§${segment.text}`, engine: 'plamo' as const };
      }
    });
  }

  const xPreferences = {
    targetLanguage: 'en',
    display: 'bilingual' as const,
    auto: 'always' as const,
  };

  it('translates a reply mounted in the same tick as the main tweet is painted', async () => {
    document.documentElement.lang = 'ja';
    const main = '最初の投稿です。'.repeat(12);
    document.body.innerHTML =
      '<article data-testid="tweet"><div id="main" data-testid="tweetText" lang="ja">' +
      main +
      '</div></article><div id="conversation"></div>';
    let injected = false;
    // X lazy-loads the conversation while the primary tweet is being painted. The page's
    // mutation and our paint land in the same observer callback, which used to be discarded.
    const pageObserver = new MutationObserver((records) => {
      if (injected) return;
      const painted = records.some((record) =>
        [...record.addedNodes].some(
          (node) => node instanceof Element && node.tagName === 'SAKUTTO-LINE',
        ),
      );
      if (!painted) return;
      injected = true;
      const conversation = document.getElementById('conversation');
      if (!conversation) return;
      conversation.innerHTML =
        '<article data-testid="tweet"><div id="reply" data-testid="tweetText" lang="ja">' +
        `返信の本文です。${'続き。'.repeat(30)}` +
        '</div></article>';
    });
    pageObserver.observe(document.body, { childList: true, subtree: true });
    try {
      const seen: string[] = [];
      const session = start(document, xEngine(seen), xPreferences);
      await session.translate();
      await session.whenIdle();
      await new Promise((resolve) => setTimeout(resolve, 60));
      await session.whenIdle();

      expect(injected).toBe(true);
      expect(seen.some((source) => source.includes('返信'))).toBe(true);
      expect(document.querySelector('#reply > sakutto-line')?.textContent).toContain(
        '§en§返信の本文です',
      );
    } finally {
      pageObserver.disconnect();
    }
  });

  it('translates a conversation injected after a pushState navigation', async () => {
    document.documentElement.lang = 'ja';
    document.body.innerHTML =
      '<article data-testid="tweet"><div id="main" data-testid="tweetText" lang="ja">' +
      `最初の投稿です。${'続き。'.repeat(30)}` +
      '</div></article><div id="spa"></div>';
    const seen: string[] = [];
    const session = start(document, xEngine(seen), xPreferences);
    await session.translate();
    await session.whenIdle();
    expect(seen.some((source) => source.includes('最初の投稿'))).toBe(true);

    document.defaultView?.history.pushState({}, '', '/i/web/status/165');
    const spa = document.getElementById('spa');
    if (!spa) throw new Error('missing SPA root');
    spa.innerHTML =
      '<article data-testid="tweet"><div id="spa-reply" data-testid="tweetText" lang="ja">' +
      `SPA後の返信です。${'続き。'.repeat(30)}` +
      '</div></article>';
    await new Promise((resolve) => setTimeout(resolve, 60));
    await session.whenIdle();

    expect(seen.some((source) => source.includes('SPA後の返信'))).toBe(true);
    expect(document.querySelector('#spa-reply > sakutto-line')?.textContent).toContain(
      '§en§SPA後の返信です',
    );
  });
});

describe('X logged-in pre-wrap bodies', () => {
  it('requests each raw line once and puts its answer back on that line', async () => {
    document.documentElement.lang = 'ja';
    const lines = [
      'ログイン済みのタイムラインでは本文が白折返しで描画されます。',
      '短い行が続く場合でも対訳の同じ位置に改行が残ることを確認します。',
      '絵文字の画像が混ざる行も訳せます。',
      'ハッシュタグやメンションを含む行も一行ずつ要求として送られます。',
      'ハッシュタグとメンションを含む行です。',
      '空白行をはさんでも訳文が混ざらないことを確かめる六行目です。',
      '七行目も同じ間隔で訳文が配置され原文の改行が保たれます。',
      '最後の行まで崩れずに表示されることを確認するための八行目です。',
    ];
    document.body.innerHTML =
      '<article><div id="logged" data-testid="tweetText" lang="ja" class="r-whitespace-pre-wrap">' +
      lines.map((line) => `<span>${line}</span>`).join('\n\n') +
      '</div></article>';

    const seen: string[] = [];
    const engine = engineOf(async function* (segments) {
      for (const segment of segments) {
        seen.push(segment.text);
        yield {
          id: segment.id,
          final: `§en§${segment.text}`,
          engine: 'plamo' as const,
        };
      }
    });
    const session = start(document, engine, {
      targetLanguage: 'en',
      display: 'bilingual',
      auto: 'always',
    });
    await session.translate();
    await session.whenIdle();

    expect(seen).toHaveLength(lines.length);
    expect(seen.every((text) => !text.includes('\n'))).toBe(true);
    expect(seen).not.toContain('');
    const line = document.querySelector('#logged > sakutto-line');
    expect(line?.querySelectorAll('br')).toHaveLength(14);
    const chunks = Array.from(line?.childNodes ?? [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue ?? '');
    expect(chunks).toHaveLength(15);
    expect(chunks.filter((chunk) => chunk.trim().length === 0)).toHaveLength(7);
    expect(chunks.filter((chunk) => chunk.trim().length > 0)).toEqual(
      lines.map((line) => `§en§${line}`),
    );
  });

  it('keeps line pieces aligned when a missing placeholder forces a flatten retry', async () => {
    document.documentElement.lang = 'ja';
    document.body.innerHTML =
      '<article><div id="logged" data-testid="tweetText" lang="ja" class="r-whitespace-pre-wrap">' +
      '<span>最初の行には長い日本語の本文が書かれています。続きの文章も十分に長く用意しています。</span>\n\n' +
      '<span><a href="/hashtag/野球">#野球</a> を含む二行目も長い本文です。続きの文章をさらに足しています。</span>\n\n' +
      '<span>最後の行には三分の本文を書いています。最後まで長さを保つための追加文章です。</span>' +
      '</div></article>';
    const seen: string[] = [];
    const engine = engineOf(async function* (segments) {
      for (const segment of segments) {
        seen.push(segment.text);
        // First round drops the placeholder tags, so the session retries flat.
        const text =
          seen.length <= segments.length ? segment.text.replace(/<\/?i\d+>/gu, '') : segment.text;
        yield { id: segment.id, final: `§en§${text}`, engine: 'plamo' as const };
      }
    });
    const session = start(document, engine, {
      targetLanguage: 'en',
      display: 'bilingual',
      auto: 'always',
    });
    await session.translate();
    await session.whenIdle();

    expect(seen).toHaveLength(6);
    expect(seen.every((text) => !text.includes('\n'))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await session.whenIdle();
    const line = document.querySelector('#logged > sakutto-line');
    expect(line?.querySelectorAll('br')).toHaveLength(4);
    const chunks = Array.from(line?.childNodes ?? [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue ?? '');
    expect(chunks).toHaveLength(5);
    expect(chunks.filter((chunk) => chunk.trim().length === 0)).toHaveLength(2);
    expect(line?.textContent).not.toContain('<i');
  });

  it('keeps a finished line on its source line during sentence reveal', async () => {
    document.documentElement.lang = 'ja';
    const lines = [
      '最初の行は長い日本語の本文です。訳文が一行目にそのまま入ることを確認します。',
      '二行目も同じ長さの本文を用意しています。まだ訳が返ってこない段階を確認します。',
      '三行目まで含めて三つの要求に分かれます。最後の行まで崩れないことを確かめます。',
    ];
    document.body.innerHTML =
      '<article><div id="logged" data-testid="tweetText" lang="ja" class="r-whitespace-pre-wrap">' +
      lines.map((line) => `<span>${line}</span>`).join('\n\n') +
      '</div></article>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = start(
      document,
      engineOf(async function* (segments, options: TranslateOptions) {
        for (const [index, segment] of segments.entries()) {
          if (index > 0) {
            await gate;
            if (options.signal.aborted) return;
          }
          yield {
            id: segment.id,
            final: `Translated line ${index + 1}.`,
            engine: 'plamo' as const,
          };
        }
      }),
      {
        targetLanguage: 'en',
        display: 'bilingual',
        reveal: 'sentence',
        auto: 'always',
      },
    );
    const translating = session.translate();
    await vi.waitFor(() => {
      expect(document.querySelector('#logged > sakutto-line')?.textContent).toContain(
        'Translated line 1.',
      );
    });

    const partial = Array.from(document.querySelector('#logged > sakutto-line')?.childNodes ?? [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue ?? '');
    expect(partial[0]).toBe('Translated line 1.');
    expect(partial.filter((chunk) => chunk.trim().length > 0)).toEqual(['Translated line 1.']);

    release();
    await translating;
    await session.whenIdle();
    const finalLine = document.querySelector('#logged > sakutto-line');
    const final = Array.from(finalLine?.childNodes ?? [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue ?? '');
    expect(final).toEqual([
      'Translated line 1.',
      '',
      'Translated line 2.',
      '',
      'Translated line 3.',
    ]);
  });

  it('keeps the blank line bytes on the preceding source line in replace mode', async () => {
    document.documentElement.lang = 'ja';
    const lines = [
      '最初の行には十分な長さの日本語の本文を用意しています。',
      '二行目も同じように長い文章を書いています。',
      '三行目まで空白行をはさんで訳文が並ぶことを確認します。',
    ];
    document.body.innerHTML =
      '<article><div id="logged" data-testid="tweetText" lang="ja" class="r-whitespace-pre-wrap">' +
      lines.join('\n\n') +
      '</div></article>';

    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          seen.push(segment.text);
          yield {
            id: segment.id,
            final: `Translated ${String(seen.length)}.`,
            engine: 'plamo' as const,
          };
        }
      }),
      { targetLanguage: 'en', display: 'replace', auto: 'always' },
    );
    await session.translate();
    await session.whenIdle();

    expect(seen).toEqual(lines);
    expect(document.querySelector('#logged')?.textContent).toBe(
      'Translated 1.\n\nTranslated 2.\n\nTranslated 3.',
    );
  });
});

describe('community board comments', () => {
  it('sends every line of a bare pre to the engine and keeps its line breaks', async () => {
    document.documentElement.lang = 'ko';
    // Synthetic arca.live markup: the body sits in div.message > div.text > pre, and a bare
    // pre is prose here rather than a code fence. The reply is nested one wrapper deeper.
    const article = '이 글은 연습용 게시물입니다.';
    const commentLines = [
      '첫 번째 댓글은 짧은 연습 문장입니다.',
      '두 번째 줄에는 줄바꿈이 남아 있습니다.',
    ];
    const replyLines = ['답글도 같은 방식으로 번역됩니다.', '답글의 두 번째 줄도 그대로 남습니다.'];
    const comment = commentLines.join('\n');
    const reply = replyLines.join('\n');
    document.body.innerHTML = `
      <article><p id="article">${article}</p></article>
      <div id="comment" class="article-comment">
        <div class="list-area">
          <div class="comment-wrapper">
            <div class="comment-item">
              <div class="content">
                <div class="message"><div class="text"><pre id="comment-body">${comment}</pre></div></div>
              </div>
              <div class="comment-wrapper">
                <div class="comment-item">
                  <div class="content">
                    <div class="message"><div class="text"><pre id="reply-body">${reply}</pre></div></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="comment-wrapper" id="coded">
            <div class="comment-item">
              <div class="content">
                <div class="message"><div class="text"><pre><code>const answer = 42;</code></pre></div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          seen.push(segment.text);
          yield { id: segment.id, final: `EN:${segment.text}`, engine: 'plamo' as const };
        }
      }),
      { targetLanguage: 'en', display: 'bilingual', auto: 'always' },
    );

    await session.translate();
    await session.whenIdle();

    expect(seen).toEqual([article, ...commentLines, ...replyLines]);
    expect(seen.every((text) => !text.includes('\n'))).toBe(true);
    expect(document.querySelector('#article > sakutto-line')?.textContent).toBe(`EN:${article}`);
    expect(document.querySelector('#comment-body')?.textContent).toBe(
      commentLines.map((line) => `EN:${line}`).join('\n'),
    );
    expect(document.querySelector('#reply-body')?.textContent).toBe(
      replyLines.map((line) => `EN:${line}`).join('\n'),
    );
    // A bare pre is not a prose tag, so bilingual mode paints its answer in place.
    expect(document.querySelectorAll('sakutto-line')).toHaveLength(1);
    expect(document.querySelector('#coded pre')?.textContent).toBe('const answer = 42;');
  });

  it('never queues bare code, algorithm blocks or highlighted fences', async () => {
    document.documentElement.lang = 'ko';
    document.body.innerHTML = `
      <div><pre id="bare">const answer = 42;</pre></div>
      <pre class="algorithm" id="algorithm">for block in page:
    continue</pre>
      <div class="message"><div class="text"><pre id="highlighted"><span class="k">const</span> answer = 42;</pre></div></div>
      <div class="message"><div class="text"><pre id="fence"><code>const answer = 42;</code></pre></div></div>
    `;
    const originals = new Map(
      [...document.querySelectorAll('pre')].map((pre) => [pre.id, pre.textContent] as const),
    );
    const seen: string[] = [];
    const session = start(
      document,
      engineOf(async function* (segments) {
        for (const segment of segments) {
          seen.push(segment.text);
          yield { id: segment.id, final: `EN:${segment.text}`, engine: 'plamo' as const };
        }
      }),
      { targetLanguage: 'en', display: 'replace', auto: 'always' },
    );

    await session.translate();
    await session.whenIdle();

    expect(seen).toEqual([]);
    for (const [id, original] of originals) {
      expect(isTranslationExcluded(document.querySelector(`#${id}`)!)).toBe(true);
      expect(document.querySelector(`#${id}`)?.textContent).toBe(original);
    }
  });
});
