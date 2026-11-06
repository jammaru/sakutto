import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_CONFIG, planWork } from '@/engine/text/plan';
import { completionTokenBudget, estimateTokens } from '@/engine/text/tokens';
import type { TranslateSegment } from '@/engine/types';

function segments(...texts: string[]): TranslateSegment[] {
  return texts.map((text, index) => ({ id: `s${String(index)}`, text }));
}

describe('translation planning', () => {
  it('keeps a lone short segment as its own streaming request', () => {
    expect(planWork(segments('Sign in'))).toEqual([
      { kind: 'single', segment: { id: 's0', text: 'Sign in' } },
    ]);
  });

  it('streams the first short segment before batching the rest', () => {
    const items = planWork(
      segments('Sign in', 'Settings', 'Learn more'),
      DEFAULT_PLAN_CONFIG,
      true,
    );

    expect(items.map((item) => item.kind)).toEqual(['single', 'batch']);
    expect(items[0]).toMatchObject({ segment: { id: 's0', text: 'Sign in' } });
    expect(items[1]).toMatchObject({ text: 'Settings\nLearn more' });
  });

  it('caps a newline batch at eight segments', () => {
    const items = planWork(
      segments(...Array.from({ length: 9 }, (_, index) => `Label ${String(index)}`)),
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'batch' });
    if (items[0]?.kind === 'batch') expect(items[0].segments).toHaveLength(8);
  });

  it('groups short neighbouring segments into one newline request', () => {
    const items = planWork(segments('Sign in', 'Settings', 'Learn more'));

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('batch');
    expect(items[0]).toMatchObject({ text: 'Sign in\nSettings\nLearn more' });
  });

  it('gives each paragraph-sized segment a prompt of its own', () => {
    // Packing two paragraphs makes the model read them as one text and holds the first
    // paragraph's first token behind the second paragraph's prefill.
    const sentence = 'The harbor market opens early and the baker sets out bread. '.repeat(5);
    const items = planWork(segments(sentence, sentence));

    expect(items.map((item) => item.kind)).toEqual(['single', 'single']);
  });

  it('keeps a packed request of labels small', () => {
    const items = planWork(
      segments(...Array.from({ length: 20 }, (_, index) => `Menu entry number ${String(index)}`)),
    );

    expect(items.length).toBeGreaterThan(1);
    for (const item of items) {
      if (item.kind !== 'batch') continue;
      expect(estimateTokens(item.text)).toBeLessThanOrEqual(DEFAULT_PLAN_CONFIG.maxBatchTokens);
    }
  });

  it('keeps long segments alone', () => {
    const long = 'A sentence. '.repeat(40);
    const items = planWork(segments('Sign in', long, 'Learn more'));

    expect(items.map((item) => item.kind)).toEqual(['single', 'single', 'single']);
  });

  it('flushes a batch when the token budget is reached', () => {
    const short = 'label '.repeat(20);
    const items = planWork(segments(short, short, short), {
      ...DEFAULT_PLAN_CONFIG,
      maxSegmentTokens: 40,
      maxBatchTokens: 60,
    });

    expect(items.length).toBeGreaterThan(1);
    expect(items[0]?.kind).toBe('batch');
    for (const item of items) {
      if (item.kind === 'batch') {
        expect(estimateTokens(item.text)).toBeLessThanOrEqual(60);
      }
    }
  });

  it('does not join a segment that already contains a line break', () => {
    const items = planWork(segments('Open\nSettings', 'Save'));
    expect(items.map((item) => item.kind)).toEqual(['single', 'single']);
    expect(items[0]).toMatchObject({ segment: { text: 'Open\nSettings' } });
  });

  it('gives empty segments their own no-op request', () => {
    const items = planWork(segments('Sign in', '   ', 'Learn more'));
    expect(items.map((item) => item.kind)).toEqual(['single', 'single', 'single']);
    expect(items[1]).toMatchObject({ segment: { id: 's1', text: '   ' } });
  });

  it('estimates CJK tokens and completion budgets conservatively', () => {
    expect(estimateTokens('こんにちは')).toBe(3);
    expect(estimateTokens('hello world')).toBe(3);
    expect(completionTokenBudget('hello')).toBe(32);
    expect(completionTokenBudget('こんにちは世界')).toBe(32);
    expect(completionTokenBudget('a'.repeat(200))).toBe(2 * estimateTokens('a'.repeat(200)) + 16);
  });
});
