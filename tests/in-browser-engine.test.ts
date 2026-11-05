import { describe, expect, it } from 'vitest';
import { InBrowserEngine } from '@/engine/in-browser/engine';
import type { TranslateOptions, TranslationChunk } from '@/engine/types';
import { collectChunks, FakeRuntime } from './support/fakes';

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

  it('splits a long paragraph and joins the translated sentences', async () => {
    const runtime = new FakeRuntime((prompt) => {
      if (prompt.includes('First sentence')) return 'First translation.';
      if (prompt.includes('Second sentence')) return 'Second translation.';
      return 'Third translation.';
    });
    const engine = new InBrowserEngine(runtime);
    const text =
      'First sentence explains the feature in enough detail that readers can follow it on their own. ' +
      'Second sentence explains the workflow in enough detail that readers can repeat it on their own. ' +
      'Third sentence explains the result in enough detail that readers can verify it on their own.';

    const chunks = await collectChunks(
      engine.translate([{ id: 'long', text }], options({ tgt: 'en' })),
    );

    expect(runtime.requests).toHaveLength(3);
    expect(finalChunks(chunks)).toEqual([
      {
        id: 'long',
        final: 'First translation. Second translation. Third translation.',
        engine: 'plamo',
      },
    ]);
    expect(deltaText(chunks)).toContain('First translation.');
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

    const firstLine = chunks.findIndex(
      (chunk) => chunk.id === 'a' && chunk.textDelta === 'サインイン',
    );
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

  it('retries each segment when a batch loses a line', async () => {
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

    expect(runtime.requests).toHaveLength(4);
    expect(finalChunks(chunks)).toEqual([
      { id: 'a', final: 'サインイン', engine: 'plamo' },
      { id: 'b', final: '設定', engine: 'plamo' },
      { id: 'c', final: 'もっと見る', engine: 'plamo' },
    ]);
  });

  it('does not append a per-segment retry onto a line already shown', async () => {
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
      chunks
        .filter((chunk) => chunk.id === id && chunk.textDelta !== undefined)
        .map((chunk) => chunk.textDelta)
        .join('');

    expect(shown('a')).toBe('サインイン');
    expect(shown('b')).toBe('設定');
    expect(shown('c')).toBe('もっと見る');
    expect(finalChunks(chunks)).toEqual([
      { id: 'a', final: 'サインイン', engine: 'plamo' },
      { id: 'b', final: '設定', engine: 'plamo' },
      { id: 'c', final: 'もっと見る', engine: 'plamo' },
    ]);
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
