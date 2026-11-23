// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildSegment } from '@/dom/segment';
import { applyTranslation, showBilingual } from '@/dom/render';

const THREE_PARAGRAPHS =
  '<div data-testid="tweetText">' +
  '<span>最初の段落には十分な長さの日本語の本文が書かれています。</span><br><br>' +
  '<span>二番目の段落にも十分な長さの文章を用意しています。</span><br><br>' +
  '<span>最後の段落にも十分な長さの文章を書いています。</span>' +
  '</div>';

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
});
