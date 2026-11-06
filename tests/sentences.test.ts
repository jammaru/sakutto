import { describe, expect, it } from 'vitest';
import {
  chunkForTranslation,
  joinTranslatedSentences,
  sentenceSeparator,
  splitForTranslation,
} from '@/engine/text/sentences';

const LONG_EN =
  'Modern browsers can translate pages on the device itself. ' +
  'That keeps the text private while the reader scrolls through a long document. ' +
  'A paragraph with several sentences is split before it reaches the model. ' +
  'The first sentence can then appear while the rest is still being generated. ' +
  'This keeps the reading flow intact even on a slower machine.';

describe('sentence splitting', () => {
  it('keeps short paragraphs unchanged', () => {
    expect(splitForTranslation('Hello. World.')).toEqual(['Hello. World.']);
  });

  it('splits a long paragraph into sentences', () => {
    const parts = splitForTranslation(LONG_EN);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts[0]).toBe('Modern browsers can translate pages on the device itself.');
    expect(parts.join(' ')).toContain(
      'This keeps the reading flow intact even on a slower machine.',
    );
  });

  it('does not split after common abbreviations', () => {
    const text =
      'Dr. Smith reviewed the results carefully before the meeting. ' +
      'The team agreed with every point in the summary. ' +
      'We will publish the final version next week.';
    const parts = splitForTranslation(text, { sentenceThreshold: 60 });

    expect(parts[0]?.startsWith('Dr. Smith reviewed')).toBe(true);
  });

  it('does not split decimal numbers', () => {
    const text =
      'Version 3.14 of the tool shipped today with a smaller download. ' +
      'Users upgraded quickly and reported fewer crashes. ' +
      'The next release is planned for the end of the month.';
    const parts = splitForTranslation(text, { sentenceThreshold: 60 });

    expect(parts[0]).toContain('Version 3.14 of the tool');
    expect(parts.every((part) => !part.startsWith('14'))).toBe(true);
  });

  it('does not split inside URLs or placeholder tags', () => {
    const text =
      'Read https://example.com/a.b for details before you start. ' +
      'Click <a1>Settings. Then</a1> to pick a profile. ' +
      'Continue with the rest of the setup when you are ready. ' +
      'This extra sentence pushes the paragraph past the split threshold.';

    const parts = splitForTranslation(text, { sentenceThreshold: 80 });
    const joined = parts.join(' ');

    expect(joined).toContain('https://example.com/a.b');
    for (const part of parts) {
      const opens = part.match(/<a1>/g)?.length ?? 0;
      const closes = part.match(/<\/a1>/g)?.length ?? 0;
      expect(opens).toBe(closes);
    }
  });

  it('splits Japanese paragraphs on full stops', () => {
    const text =
      'ブラウザの中で翻訳すると、本文が端末の外に出ません。' +
      '長い段落は文ごとに分けてからモデルに渡します。' +
      '最初の文が先に表示されるので、待ち時間が短く感じられます。' +
      '残りの文は後から続けて表示されます。';

    const parts = splitForTranslation(text, { sentenceThreshold: 40 });
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe('ブラウザの中で翻訳すると、本文が端末の外に出ません。');
  });

  it('hard splits very long sentences at spaces', () => {
    const text = `${'word '.repeat(200)}end.`;
    const parts = splitForTranslation(text, { sentenceThreshold: 100, maxChunkChars: 120 });

    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((part) => part.length <= 130)).toBe(true);
  });

  it('hard splits long text without spaces', () => {
    const text = '長'.repeat(1000);
    const parts = splitForTranslation(text, { sentenceThreshold: 300, maxChunkChars: 120 });

    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((part) => part.length <= 120)).toBe(true);
    expect(parts.join('')).toBe(text);
  });

  it('joins translated sentences with the target language spacing', () => {
    expect(joinTranslatedSentences([' First.', 'Second. '], 'en')).toBe('First. Second.');
    expect(joinTranslatedSentences(['最初。', '次。'], 'ja')).toBe('最初。次。');
    expect(sentenceSeparator('zh-hant')).toBe('');
    expect(sentenceSeparator('ko')).toBe(' ');
  });

  it('keeps an ordinary paragraph whole so the model sees its context', () => {
    expect(chunkForTranslation(` ${LONG_EN} `)).toEqual([LONG_EN]);
  });

  it('cuts a very long paragraph only between sentences', () => {
    const text = Array.from({ length: 6 }, () => LONG_EN).join(' ');
    const pieces = chunkForTranslation(text, 600);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(600);
      expect(piece.endsWith('.')).toBe(true);
      expect(piece.split('. ').length).toBeGreaterThan(2);
    }
    expect(pieces.join(' ')).toBe(text);
  });
});
