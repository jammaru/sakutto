import { describe, expect, it } from 'vitest';

import {
  acceleratorFor,
  comparisonRows,
  headlineFor,
  headlineSection,
  isBenchRecord,
  markdownComparison,
  medianMetric,
  parseHistory,
  runSummary,
  seconds,
  serializeRecord,
  tweetDraft,
  type BenchRecord,
} from '../scripts/bench/history.ts';

function record(overrides: Partial<BenchRecord> = {}): BenchRecord {
  return {
    schema: 1,
    run: 'mock-2026-11-06T00-00-00',
    mode: 'mock',
    commit: '3eeb1a8f85578d5191fe4d8aefb3f9bd623cbb47',
    dirty: false,
    at: '2026-11-06T00:00:00.000Z',
    page: 'long-article',
    sample: 1,
    samples: 1,
    headline: true,
    engine: {
      label: 'mock',
      backend: null,
      tier: 'c4',
      threads: null,
      chromeTranslator: false,
      model: null,
      accelerator: 'mock',
      accelerateLabel: 'mock translator',
    },
    machine: {
      platform: 'Linux x86_64',
      cores: 4,
      userAgent: 'HeadlessChrome/1',
      crossOriginIsolated: true,
      viewport: { width: 1280, height: 800 },
    },
    metrics: {
      firstTextMs: 40,
      firstVisibleTextMs: 60,
      viewportDoneMs: 900,
      fullPageMs: 4000,
      commitsPerSecond: 11,
      outputChars: 7000,
      estimatedOutputTokensPerSecond: null,
      reportedRate: '100.0 tok/s, 4.0 seg/s',
      engineWork: { batches: 12, pieces: 26, engineMs: 3800 },
      blocks: {
        total: 44,
        prose: 22,
        headings: 5,
        ui: 17,
        code: 0,
        visibleProse: 6,
        finished: 44,
      },
      lateBlocks: 0,
      engines: { plamo: 44 },
      codeUntouched: null,
      state: 'translated',
      progress: '26/26',
      timedOut: false,
    },
    ...overrides,
  };
}

describe('bench history records', () => {
  it('accepts a record the runner produces', () => {
    expect(isBenchRecord(record())).toBe(true);
  });

  it('rejects a record with a missing metric or a wrong mode', () => {
    const noFullPage = record();
    delete (noFullPage.metrics as { fullPageMs?: number | null }).fullPageMs;
    expect(isBenchRecord(noFullPage)).toBe(false);

    expect(isBenchRecord({ ...record(), mode: 'dry' })).toBe(false);
    expect(isBenchRecord({ ...record(), commit: 'not-a-sha' })).toBe(false);
    expect(isBenchRecord({ ...record(), schema: 2 })).toBe(false);
  });

  it('round-trips through the JSONL history', () => {
    const text = [record(), record({ page: 'many-cards', sample: 2, samples: 2 })]
      .map(serializeRecord)
      .join('');
    const { records, problems } = parseHistory(text);
    expect(problems).toEqual([]);
    expect(records.map((item) => item.page)).toEqual(['long-article', 'many-cards']);
  });

  it('reports a corrupt line without discarding the rest of the history', () => {
    const text = `${serializeRecord(record())}{ not json\n${serializeRecord(
      record({ page: 'mixed-ui' }),
    )}`;
    const { records, problems } = parseHistory(text);
    expect(records.map((item) => item.page)).toEqual(['long-article', 'mixed-ui']);
    expect(problems).toHaveLength(1);
  });
});

describe('bench comparisons', () => {
  it('uses the median of the repetitions instead of one noisy sample', () => {
    const samples = [
      record({ sample: 1, samples: 3 }),
      record({
        sample: 2,
        samples: 3,
        metrics: { ...record().metrics, fullPageMs: 9000 },
      }),
      record({
        sample: 3,
        samples: 3,
        metrics: { ...record().metrics, fullPageMs: 4200 },
      }),
    ];
    expect(medianMetric(samples, 'fullPageMs')).toBe(4200);
  });

  it('reports an improvement as a negative percentage on a timing metric', () => {
    const before = [record({ run: 'before', metrics: { ...record().metrics, fullPageMs: 4000 } })];
    const after = [
      record({
        run: 'after',
        metrics: { ...record().metrics, fullPageMs: 3200, commitsPerSecond: 14 },
      }),
    ];

    const [row] = comparisonRows(before, after, 'fullPageMs');
    expect(row).toMatchObject({ page: 'long-article', before: 4000, after: 3200, delta: -800 });
    expect(row?.percent).toBe(-20);
    expect(markdownComparison('Whole page translated', [row!], 'ms')).toContain(
      '| long-article | 4000 | 3200 | -800 | -20% |',
    );
  });

  it('leaves a page with no earlier measurement out of the delta and names it anyway', () => {
    const after = [
      record({
        run: 'after',
        page: 'new-page',
        metrics: { ...record().metrics, fullPageMs: 1000 },
      }),
    ];
    const [row] = comparisonRows([], after, 'fullPageMs');
    expect(row).toMatchObject({ page: 'new-page', before: null, delta: null, percent: null });
  });

  it('summarizes a run and warns that mock numbers are not model speed', () => {
    const summary = runSummary({
      run: 'after',
      mode: 'mock',
      commit: '3eeb1a8',
      dirty: true,
      at: '2026-11-06T00:00:00.000Z',
      records: [record({ run: 'after' })],
    });
    expect(summary).toContain('Mock mode replaces the model');
    expect(summary).toContain('dirty working tree');
    expect(summary).toContain('| long-article |');
  });
});

describe('headline numbers', () => {
  it('quotes the long article in seconds under the release copy names', () => {
    const headline = headlineFor([
      record({
        metrics: {
          ...record().metrics,
          firstVisibleTextMs: 27911,
          fullPageMs: 66576,
        },
      }),
    ]);

    expect(headline).toEqual({
      timeToFirstParagraphMs: 27911,
      fullPageMs: 66576,
      tailMs: 38665,
      fixture: 'long-article',
    });
    expect(seconds(headline.timeToFirstParagraphMs)).toBe('27.9');
    expect(seconds(headline.fullPageMs)).toBe('66.6');
  });

  it('takes the median across samples, so one slow sample does not become the quote', () => {
    const samples = [
      record({ sample: 1, samples: 3 }),
      record({
        sample: 2,
        samples: 3,
        metrics: { ...record().metrics, firstVisibleTextMs: 9000, fullPageMs: 30000 },
      }),
      record({
        sample: 3,
        samples: 3,
        metrics: { ...record().metrics, firstVisibleTextMs: 3000, fullPageMs: 31000 },
      }),
    ];
    const headline = headlineFor(samples);
    expect(seconds(headline.timeToFirstParagraphMs)).toBe('3.0');
    // Median of 4000, 30000 and 31000 is the middle sample.
    expect(seconds(headline.fullPageMs)).toBe('30.0');
  });

  it('labels CPU and WebGPU separately, and never calls a mock run either', () => {
    expect(acceleratorFor({ mode: 'live', backend: 'cpu-wasm' })).toEqual({
      accelerator: 'cpu',
      accelerateLabel: 'CPU only',
    });
    expect(acceleratorFor({ mode: 'live', backend: 'webgpu' })).toEqual({
      accelerator: 'webgpu',
      accelerateLabel: 'WebGPU',
    });
    expect(acceleratorFor({ mode: 'mock', backend: null }).accelerator).toBe('mock');
    expect(acceleratorFor({ mode: 'live', backend: null }).accelerator).toBe('unknown');
  });

  it('warns when a comparison spans different acceleration', () => {
    const cpu = record({
      run: 'before',
      engine: {
        ...record().engine,
        accelerator: 'cpu',
        accelerateLabel: 'CPU only',
        label: 'cpu-wasm',
      },
      metrics: { ...record().metrics, firstVisibleTextMs: 27911, fullPageMs: 66576 },
    });
    const gpu = record({
      run: 'after',
      engine: {
        ...record().engine,
        accelerator: 'webgpu',
        accelerateLabel: 'WebGPU',
        label: 'webgpu',
      },
      metrics: { ...record().metrics, firstVisibleTextMs: 2900, fullPageMs: 30800 },
    });

    const section = headlineSection([gpu], 'long-article', {
      run: 'before',
      records: [cpu],
    }).join('\n');

    expect(section).toContain('| Time to first visible translated paragraph | 2.9 s |');
    expect(section).toContain('| Full page translated | 30.8 s |');
    expect(section).toContain('different acceleration');
    expect(section).toContain('-89.6%');
  });

  it('drafts copy-ready sentences from a record without inventing a comparison', () => {
    const draft = tweetDraft({
      records: [
        record({
          mode: 'live',
          engine: { ...record().engine, accelerator: 'cpu', accelerateLabel: 'CPU only' },
          metrics: { ...record().metrics, firstVisibleTextMs: 2900, fullPageMs: 30800 },
        }),
      ],
      run: 'after',
    });

    expect(draft).toContain('最初の段落が出るまで: 2.9秒');
    expect(draft).toContain('ページ全体が訳し終わるまで: 30.8秒');
    expect(draft).toContain('CPU only');
    // No improvement claim unless a previous run was supplied.
    expect(draft).not.toContain('→');
  });

  it('writes the before → after pair in the release copy style', () => {
    const before = record({
      run: 'before',
      mode: 'live',
      engine: { ...record().engine, accelerator: 'cpu', accelerateLabel: 'CPU only' },
      metrics: { ...record().metrics, firstVisibleTextMs: 27911, fullPageMs: 66576 },
    });
    const after = record({
      run: 'after',
      mode: 'live',
      engine: { ...record().engine, accelerator: 'cpu', accelerateLabel: 'CPU only' },
      metrics: { ...record().metrics, firstVisibleTextMs: 2900, fullPageMs: 30800 },
    });

    const draft = tweetDraft({
      records: [after],
      run: 'after',
      before: { run: 'before', records: [before] },
    });

    expect(draft).toContain('CPUだけで、最初の段落が出るまで27.9秒→2.9秒');
    expect(draft).toContain('長い記事1ページ丸ごとで66.6秒→30.8秒');
    // A live draft is presentable; only mock output carries the warning.
    expect(draft).not.toContain('モックなので');
  });

  it('does not call a WebGPU run a CPU measurement', () => {
    const gpu = record({
      mode: 'live',
      engine: { ...record().engine, accelerator: 'webgpu', accelerateLabel: 'WebGPU' },
      metrics: { ...record().metrics, firstVisibleTextMs: 1200, fullPageMs: 9000 },
    });
    const draft = tweetDraft({
      records: [gpu],
      run: 'after',
      before: { run: 'before', records: [record({ run: 'before' })] },
    });
    expect(draft).not.toContain('CPUだけで');
    expect(draft).toContain('WebGPU、最初の段落が出るまで');
    expect(draft).toContain('ハードの違い');
  });

  it('refuses to draft copy for a fixture the run never measured', () => {
    expect(tweetDraft({ records: [], run: 'after' })).toContain('記録がありません');
  });
});
