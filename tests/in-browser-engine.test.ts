import { describe, expect, it } from 'vitest';
import { InBrowserEngine } from '@/engine/in-browser/engine';
import type { TranslateOptions, TranslationChunk } from '@/engine/types';
import { MAX_SEGMENT_TEXT } from '@/engine/offscreen/protocol';
import { MAX_GLOSSARY_ENTRIES } from '@/shared/glossary';
import { collectChunks, FakeRuntime } from './support/fakes';
import { promptSource } from './support/sim-runtime';

function options(overrides: Partial<TranslateOptions> = {}): TranslateOptions {
  return {
    tgt: 'ja',
    form: 'polite',
    priority: 10,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function finalChunks(chunks: readonly TranslationChunk[]): TranslationChunk[] {
  return chunks.filter((chunk) => chunk.final !== undefined);
}

function deltaText(chunks: readonly TranslationChunk[]): string {
  return chunks.map((chunk) => chunk.textDelta ?? '').join('');
}

describe('InBrowserEngine', () => {
  it('translates the pieces of a long text together and streams them in reading order', async () => {
    const first = 'A'.repeat(300);
    const text = `${first}. ${'B'.repeat(300)}. ${'C'.repeat(300)}.`;
    const inFlight: Array<() => void> = [];
    let peak = 0;
    let active = 0;
    class WaitingRuntime extends FakeRuntime {
      override async complete(request: Parameters<FakeRuntime['complete']>[0]): Promise<void> {
        active += 1;
        peak = Math.max(peak, active);
        const source = promptSource(request.prompt);
        // The first piece is the last to finish, so later pieces have to wait behind it.
        await new Promise<void>((resolve) => {
          if (source.startsWith('A')) inFlight.push(resolve);
          else resolve();
        });
        active -= 1;
        request.onToken(`[${source.slice(0, 1)}]`);
      }
    }
    const runtime = new WaitingRuntime(() => '', 4);
    const engine = new InBrowserEngine(runtime);

    const collected = collectChunks(engine.translate([{ id: 'long', text }], options()));
    for (let attempt = 0; attempt < 50 && inFlight.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight.shift()?.();
    const chunks = await collected;

    expect(peak).toBeGreaterThan(1);
    expect(deltaText(chunks).replace(/\s/gu, '')).toBe('[A][B][C]');
    expect(finalChunks(chunks)[0]?.final?.replace(/\s/gu, '')).toBe('[A][B][C]');
  });

  it('streams deltas and a final tagged with the PLaMo engine', async () => {
    const runtime = new FakeRuntime(() => 'こんにちは');
    const engine = new InBrowserEngine(runtime);

    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(deltaText(chunks)).toBe('こんにちは');
    expect(finalChunks(chunks)).toEqual([{ id: 'a', final: 'こんにちは', engine: 'plamo' }]);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.prompt).toContain(
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>',
    );
    expect(runtime.requests[0]?.maxTokens).toBeGreaterThanOrEqual(32);
  });

  it('omits the Japanese form option for other targets and forwards context', async () => {
    const runtime = new FakeRuntime(() => 'Hello.');
    const engine = new InBrowserEngine(runtime);

    await collectChunks(
      engine.translate(
        [{ id: 'a', text: 'Runnerさん、こんにちは。' }],
        options({
          tgt: 'en',
          src: 'ja',
          context: 'Greeting page',
          glossary: [{ source: 'Runner', target: 'ランナー機能' }],
        }),
      ),
    );

    const prompt = runtime.requests[0]?.prompt ?? '';
    expect(prompt).not.toContain('form<|plamo:val|>');
    expect(prompt).toContain('<|plamo:tag|>context<|plamo:msg|>Greeting page');
    expect(prompt).toContain('<|plamo:tag|>glossary');
    expect(prompt).toContain('Runner');
    expect(prompt).toContain('<|plamo:key|>lang<|plamo:val|>ja');
  });

  it('drops glossary rows that do not appear in the segment', async () => {
    const runtime = new FakeRuntime(() => 'こんにちは');
    const engine = new InBrowserEngine(runtime);

    await collectChunks(
      engine.translate(
        [{ id: 'a', text: 'Hello.' }],
        options({ glossary: [{ source: 'Runner', target: 'ランナー機能' }] }),
      ),
    );

    expect(runtime.requests[0]?.prompt ?? '').not.toContain('glossary');
  });

  it('packs only the matching rows from a 5000-entry glossary', async () => {
    const runtime = new FakeRuntime(() => 'こんにちは');
    const engine = new InBrowserEngine(runtime);
    const glossary = Array.from({ length: MAX_GLOSSARY_ENTRIES }, (_, index) => ({
      source: `term-${String(index)}`,
      target: `訳-${String(index)}`,
    }));
    glossary[42] = { source: 'Runner', target: 'ランナー機能' };

    await collectChunks(
      engine.translate([{ id: 'a', text: 'Hello Runner.' }], options({ glossary })),
    );

    const prompt = runtime.requests[0]?.prompt ?? '';
    expect(prompt).toContain(
      '<|plamo:tag|>glossary<|plamo:index|>Runner<|plamo:item|>ランナー機能',
    );
    expect(prompt.match(/<\|plamo:index\|>/g)).toHaveLength(1);
    expect(prompt).not.toContain('term-0');
    expect(prompt).not.toContain(`term-${String(MAX_GLOSSARY_ENTRIES - 1)}`);
  });

  it('translates an ordinary paragraph as one prompt, not one sentence per line', async () => {
    const runtime = new FakeRuntime(() => '段落の訳。');
    const engine = new InBrowserEngine(runtime);
    const text =
      'First sentence explains the feature in enough detail that readers can follow it on their own. ' +
      'Second sentence explains the workflow in enough detail that readers can repeat it on their own. ' +
      'Third sentence explains the result in enough detail that readers can verify it on their own.';

    const chunks = await collectChunks(engine.translate([{ id: 'p', text }], options()));

    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.prompt).toContain(text);
    expect(runtime.requests[0]?.prompt).not.toContain('their own.\nSecond');
    expect(finalChunks(chunks)).toEqual([{ id: 'p', final: '段落の訳。', engine: 'plamo' }]);
  });

  it('splits a very long paragraph into prompts of whole sentences and joins them', async () => {
    let calls = 0;
    const runtime = new FakeRuntime(() => {
      calls += 1;
      return `訳${String(calls)}。`;
    });
    const engine = new InBrowserEngine(runtime);
    const sentence = 'This sentence explains one more step of the long procedure in detail. ';
    const text = sentence.repeat(20).trim();

    const chunks = await collectChunks(engine.translate([{ id: 'long', text }], options()));

    expect(runtime.requests.length).toBeGreaterThan(1);
    for (const request of runtime.requests) {
      const source = promptSource(request.prompt);
      // No line structure for the model to keep, and every prompt ends on a full stop.
      expect(source).not.toContain('\n');
      expect(source.trim().endsWith('.')).toBe(true);
    }
    const final = finalChunks(chunks)[0]?.final ?? '';
    expect(final).toBe(runtime.requests.map((_, index) => `訳${String(index + 1)}。`).join(''));
    expect(deltaText(chunks)).toBe(final);
  });

  it('translates a typed-length segment above the old 20,000-character ceiling', async () => {
    const runtime = new FakeRuntime(() => '訳。');
    const engine = new InBrowserEngine(runtime);
    const sentence = 'This sentence explains one more step of the long procedure in detail. ';
    const text = sentence.repeat(320).trim();
    expect(text.length).toBeGreaterThan(20_000);
    expect(text.length).toBeLessThanOrEqual(MAX_SEGMENT_TEXT);

    const chunks = await collectChunks(engine.translate([{ id: 'typed', text }], options()));

    expect(runtime.requests.length).toBeGreaterThan(1);
    expect(finalChunks(chunks)[0]?.id).toBe('typed');
    expect((finalChunks(chunks)[0]?.final ?? '').length).toBeGreaterThan(0);
  });

  it('batches short segments into one newline request', async () => {
    const runtime = new FakeRuntime((prompt) =>
      prompt.includes('Sign in\nSettings') ? 'サインイン\n設定\nもっと見る' : 'unexpected',
    );
    const engine = new InBrowserEngine(runtime);

    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'Sign in' },
          { id: 'b', text: 'Settings' },
          { id: 'c', text: 'Learn more' },
        ],
        options(),
      ),
    );

    expect(runtime.requests).toHaveLength(1);
    expect(finalChunks(chunks)).toEqual([
      { id: 'a', final: 'サインイン', engine: 'plamo' },
      { id: 'b', final: '設定', engine: 'plamo' },
      { id: 'c', final: 'もっと見る', engine: 'plamo' },
    ]);
  });

  it('shows a finished batch line before the later lines are decoded', async () => {
    const runtime = new FakeRuntime((prompt) =>
      prompt.includes('Sign in\nSettings') ? 'サインイン\n設定\nもっと見る' : 'unexpected',
    );
    const engine = new InBrowserEngine(runtime);

    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'Sign in' },
          { id: 'b', text: 'Settings' },
          { id: 'c', text: 'Learn more' },
        ],
        options(),
      ),
    );

    const readyAt = (id: string, text: string): number =>
      chunks.findIndex((_, index) => {
        const soFar = chunks
          .slice(0, index + 1)
          .filter((chunk) => chunk.id === id && chunk.textDelta !== undefined)
          .map((chunk) => chunk.textDelta)
          .join('');
        return soFar === text;
      });
    const firstLine = readyAt('a', 'サインイン');
    const lastFinal = chunks.findIndex((chunk) => chunk.id === 'c' && chunk.final === 'もっと見る');
    expect(firstLine).toBeGreaterThanOrEqual(0);
    expect(lastFinal).toBeGreaterThan(firstLine);
  });

  it('keeps a short-segment batch when the model adds a trailing newline', async () => {
    const runtime = new FakeRuntime((prompt) =>
      prompt.includes('Sign in\nSettings') ? 'サインイン\n設定\nもっと見る\n\n' : 'unexpected',
    );
    const engine = new InBrowserEngine(runtime);

    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'Sign in' },
          { id: 'b', text: 'Settings' },
          { id: 'c', text: 'Learn more' },
        ],
        options(),
      ),
    );

    expect(runtime.requests).toHaveLength(1);
    expect(finalChunks(chunks)).toEqual([
      { id: 'a', final: 'サインイン', engine: 'plamo' },
      { id: 'b', final: '設定', engine: 'plamo' },
      { id: 'c', final: 'もっと見る', engine: 'plamo' },
    ]);
  });

  it('drops blank glossary rows instead of failing the segment', async () => {
    const runtime = new FakeRuntime(() => 'Translated');
    const engine = new InBrowserEngine(runtime);

    await collectChunks(
      engine.translate(
        [{ id: 'a', text: 'Hello Runner.' }],
        options({
          tgt: 'en',
          glossary: [
            { source: '   ', target: 'blank' },
            { source: 'Runner', target: 'ランナー機能' },
            { source: 'Runner', target: 'ランナー' },
          ],
        }),
      ),
    );

    const prompt = runtime.requests[0]?.prompt ?? '';
    expect(prompt).toContain('<|plamo:tag|>glossary<|plamo:index|>Runner<|plamo:item|>ランナー');
    expect(prompt.match(/<\|plamo:index\|>/g)).toHaveLength(1);
  });

  it('normalizes regional source tags before building the prompt', async () => {
    const runtime = new FakeRuntime(() => 'Translated');
    const engine = new InBrowserEngine(runtime);

    await collectChunks(
      engine.translate([{ id: 'a', text: 'Hello.' }], options({ src: 'en-US', tgt: 'ja-JP' })),
    );

    expect(runtime.requests[0]?.prompt).toContain('<|plamo:key|>lang<|plamo:val|>en');
    expect(runtime.requests[0]?.prompt).toContain('<|plamo:key|>lang<|plamo:val|>ja');
  });

  it('translates every line on its own when a packed batch loses its alignment', async () => {
    const runtime = new FakeRuntime((prompt) => {
      if (prompt.includes('Sign in\nSettings')) return 'サインイン';
      if (prompt.includes('Sign in')) return 'サインイン';
      if (prompt.includes('Settings')) return '設定';
      return 'もっと見る';
    });
    const engine = new InBrowserEngine(runtime);

    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'Sign in' },
          { id: 'b', text: 'Settings' },
          { id: 'c', text: 'Learn more' },
        ],
        options(),
      ),
    );

    // One line came back for three. Which one it is cannot be told from the count — a
    // merged line would shift every later line into the wrong block — so none is kept.
    expect(runtime.requests).toHaveLength(4);
    expect(finalChunks(chunks)).toEqual([
      { id: 'a', final: 'サインイン', engine: 'plamo' },
      { id: 'b', final: '設定', engine: 'plamo' },
      { id: 'c', final: 'もっと見る', engine: 'plamo' },
    ]);
  });

  it('restarts a line already shown instead of appending its retry to it', async () => {
    const runtime = new FakeRuntime((prompt) => {
      if (prompt.includes('Sign in\nSettings')) return 'サインイン\n設定';
      if (prompt.includes('Sign in')) return 'サインイン';
      if (prompt.includes('Settings')) return '設定';
      return 'もっと見る';
    });
    const engine = new InBrowserEngine(runtime);

    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'Sign in' },
          { id: 'b', text: 'Settings' },
          { id: 'c', text: 'Learn more' },
        ],
        options(),
      ),
    );

    const shown = (id: string): string =>
      chunks.reduce((text, chunk) => {
        if (chunk.id !== id || chunk.textDelta === undefined) return text;
        return chunk.restart === true ? chunk.textDelta : text + chunk.textDelta;
      }, '');

    expect(shown('a')).toBe('サインイン');
    expect(shown('b')).toBe('設定');
    expect(shown('c')).toBe('もっと見る');
    expect(finalChunks(chunks)).toEqual([
      { id: 'a', final: 'サインイン', engine: 'plamo' },
      { id: 'b', final: '設定', engine: 'plamo' },
      { id: 'c', final: 'もっと見る', engine: 'plamo' },
    ]);
  });

  it('puts the source back on a shown line whose retry comes back empty', async () => {
    const runtime = new FakeRuntime((prompt) => {
      if (prompt.includes('Sign in\nSettings')) return '設定';
      if (prompt.includes('Sign in')) return '';
      if (prompt.includes('Settings')) return '設定';
      return 'もっと見る';
    });
    const engine = new InBrowserEngine(runtime);

    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'Sign in' },
          { id: 'b', text: 'Settings' },
          { id: 'c', text: 'Learn more' },
        ],
        options(),
      ),
    );

    // "設定" was streamed into the first block by the misaligned batch.
    const streamed = chunks
      .filter((chunk) => chunk.id === 'a' && chunk.textDelta !== undefined)
      .map((chunk) => chunk.textDelta)
      .join('');
    expect(streamed).toBe('設定');
    expect(finalChunks(chunks)).toEqual([
      { id: 'a', final: 'Sign in', engine: 'plamo' },
      { id: 'b', final: '設定', engine: 'plamo' },
      { id: 'c', final: 'もっと見る', engine: 'plamo' },
    ]);
  });

  it('keeps the next segment when one piece does not fit in the context', async () => {
    const runtime = new FakeRuntime(() => '訳');
    const engine = new InBrowserEngine(runtime, { contextTokens: 96 });

    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'big', text: 'word '.repeat(500) },
          { id: 'small', text: 'Hello.' },
        ],
        options(),
      ),
    );

    const finals = finalChunks(chunks);
    expect(finals.find((chunk) => chunk.id === 'small')?.final).toBe('訳');
    expect((finals.find((chunk) => chunk.id === 'big')?.final ?? '').length).toBeGreaterThan(0);
  });

  it('returns empty segments without calling the runtime', async () => {
    const runtime = new FakeRuntime(() => 'unused');
    const engine = new InBrowserEngine(runtime);

    const chunks = await collectChunks(engine.translate([{ id: 'blank', text: '   ' }], options()));

    expect(runtime.requests).toHaveLength(0);
    expect(finalChunks(chunks)).toEqual([{ id: 'blank', final: '   ', engine: 'plamo' }]);
  });

  it('does nothing when the signal is already aborted', async () => {
    const runtime = new FakeRuntime(() => 'unused');
    const engine = new InBrowserEngine(runtime);
    const controller = new AbortController();
    controller.abort();

    const chunks = await collectChunks(
      engine.translate([{ id: 'a', text: 'Hello.' }], options({ signal: controller.signal })),
    );

    expect(chunks).toHaveLength(0);
    expect(runtime.requests).toHaveLength(0);
  });

  it('stops without a final result when aborted mid-stream', async () => {
    const runtime = new FakeRuntime(() => 'abcdef');
    const engine = new InBrowserEngine(runtime);
    const controller = new AbortController();
    const iterator = engine
      .translate([{ id: 'a', text: 'Hello.' }], options({ signal: controller.signal }))
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    controller.abort();

    const rest: TranslationChunk[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }

    expect(rest.some((chunk) => chunk.final !== undefined)).toBe(false);
  });
});
