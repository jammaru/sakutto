// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildSegment } from '@/dom/segment';
import { applyTranslation, showBilingual } from '@/dom/render';
import { isBodyCopy } from '@/dom/session';
import { stripPlaceholderTokens } from '@/dom/placeholders';
import { shouldPreserveNewlines } from '@/dom/x-post';

const THREE_PARAGRAPHS =
  '<div data-testid="tweetText">' +
  '<span>最初の段落には十分な長さの日本語の本文が書かれています。</span><br><br>' +
  '<span>二番目の段落にも十分な長さの文章を用意しています。</span><br><br>' +
  '<span>最後の段落にも十分な長さの文章を書いています。</span>' +
  '</div>';

const TWO_EQUAL_PARAGRAPHS =
  '<div data-testid="tweetText">' +
  '<span>A short first line.</span><br><br>' +
  '<span>Another short line.</span>' +
  '</div>';

const PREWRAP_STACK =
  '<div data-testid="tweetText" lang="ja" class="r-whitespace-pre-wrap">' +
  [
    '<span>ログイン済みのタイムラインでは本文が白折返しで描画されます。</span>',
    '<span>短い行が続く場合でも、対訳の同じ位置に改行が残ることを確認します。</span>',
    '<span>絵文字の画像が混ざる行も訳せます。<img alt="🌸" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" /></span>',
    '<span>ハッシュタグやメンションを含む行も、一行ずつ要求として送られます。</span>',
    '<span><a href="/hashtag/日本語">#日本語</a> と <a href="/user9">@user9</a> を含む行です。</span>',
    '<span>空白行をはさんでも訳文が混ざらないことを確かめる六行目です。</span>',
    '<span>七行目も同じ間隔で訳文が配置され、原文の改行が保たれます。</span>',
    '<span>最後の行まで崩れずに表示されることを確認するための八行目です。</span>',
  ].join('\n\n') +
  '</div>';

const PREWRAP_EN_LINES = [
  'Welcome to Osaka!',
  'This is the second sentence.',
  'Come see me!',
  'Hope you visit.',
  'The fifth line continues this single paragraph.',
  'The sixth line has no newline.',
  'The seventh line stays glued to the next.',
  'The eighth line ends the flat paragraph.',
];

function bilingual(html: string, translation: string): { chunks: string[]; breaks: number } {
  document.body.innerHTML = html;
  const block = document.querySelector('[data-testid="tweetText"]');
  if (!block) throw new Error('missing block');
  const model = buildSegment(block);
  if (!model) throw new Error('missing segment');
  showBilingual(model, translation, []);
  const line = block.querySelector('sakutto-line');
  const nodes = Array.from(line?.childNodes ?? []);
  return {
    chunks: nodes
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue ?? ''),
    breaks: nodes.filter((node) => node instanceof Element && node.localName === 'br').length,
  };
}

describe('X bilingual rendering', () => {
  it('spreads a flat English output over the source paragraphs and restores Latin spaces', () => {
    const { chunks, breaks } = bilingual(
      THREE_PARAGRAPHS,
      'Welcome to Osaka!This is the second sentence.Come see me!Hope you visit.',
    );
    expect(breaks).toBe(4);
    expect(chunks).toHaveLength(5);
    expect(chunks[0]).toContain('Welcome to Osaka!');
    expect(chunks[2]).toContain('This is the second sentence. Come see me!');
    expect(chunks[4]).toContain('Hope you visit.');
    for (const chunk of chunks) expect(chunk).not.toMatch(/[!?][A-Za-z]/u);
    expect(chunks[1]).toBe('');
    expect(chunks[3]).toBe('');
  });

  it('distributes flat text without any sentence terminator across all paragraphs', () => {
    const translation =
      'one long flat paragraph without any terminator at all that should still be spread over the source paragraphs';
    const { chunks, breaks } = bilingual(THREE_PARAGRAPHS, translation);
    expect(breaks).toBe(4);
    expect(chunks.filter((chunk) => chunk.length > 0)).toHaveLength(3);
    expect(chunks.join('').replaceAll(' ', '')).toBe(translation.replaceAll(' ', ''));
  });

  it('joins glued Latin sentences with a space inside one paragraph', () => {
    const { chunks, breaks } = bilingual(
      '<div data-testid="tweetText"><span>First line.</span><br><br><span>Second line.</span></div>',
      'Welcome to Osaka!This is the second sentence. Come see me!hope you visit.',
    );
    expect(breaks).toBe(2);
    expect(chunks).toEqual([
      'Welcome to Osaka! This is the second sentence.',
      '',
      'Come see me! hope you visit.',
    ]);
  });

  it('keeps a single line break inside a paragraph as one br in the bilingual line', () => {
    const { chunks, breaks } = bilingual(
      '<div data-testid="tweetText"><span>First line.</span><br><span>Second line.</span></div>',
      'Translated first line.Translated second line.',
    );
    expect(breaks).toBe(1);
    expect(chunks).toEqual(['Translated first line.', 'Translated second line.']);
  });

  it('does not add spaces in replacement mode', () => {
    document.body.innerHTML = '<p data-testid="tweetText">First line.</p>';
    const block = document.querySelector('[data-testid="tweetText"]');
    if (!block) throw new Error('missing block');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');
    applyTranslation(model, 'Welcome to Osaka!This is the second sentence.', []);
    expect(block.textContent).toBe('Welcome to Osaka!This is the second sentence.');
    expect(block.querySelector('sakutto-line')).toBeNull();
  });

  it('keeps bare domains, filenames and abbreviations intact when restoring glued sentences', () => {
    const { chunks } = bilingual(
      TWO_EQUAL_PARAGRAPHS,
      'See example.com and node.js for details. Visit second.example.org today!Thanks. ' +
        'Read README.md about U.S.A. policy!Then continue. Open https://example.com/a.B or ' +
        'mail foo.bar@example.com now!Done.',
    );
    for (const token of [
      'example.com',
      'node.js',
      'second.example.org',
      'README.md',
      'U.S.A.',
      'https://example.com/a.B',
      'foo.bar@example.com',
    ]) {
      expect(
        chunks.some((chunk) => chunk.includes(token)),
        token,
      ).toBe(true);
    }
    const joined = chunks.join('');
    expect(joined).toContain('today! Thanks.');
    expect(joined).toContain('policy! Then');
    expect(joined).toContain('now! Done.');
    expect(joined).not.toMatch(/\b(?:example|README|node)\.\s+/u);
  });

  it('splits glued non-ASCII Latin sentences without touching their letters', () => {
    const { chunks } = bilingual(TWO_EQUAL_PARAGRAPHS, 'Bonjour!Ça va?Oui. Привет!Как дела?');
    const joined = chunks.join('');
    expect(joined).toContain('Bonjour! Ça');
    expect(joined).toContain('Привет! Как');
  });

  it('keeps emoji grapheme clusters intact across CJK paragraph gaps', () => {
    const family = '👨‍👩‍👧‍👦';
    const translation = `最初の文です${family}二番目の文です`;
    const { chunks } = bilingual(TWO_EQUAL_PARAGRAPHS, translation);
    expect(chunks.join('')).toBe(translation);
    expect(chunks.some((chunk) => chunk.includes(family))).toBe(true);
    expect(chunks.filter((chunk) => chunk.length > 0)).toHaveLength(2);
  });

  it('keeps combining marks with their base letter across CJK paragraph gaps', () => {
    const translation = '最初の文ですe\u0301二番目の文です';
    const { chunks } = bilingual(TWO_EQUAL_PARAGRAPHS, translation);
    expect(chunks.join('')).toBe(translation);
    expect(chunks.some((chunk) => chunk.includes('e\u0301'))).toBe(true);
  });

  it('treats guest post bodies like tweetText but not stray lang divs', () => {
    document.body.innerHTML = [
      '<article><div><div id="guest" lang="ja" dir="auto" class="text-body whitespace-pre-wrap wrap-anywhere"></div></div></article>',
      '<div id="stray" lang="ja" dir="auto" class="whitespace-pre-wrap"></div>',
      '<article><div id="no-class" lang="ja" dir="auto"></div></article>',
      '<div id="legacy" data-testid="tweetText"></div>',
    ].join('');
    expect(isBodyCopy(document.getElementById('guest') as Element)).toBe(true);
    expect(isBodyCopy(document.getElementById('legacy') as Element)).toBe(true);
    expect(isBodyCopy(document.getElementById('stray') as Element)).toBe(false);
    expect(isBodyCopy(document.getElementById('no-class') as Element)).toBe(false);
  });

  it('reads raw pre-wrap newlines as paragraph breaks without changing the source nodes', () => {
    document.body.innerHTML =
      '<article><div><div id="guest" lang="ja" dir="auto" class="text-body whitespace-pre-wrap">' +
      '<span>最初の段落には十分な長さの日本語の本文が書かれています。</span>' +
      '<span>\n\n二番目の段落にも十分な長さの文章を用意しています。\n</span>' +
      '<span>三番目の段落も同じ本文のspanの中に改行だけで続いています。</span>' +
      '</div></div></article>';
    const block = document.getElementById('guest') as Element;
    expect(block.querySelector('br')).toBeNull();
    const model = buildSegment(block);
    expect(stripPlaceholderTokens(model?.source ?? '')).toBe(
      '最初の段落には十分な長さの日本語の本文が書かれています。\n\n' +
        '二番目の段落にも十分な長さの文章を用意しています。\n' +
        '三番目の段落も同じ本文のspanの中に改行だけで続いています。',
    );
    showBilingual(model as NonNullable<typeof model>, '§en§One.\n\nTwo.\nThree.', []);
    const line = block.querySelector('sakutto-line') as Element;
    expect(line.querySelectorAll('br')).toHaveLength(3);
    expect(line.textContent).toContain('§en§One.');
    expect(block.querySelectorAll('span')).toHaveLength(3);
  });

  it('keeps inline entities and Unicode emoji around guest paragraph gaps', () => {
    document.body.innerHTML =
      '<article><div><div id="guest" lang="ja" dir="auto" class="text-lead whitespace-pre-wrap">' +
      '<span>17時から生配信します⚡️</span><span><a href="/hashtag/野球">#野球</a></span>' +
      '<span> </span><span><a href="/user5">@user5</a></span>' +
      '<span>\n\n次の段落です。</span></div></div></article>';
    const block = document.getElementById('guest') as Element;
    const model = buildSegment(block);
    expect(model?.source).toMatch(/<i\d+>#野球<\/i\d+>/u);
    expect(model?.source).toMatch(/<i\d+>@user5<\/i\d+>/u);
    expect(stripPlaceholderTokens(model?.source ?? '')).toContain('⚡️');
    expect(stripPlaceholderTokens(model?.source ?? '')).toContain('\n\n');
    showBilingual(
      model as NonNullable<typeof model>,
      '§en§Live now #baseball with @user5\n\nNext paragraph.',
      [],
    );
    expect(block.querySelector('a[href="/hashtag/野球"]')).not.toBeNull();
    expect(block.querySelector('a[href="/user5"]')).not.toBeNull();
    expect(block.textContent).toContain('⚡️');
    const line = block.querySelector('sakutto-line') as Element;
    expect(line.textContent).toContain('#baseball');
    expect(line.textContent).toContain('Next paragraph.');
    expect(line.querySelectorAll('br')).toHaveLength(2);
  });

  it('recognizes logged-in tweetText bodies that paint raw newlines', () => {
    document.body.innerHTML = [
      '<article><div id="class" data-testid="tweetText" lang="ja" class="r-whitespace-pre-wrap"></div></article>',
      '<article><div id="style" data-testid="tweetText" lang="ja" style="white-space: pre-line"></div></article>',
      '<div id="no-lang" data-testid="tweetText" class="r-whitespace-pre-wrap"></div>',
      '<div id="plain" data-testid="tweetText" lang="ja"></div>',
    ].join('');
    expect(shouldPreserveNewlines(document.getElementById('class') as Element)).toBe(true);
    expect(shouldPreserveNewlines(document.getElementById('style') as Element)).toBe(true);
    expect(shouldPreserveNewlines(document.getElementById('no-lang') as Element)).toBe(false);
    expect(shouldPreserveNewlines(document.getElementById('plain') as Element)).toBe(false);
  });

  it('keeps raw pre-wrap gaps with real-engine-shaped flat output', () => {
    const { chunks, breaks } = bilingual(PREWRAP_STACK, PREWRAP_EN_LINES.join('\n\n'));
    expect(breaks).toBe(14);
    expect(chunks).toHaveLength(15);
    expect(chunks.filter((chunk) => chunk.trim().length === 0)).toHaveLength(7);
    expect(chunks.filter((chunk) => chunk.trim().length > 0)).toEqual(PREWRAP_EN_LINES);
    for (const chunk of chunks) expect(chunk).not.toContain('\n');
    const block = document.querySelector('[data-testid="tweetText"]') as Element;
    expect(
      Array.from(block.children).filter(
        (child) => child.localName !== 'sakutto-line' && child.localName === 'br',
      ),
    ).toHaveLength(0);
    expect(block.querySelector('img[alt="🌸"]')).not.toBeNull();
  });
});
