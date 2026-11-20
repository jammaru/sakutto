import { describe, expect, it } from 'vitest';
import { hasSourceProse } from '@/pdf/prose-detect';

describe('hasSourceProse', () => {
  it('counts three or more Latin words', () => {
    expect(hasSourceProse('The cold morning began.')).toBe(true);
    expect(hasSourceProse('Data quality')).toBe(false);
    expect(hasSourceProse('INTRODUCTION')).toBe(false);
    expect(hasSourceProse('48')).toBe(false);
    expect(hasSourceProse('1.9 s')).toBe(false);
  });

  it('counts CJK letters because those scripts pack a sentence into few characters', () => {
    // Two sentences are two PROSE_WORD matches, which is below the three-word gate.
    expect(hasSourceProse('今日は寒い。明日は暖かい。')).toBe(true);
    expect(hasSourceProse('今日は寒いです。')).toBe(true);
    expect(hasSourceProse('消息已准备好。')).toBe(true);
    expect(hasSourceProse('오늘은 추워요.')).toBe(true);
  });

  it('keeps short CJK labels, figures and rows out of prose', () => {
    for (const text of ['図1', '東京都', '付録', '結果', '第2章', '10³', 'α = β']) {
      expect(hasSourceProse(text), text).toBe(false);
    }
  });
});
