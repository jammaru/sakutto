import { describe, expect, it } from 'vitest';
import {
  PLAIN_TEXT_LINE_BREAK_MODES,
  applyPlainTextLineBreaks,
  normalizePlainTextLineBreaks,
  plainTextTranslationInput,
  preparePlainTextForModel,
  type PlainTextBreakMap,
} from '@/shared/plain-text-line-breaks';

function prepared(source: string): { modelText: string; breakMap: PlainTextBreakMap } {
  return preparePlainTextForModel(source);
}

function apply(
  source: string,
  translation: string,
  mode: Parameters<typeof applyPlainTextLineBreaks>[3],
) {
  const { modelText, breakMap } = prepared(source);
  return applyPlainTextLineBreaks(modelText, translation, breakMap, mode);
}

function stripBreaks(text: string): string {
  return text.replace(/\s+/gu, '');
}

describe('plain text line break modes', () => {
  it('keeps the normalized source for the engine when mode is none', () => {
    const source = 'The cold morning began.\nHe opened the door.';
    expect(plainTextTranslationInput(source, 'none')).toEqual({
      engineText: source,
      breakMap: null,
    });
    const joined = plainTextTranslationInput(source, 'keep');
    expect(joined.engineText).toBe('The cold morning began. He opened the door.');
    expect(joined.breakMap).not.toBeNull();
  });

  it('lists every supported mode', () => {
    expect(PLAIN_TEXT_LINE_BREAK_MODES).toEqual(['none', 'keep', 'blank', 'wider']);
    expect(normalizePlainTextLineBreaks(undefined)).toBe('none');
    expect(normalizePlainTextLineBreaks('keep')).toBe('keep');
    expect(normalizePlainTextLineBreaks('blank')).toBe('blank');
    expect(normalizePlainTextLineBreaks('wider')).toBe('wider');
    expect(normalizePlainTextLineBreaks('unknown')).toBe('none');
  });

  it('keeps the none mode byte-for-byte identical to the old translation', () => {
    const translation = '寒い朝が始まった。彼はドアを開けた。';
    expect(apply('The cold morning began.\nHe opened the door.', translation, 'none')).toBe(
      translation,
    );
    expect(translation.includes('\n')).toBe(false);
  });

  it('applies each separator mode at the same mapped sentence boundary', () => {
    const source = 'The cold morning began.\nHe opened the door.';
    const translation = '寒い朝が始まった。彼はドアを開けた。';

    expect(apply(source, translation, 'keep')).toBe('寒い朝が始まった。\n彼はドアを開けた。');
    expect(apply(source, translation, 'blank')).toBe('寒い朝が始まった。\n\n彼はドアを開けた。');
    expect(apply(source, translation, 'wider')).toEqual({
      text: '寒い朝が始まった。\n彼はドアを開けた。',
      wideGapAfterLine: [true, false],
    });
    expect(stripBreaks(apply(source, translation, 'keep') as string)).toBe(
      stripBreaks(translation),
    );
    expect(stripBreaks((apply(source, translation, 'wider') as { text: string }).text)).toBe(
      stripBreaks(translation),
    );
  });

  it('replaces the ordinary sentence space instead of indenting the next line', () => {
    const source = 'Hello.\nWorld.';
    expect(apply(source, 'Hello. World.', 'keep')).toBe('Hello.\nWorld.');
    expect(apply(source, 'Hello. World.', 'blank')).toBe('Hello.\n\nWorld.');
  });

  it('builds one model paragraph from a heading-like chapter line', () => {
    const source = 'Chapter 1\ncold morning\nopened door';
    const { modelText, breakMap } = prepared(source);

    expect(modelText).toBe('Chapter 1 cold morning opened door');
    expect(breakMap.breaks.map((entry) => entry.kind)).toEqual(['boundary', 'mid-sentence']);
    expect(apply(source, '第1章。寒い朝、ドアを開けた。', 'keep')).toBe(
      '第1章。\n寒い朝、ドアを開けた。',
    );
  });

  it('moves a mid-sentence OCR break to the end of its containing sentence', () => {
    const source = 'The cold morning air\nfilled the room. He opened\nthe door.';
    const { modelText, breakMap } = prepared(source);

    expect(modelText).toBe('The cold morning air filled the room. He opened the door.');
    expect(breakMap.breaks.map((entry) => entry.kind)).toEqual(['mid-sentence', 'mid-sentence']);

    const translation = '寒い朝の空気が部屋を満たした。彼はドアを開けた。';
    const output = apply(source, translation, 'keep') as string;
    // The first OCR break belongs to sentence one, so it lands after 「。」. The second
    // break belongs to the last sentence and has nowhere useful to go, so it is dropped.
    expect(output).toBe('寒い朝の空気が部屋を満たした。\n彼はドアを開けた。');
    expect(stripBreaks(output)).toBe(stripBreaks(translation));
  });

  it('keeps blank-line paragraphs and removes leading/trailing breaks', () => {
    const source = '  \r\n\r\nFirst paragraph.\r\n\r\nSecond paragraph.\r\n  ';
    const { modelText, breakMap } = prepared(source);

    expect(modelText).toBe('First paragraph.\n\nSecond paragraph.');
    expect(breakMap.breaks).toHaveLength(1);
    expect(breakMap.breaks[0]).toMatchObject({
      kind: 'boundary',
      blank: true,
      blankLines: 1,
    });
    expect(apply(source, '最初の段落。二番目の段落。', 'keep')).toBe(
      '最初の段落。\n二番目の段落。',
    );
  });

  it('normalizes CR-only line endings as breaks', () => {
    const { modelText, breakMap } = prepared('First line.\rSecond line.\rThird line.');
    expect(modelText).toBe('First line. Second line. Third line.');
    expect(breakMap.breaks).toHaveLength(2);
    expect(breakMap.breaks.every((entry) => entry.kind === 'boundary')).toBe(true);
  });

  it('handles empty and whitespace-only input without inventing a separator', () => {
    expect(prepared('')).toEqual({
      modelText: '',
      breakMap: { source: '', modelText: '', breaks: [] },
    });
    expect(prepared(' \n\t\n ').modelText).toBe('');
    for (const mode of PLAIN_TEXT_LINE_BREAK_MODES) {
      const result = apply('', '', mode);
      if (mode === 'wider') expect(result).toEqual({ text: '', wideGapAfterLine: [] });
      else expect(result).toBe('');
    }
  });

  it('handles mixed blank lines and sentence breaks in one source', () => {
    const source = 'One.\nTwo.\n\nThree.\nFour.';
    const translation = '一。二。\n\n三。四。';
    expect(prepared(source).modelText).toBe('One. Two.\n\nThree. Four.');
    expect(apply(source, translation, 'keep')).toBe('一。\n二。\n三。\n四。');
    expect(apply(source, translation, 'blank')).toBe('一。\n\n二。\n\n三。\n\n四。');
  });

  it('maps CJK source breaks with a ja-easy target that has no sentence spaces', () => {
    const source = '今日は寒い。\n明日は暖かい。';
    const translation = '今日は寒い。明日は暖かい。';
    expect(prepared(source).modelText).toBe('今日は寒い。 明日は暖かい。');
    expect(apply(source, translation, 'keep')).toBe('今日は寒い。\n明日は暖かい。');
    expect(apply(source, translation, 'blank')).toBe('今日は寒い。\n\n明日は暖かい。');
  });

  it('keeps the mapping valid for long input built from many lines', () => {
    const lines = Array.from({ length: 120 }, (_, index) => `Sentence ${String(index)}.`);
    const source = lines.join('\n');
    const translation = lines.map((_, index) => `文${String(index)}。`).join('');
    const output = apply(source, translation, 'keep') as string;

    expect(output.split('\n')).toHaveLength(lines.length);
    expect(output.replace(/\n/gu, '')).toBe(translation);
    expect(stripBreaks(output)).toBe(stripBreaks(translation));
  });

  it('never splits a surrogate pair when a mapped offset is beyond the final sentence', () => {
    const source = 'this line has no terminator\nand this one continues';
    const translation = '😀 finishing sentence.';
    const output = apply(source, translation, 'keep') as string;
    // The source is one sentence, so both source breaks target its end and are dropped.
    expect(output).toBe(translation);
    expect([...output]).toEqual([...translation]);
  });
});
