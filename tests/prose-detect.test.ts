import { describe, expect, it } from 'vitest';
import { hasCjkProse, hasSourceProse, hasTranslatableProse } from '@/pdf/prose-detect';

describe('hasSourceProse', () => {
  it('counts three or more Latin words', () => {
    expect(hasSourceProse('The cold morning began.')).toBe(true);
    expect(hasSourceProse('Data quality')).toBe(false);
    expect(hasSourceProse('INTRODUCTION')).toBe(false);
    expect(hasSourceProse('48')).toBe(false);
    expect(hasSourceProse('1.9 s')).toBe(false);
  });

  it('stays Latin-only so a CJK figure label never becomes body prose', () => {
    // layout.ts calls this to decide whether a skipped figure label is really body copy.
    for (const text of ['図1 温度計', '温度計の設定', '図1', '東京都', '付録', '第2章', 'α = β']) {
      expect(hasSourceProse(text), text).toBe(false);
    }
  });
});

describe('hasCjkProse', () => {
  it('counts a CJK sentence at the default threshold', () => {
    expect(hasCjkProse('温度を測ります')).toBe(true);
    expect(hasCjkProse('今日は寒いです。')).toBe(true);
    expect(hasCjkProse('消息已准备好。')).toBe(true);
  });

  it('keeps a two- or three-glyph CJK label out of prose', () => {
    for (const text of ['概要', '図1', '東京都', '付録', '結果', '図1 温度計', '10³']) {
      expect(hasCjkProse(text), text).toBe(false);
    }
  });

  it('takes the caller threshold, so the OCR role test keeps a two-glyph heading', () => {
    expect(hasCjkProse('概要', 2)).toBe(true);
    expect(hasCjkProse('図1', 2)).toBe(true);
    // A Latin run has no CJK majority however long it is.
    expect(hasCjkProse('The cold morning began.')).toBe(false);
    expect(hasCjkProse('The cold morning began.', 2)).toBe(false);
  });
});

describe('hasTranslatableProse', () => {
  it('accepts prose in any script the translator is asked to translate', () => {
    expect(hasTranslatableProse('The cold morning began.')).toBe(true);
    expect(hasTranslatableProse('温度を測ります')).toBe(true);
    expect(hasTranslatableProse('消息已准备好。')).toBe(true);
  });

  it('still refuses labels, numbers and notation', () => {
    for (const text of ['図1', '概要', 'Data quality', '48', '1.9 s', 'α = β']) {
      expect(hasTranslatableProse(text), text).toBe(false);
    }
  });
});
