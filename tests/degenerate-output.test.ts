import { describe, expect, it, vi } from 'vitest';
import { InBrowserEngine } from '@/engine/in-browser/engine';
import { LazyInBrowserEngine } from '@/engine/in-browser/lazy-engine';
import type { BackendSelection } from '@/engine/in-browser/backend';
import { CachingEngine } from '@/engine/cache/caching-engine';
import { TranslationCache } from '@/engine/cache/cache';
import { MemoryTranslationCacheStore } from '@/engine/cache/store';
import {
  isBrokenTranslation,
  isDegenerateOutput,
  isRepeatInProgress,
  isRepetitiveSource,
} from '@/engine/text/degenerate';
import type { TranslateOptions, TranslateSegment } from '@/engine/types';
import { collectChunks, FakeRuntime, fakeEngine } from './support/fakes';
import { promptSource } from './support/sim-runtime';

function options(): TranslateOptions {
  return { tgt: 'ja', form: 'polite', priority: 10, signal: new AbortController().signal };
}

function displayed(chunks: Awaited<ReturnType<typeof collectChunks>>): string {
  return chunks.reduce((text, chunk) => {
    if (chunk.textDelta !== undefined) {
      return chunk.restart === true ? chunk.textDelta : text + chunk.textDelta;
    }
    if (chunk.final !== undefined) return chunk.final;
    return text;
  }, '');
}

const COLLAPSED = ',3'.repeat(200);

const TABLE_RULE = '|---|---|---|---|---|---|---|---|';

const LEGITIMATE: ReadonlyArray<{ source: string; output: string }> = [
  { source: 'Hahaha…', output: 'ハ'.repeat(18) },
  { source: 'No, no, no, no, no, no, no, no, no, no, no', output: 'いいえ、'.repeat(11) },
  { source: `${'Go! '.repeat(10).trim()}`, output: '行け！'.repeat(10) },
  { source: 'AAAAH!', output: 'あ'.repeat(16) },
  { source: '★'.repeat(16), output: '★'.repeat(16) },
  { source: 'ー'.repeat(16), output: 'ー'.repeat(16) },
  { source: '…'.repeat(16), output: '…'.repeat(16) },
  { source: TABLE_RULE, output: TABLE_RULE },
];

const GPU: BackendSelection = {
  tier: 'g',
  backend: 'webgpu',
  nGpuLayers: 99,
  nThreads: 8,
  nParallel: 4,
  nCtx: 4096,
};

describe('isDegenerateOutput', () => {
  it('flags a token repeated across most of the string', () => {
    expect(isDegenerateOutput(',3'.repeat(8))).toBe(true);
    expect(isDegenerateOutput(`${',3'.repeat(20)}です`)).toBe(true);
    expect(isDegenerateOutput('a'.repeat(16))).toBe(true);
  });

  it('recognizes a repeat that has not finished its unit', () => {
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

describe('isBrokenTranslation', () => {
  it('flags ,3,3,3 filling the token budget from a normal sentence', () => {
    expect(isBrokenTranslation('Hello.', COLLAPSED, true)).toBe(true);
    expect(isBrokenTranslation('The cost model uses a wider buffer.', COLLAPSED, true)).toBe(true);
  });

  it('lets legitimate laughs, chants, shouts, marks, and table rules through', () => {
    for (const sample of LEGITIMATE) {
      expect(isBrokenTranslation(sample.source, sample.output, false), sample.source).toBe(false);
    }
  });

  it('does not flag a collapsed-looking output when the source is itself repetitive', () => {
    expect(isRepetitiveSource('★'.repeat(16))).toBe(true);
    expect(isRepetitiveSource(TABLE_RULE)).toBe(true);
    expect(isBrokenTranslation('★'.repeat(16), '★'.repeat(16), true)).toBe(false);
  });

  it('does not flag a short laugh that stopped before the token budget', () => {
    expect(isBrokenTranslation('Hahaha…', 'ハ'.repeat(18), false)).toBe(false);
    expect(isBrokenTranslation('AAAAH!', 'あ'.repeat(16), false)).toBe(false);
  });
});

describe('InBrowserEngine repeated output', () => {
  it('streams immediately and replaces a collapsed token after the CPU retry', async () => {
    const gpu = new FakeRuntime(() => COLLAPSED, 1, 'webgpu');
    gpu.fillBudget = true;
    const cpu = new FakeRuntime(() => 'こんにちは');
    const engine = new InBrowserEngine(gpu, { loadRetryRuntime: async () => cpu });
    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(chunks.some((chunk) => chunk.restart === true)).toBe(true);
    expect(displayed(chunks)).toBe('こんにちは');
    expect(chunks.at(-1)).toEqual({ id: 'a', final: 'こんにちは', engine: 'plamo' });
    expect(cpu.requests).toHaveLength(1);
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

  it('translates legitimate repeated phrases without treating them as broken', async () => {
    const runtime = new FakeRuntime(
      (prompt) => {
        const source = promptSource(prompt);
        const match = LEGITIMATE.find((sample) => sample.source === source);
        return match?.output ?? `訳:${source}`;
      },
      1,
      'webgpu',
    );
    const onDegenerateBlock = vi.fn();
    const engine = new InBrowserEngine(runtime, {
      onDegenerateBlock,
      config: { maxSegmentTokens: 1 },
    });
    const segments: TranslateSegment[] = LEGITIMATE.map((sample, index) => ({
      id: `s${String(index)}`,
      text: sample.source,
    }));

    const chunks = await collectChunks(engine.translate(segments, options()));
    const finals = chunks.filter((chunk) => chunk.final !== undefined);

    expect(finals).toHaveLength(LEGITIMATE.length);
    for (const [index, sample] of LEGITIMATE.entries()) {
      expect(finals[index]?.final).toBe(sample.output);
    }
    expect(onDegenerateBlock).not.toHaveBeenCalled();
  });

  it('shows the original text when the CPU retry is also collapsed', async () => {
    const gpu = new FakeRuntime(() => COLLAPSED, 1, 'webgpu');
    gpu.fillBudget = true;
    const cpu = new FakeRuntime(() => COLLAPSED);
    cpu.fillBudget = true;
    const engine = new InBrowserEngine(gpu, { loadRetryRuntime: async () => cpu });
    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(chunks.some((chunk) => (chunk.final ?? '').includes(',3'))).toBe(false);
    expect(displayed(chunks)).toBe('Hello.');
    expect(chunks.at(-1)).toEqual({ id: 'a', final: 'Hello.', engine: 'plamo', error: true });
  });

  it('finishes a collapsed CPU piece with the original text instead of hanging', async () => {
    const runtime = new FakeRuntime(() => COLLAPSED);
    runtime.fillBudget = true;
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));
    expect(displayed(chunks)).toBe('Hello.');
    expect(chunks.at(-1)).toEqual({ id: 'a', final: 'Hello.', engine: 'plamo', error: true });
  });

  it('does not cache a block that fell back to the original text', async () => {
    const gpu = new FakeRuntime(() => COLLAPSED, 1, 'webgpu');
    gpu.fillBudget = true;
    const cpu = new FakeRuntime(() => COLLAPSED);
    cpu.fillBudget = true;
    const store = new MemoryTranslationCacheStore();
    const inner = new InBrowserEngine(gpu, { loadRetryRuntime: async () => cpu });
    const engine = new CachingEngine(inner, new TranslationCache(store), 'plamo', 'webgpu');
    const segments = [{ id: 'a', text: 'Hello.' }];

    const first = await collectChunks(engine.translate(segments, options()));
    const second = await collectChunks(engine.translate(segments, options()));

    expect(first.at(-1)).toEqual({ id: 'a', final: 'Hello.', engine: 'plamo', error: true });
    expect(second.at(-1)?.error).toBe(true);
    expect(gpu.requests.length).toBeGreaterThan(1);
  });
});

describe('LazyInBrowserEngine degenerate pieces', () => {
  it('retries one collapsed block on CPU and keeps the GPU session', async () => {
    const gpu = new FakeRuntime(
      (prompt) => {
        const source = promptSource(prompt);
        return source === 'Hello.' ? COLLAPSED : `訳:${source}`;
      },
      1,
      'webgpu',
    );
    gpu.fillBudget = true;
    const cpu = new FakeRuntime(() => 'こんにちは');
    const onGpuLost = vi.fn(async () => undefined);
    const loadRuntime = vi.fn(async () => ({ runtime: gpu, selection: GPU }));
    const engine = new LazyInBrowserEngine({
      loadRuntime,
      loadRetryRuntime: async () => cpu,
      onGpuLost,
      config: { maxSegmentTokens: 1 },
    });

    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'Hello.' },
          { id: 'b', text: 'Good morning.' },
        ],
        options(),
      ),
    );

    expect(chunks.find((chunk) => chunk.id === 'a' && chunk.final)?.final).toBe('こんにちは');
    expect(chunks.find((chunk) => chunk.id === 'b' && chunk.final)?.final).toBe('訳:Good morning.');
    expect(onGpuLost).not.toHaveBeenCalled();
    expect(loadRuntime).toHaveBeenCalledOnce();
  });

  it('falls back the session only after several distinct collapsed blocks', async () => {
    const gpu = new FakeRuntime(() => COLLAPSED, 1, 'webgpu');
    gpu.fillBudget = true;
    const cpu = new FakeRuntime(() => 'こんにちは');
    const onGpuLost = vi.fn(async () => undefined);
    const engine = new LazyInBrowserEngine({
      loadRuntime: async () => ({ runtime: gpu, selection: GPU }),
      loadRetryRuntime: async () => cpu,
      onGpuLost,
      config: { maxSegmentTokens: 1 },
    });

    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'One sentence about the harbour lights.' },
          { id: 'b', text: 'Another sentence about the harbour lights.' },
          { id: 'c', text: 'A third sentence about the harbour lights.' },
        ],
        options(),
      ),
    );

    expect(chunks.filter((chunk) => chunk.final !== undefined)).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.final === undefined || chunk.final === 'こんにちは')).toBe(
      true,
    );
    expect(onGpuLost).toHaveBeenCalledOnce();
    expect(onGpuLost).toHaveBeenCalledWith('degenerate');
  });

  it('translates a page of legitimate repeats without a session-wide fallback', async () => {
    const runtime = new FakeRuntime(
      (prompt) => {
        const source = promptSource(prompt);
        const match = LEGITIMATE.find((sample) => sample.source === source);
        if (match) return match.output;
        if (source === 'The team published the paper.') return '研究チームは論文を公開した。';
        return `訳:${source}`;
      },
      4,
      'webgpu',
    );
    const onGpuLost = vi.fn(async () => undefined);
    const engine = new LazyInBrowserEngine({
      loadRuntime: async () => ({ runtime, selection: GPU }),
      loadRetryRuntime: async () => new FakeRuntime(() => 'unused'),
      onGpuLost,
      config: { maxSegmentTokens: 1 },
    });

    const segments: TranslateSegment[] = [
      ...LEGITIMATE.map((sample, index) => ({ id: `r${String(index)}`, text: sample.source })),
      { id: 'normal', text: 'The team published the paper.' },
    ];
    const chunks = await collectChunks(engine.translate(segments, options()));
    const finals = chunks.filter((chunk) => chunk.final !== undefined);

    expect(finals).toHaveLength(segments.length);
    expect(finals.find((chunk) => chunk.id === 'normal')?.final).toBe(
      '研究チームは論文を公開した。',
    );
    expect(onGpuLost).not.toHaveBeenCalled();
  });
});

describe('CachingEngine chrome output', () => {
  it('caches a legitimate repeated Chrome translation', async () => {
    const store = new MemoryTranslationCacheStore();
    const repeated = 'ハ'.repeat(18);
    const inner = fakeEngine('chrome', [{ id: 'a', final: repeated, engine: 'chrome' }]);
    const engine = new CachingEngine(inner, new TranslationCache(store), 'chrome', 'chrome');

    const first = await collectChunks(engine.translate([{ id: 'a', text: 'Hahaha…' }], options()));
    const second = await collectChunks(engine.translate([{ id: 'a', text: 'Hahaha…' }], options()));

    expect(first.at(-1)?.final).toBe(repeated);
    expect(second.at(-1)?.final).toBe(repeated);
    expect(inner.calls).toBe(1);
  });
});
