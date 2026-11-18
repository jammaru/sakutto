import { describe, expect, it } from 'vitest';
import {
  PLAIN_TEXT_LINE_BREAK_MODES,
  applyPlainTextLineBreaks,
  normalizePlainTextLineBreaks,
  plainTextSelectionSource,
  plainTextTranslationInput,
  preparePlainTextForModel,
  type PlainTextBreakMap,
} from '@/shared/plain-text-line-breaks';
import { copyTranslation, normalizeTypedInput } from '@/shared/typed-translation';

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
    // `wider` now marks the typed source box instead of spacing the translation, so its
    // output text is the `keep` text with real newline characters in the string.
    expect(apply(source, translation, 'wider')).toBe('寒い朝が始まった。\n彼はドアを開けた。');
    expect(stripBreaks(apply(source, translation, 'keep') as string)).toBe(
      stripBreaks(translation),
    );
    expect(stripBreaks(apply(source, translation, 'wider') as string)).toBe(
      stripBreaks(translation),
    );
  });

  it('puts two real newline characters in the data the typed copy button writes', async () => {
    const source = 'The cold morning began.\nHe opened the door.';
    const translation = '寒い朝が始まった。彼はドアを開けた。';
    // The typed page builds the copy string exactly this way: prepare, translate, then
    // apply the mode, and hand the applied string to `copyTranslation`.
    const { engineText, breakMap } = plainTextTranslationInput(source, 'blank');
    const copied = applyPlainTextLineBreaks(breakMap!.modelText, translation, breakMap!, 'blank');

    expect(engineText).toBe('The cold morning began. He opened the door.');
    expect(copied).toBe('寒い朝が始まった。\n\n彼はドアを開けた。');

    const written: string[] = [];
    const clipboard = { writeText: async (text: string) => void written.push(text) };
    const ok = await copyTranslation(copied, clipboard);

    expect(ok).toBe(true);
    expect(written).toEqual(['寒い朝が始まった。\n\n彼はドアを開けた。']);
    // A manual selection copy of the same rendered result yields the same bytes: the
    // string itself carries the empty line, not a CSS margin.
    expect(written[0]?.includes('\n\n')).toBe(true);
  });

  it('keeps internal spaces for a none-mode selection and normalizes other modes', () => {
    const selected = '  Hello,   world!  ';
    const source = plainTextSelectionSource(selected, 'none');
    expect(source).toBe('Hello,   world!');
    expect(plainTextTranslationInput(source, 'none').engineText).toBe('Hello,   world!');
    expect(plainTextSelectionSource(selected, 'keep')).toBe('Hello, world!');
  });

  it('maps a break with trailing spaces before the newline', () => {
    const source = 'Hello. \nWorld.';
    expect(prepared(source).modelText).toBe('Hello. World.');
    expect(apply(source, 'こんにちは。世界。', 'keep')).toBe('こんにちは。\n世界。');
    expect(apply(source, 'こんにちは。世界。', 'blank')).toBe('こんにちは。\n\n世界。');
  });

  it('does not add a trailing break for trailing whitespace on the last line', () => {
    const source = 'Hello. \nWorld. \t';
    const { modelText, breakMap } = prepared(source);
    expect(modelText).toBe('Hello. World.');
    expect(breakMap.breaks).toHaveLength(1);
    expect(apply(source, 'こんにちは。世界。', 'keep')).toBe('こんにちは。\n世界。');
    expect(apply('Hello.   \n', 'こんにちは。', 'keep')).toBe('こんにちは。');
  });

  it('finds the previous unit when a break offset sits in the whitespace gap', () => {
    const breakMap: PlainTextBreakMap = {
      source: 'Hello. \nWorld.',
      modelText: 'Hello.  World.',
      breaks: [
        {
          modelOffset: 7,
          kind: 'boundary',
          blank: false,
          blankLines: 0,
          before: 'Hello.',
          after: 'World.',
        },
      ],
    };
    expect(
      applyPlainTextLineBreaks(breakMap.modelText, 'こんにちは。世界。', breakMap, 'keep'),
    ).toBe('こんにちは。\n世界。');
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

  it('maps only the heading boundary for the reported hyphenated repro', () => {
    const source = 'It was a cold morn-\ning, and she opened\nthe door slowly.\nChapter 2';
    const { modelText, breakMap } = prepared(source);
    const translation = '寒い朝で、彼女はゆっくりとドアを開けました。第2章';

    expect(modelText).toBe('It was a cold morn- ing, and she opened the door slowly. Chapter 2');
    expect(modelText).not.toContain('\n');
    expect(breakMap.breaks.map((entry) => entry.kind)).toEqual([
      'mid-sentence',
      'mid-sentence',
      'boundary',
    ]);

    expect(apply(source, translation, 'keep')).toBe(
      '寒い朝で、彼女はゆっくりとドアを開けました。\n第2章',
    );
    expect(apply(source, translation, 'blank')).toBe(
      '寒い朝で、彼女はゆっくりとドアを開けました。\n\n第2章',
    );
    expect(apply(source, translation, 'wider')).toBe(
      '寒い朝で、彼女はゆっくりとドアを開けました。\n第2章',
    );
  });

  it('maps the reported repro through the typed input flow', () => {
    const source = 'It was a cold morn-\ning, and she opened\nthe door slowly.\nChapter 2';
    const normalized = normalizeTypedInput(source);
    const input = plainTextTranslationInput(normalized, 'keep');
    const translation = '寒い朝で、彼女はゆっくりとドアを開けました。第2章';

    expect(input.engineText).toBe(
      'It was a cold morn- ing, and she opened the door slowly. Chapter 2',
    );
    expect(input.breakMap).not.toBeNull();
    expect(applyPlainTextLineBreaks(input.engineText, translation, input.breakMap!, 'keep')).toBe(
      '寒い朝で、彼女はゆっくりとドアを開けました。\n第2章',
    );
  });

  it('keeps only real sentence and heading boundaries for a CJK ja-easy source', () => {
    const source = '今日は寒い。\n彼女は、\nゆっくりとドアを、\n開けました。\n第2章';
    const { modelText, breakMap } = prepared(source);
    const translation = '今日は寒い。彼女はゆっくりとドアを開けました。第2章';

    expect(modelText).toBe('今日は寒い。 彼女は、 ゆっくりとドアを、 開けました。 第2章');
    expect(breakMap.breaks.map((entry) => entry.kind)).toEqual([
      'boundary',
      'mid-sentence',
      'mid-sentence',
      'boundary',
    ]);
    expect(apply(source, translation, 'keep')).toBe(
      '今日は寒い。\n彼女はゆっくりとドアを開けました。\n第2章',
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
      expect(apply('', '', mode)).toBe('');
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
