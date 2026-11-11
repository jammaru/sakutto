import { describe, expect, it } from 'vitest';
import { InBrowserEngine } from '@/engine/in-browser/engine';
import { isDegenerateOutput, isRepeatInProgress } from '@/engine/text/degenerate';
import type { TranslateOptions } from '@/engine/types';
import { collectChunks, FakeRuntime } from './support/fakes';

function options(): TranslateOptions {
  return { tgt: 'ja', form: 'polite', priority: 10, signal: new AbortController().signal };
}

describe('isDegenerateOutput', () => {
  it('flags a token repeated across most of the string', () => {
    expect(isDegenerateOutput(',3'.repeat(8))).toBe(true);
    expect(isDegenerateOutput(`${',3'.repeat(20)}です`)).toBe(true);
    expect(isDegenerateOutput('a'.repeat(16))).toBe(true);
  });

  it('keeps holding a repeat that has not finished its unit', () => {
    expect(isRepeatInProgress(',3,')).toBe(true);
    expect(isRepeatInProgress(',3,3')).toBe(true);
    expect(isRepeatInProgress('abcd')).toBe(false);
    expect(isRepeatInProgress('ああ')).toBe(true);
  });

  it('does not flag a short or ordinary sentence', () => {
    expect(isDegenerateOutput('こんにちは。')).toBe(false);
    expect(isDegenerateOutput('こんにちは。こんにちは。')).toBe(false);
    expect(isDegenerateOutput('本日は晴天です。本日は晴天です。')).toBe(false);
    expect(isDegenerateOutput('Ada Lovelace was born in 1815.')).toBe(false);
  });
});

describe('InBrowserEngine repeated output', () => {
  it('does not stream a repeated token', async () => {
    const engine = new InBrowserEngine(new FakeRuntime(() => ',3'.repeat(12), 1, 'webgpu'));
    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of engine.translate([{ id: 'a', text: 'Hello.' }], options())) {
          chunks.push(chunk.textDelta ?? chunk.final ?? '');
        }
      })(),
    ).rejects.toMatchObject({ code: 'degenerate-output', retryable: true });
    expect(chunks).toEqual([]);
  });

  it('still streams a normal translation one character at a time', async () => {
    const engine = new InBrowserEngine(new FakeRuntime(() => 'こんにちは'));
    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));
    expect(chunks.map((chunk) => chunk.textDelta).filter(Boolean)).toEqual([
      'こ',
      'ん',
      'に',
      'ち',
      'は',
    ]);
    expect(chunks.at(-1)?.final).toBe('こんにちは');
  });
});
