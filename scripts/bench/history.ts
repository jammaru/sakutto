import { appendFile } from 'node:fs/promises';

/**
 * One line of `bench/history/pages.jsonl`: the numbers for one fixture in one run.
 * A later improvement is compared against an earlier run of the same fixtures.
 */
export interface BenchRecord {
  schema: 1;
  /** Groups every fixture measured by one invocation. */
  run: string;
  mode: 'mock' | 'live';
  /** Full commit SHA of the working tree the numbers describe. */
  commit: string;
  /** True when the tree had uncommitted changes, so the numbers may not match the commit. */
  dirty: boolean;
  at: string;
  page: string;
  /** 1-based repetition index, and how many repetitions this run took. */
  sample: number;
  samples: number;
  engine: BenchEngine;
  machine: BenchMachine;
  metrics: BenchMetrics;
  notes?: string;
}

export interface BenchEngine {
  /** `mock` for the fake in-page translator, `cpu-wasm` or `webgpu` for the real runtime. */
  label: string;
  backend: string | null;
  tier: string | null;
  threads: number | null;
  /** Whether the page had Chrome's built-in translator available to draft text. */
  chromeTranslator: boolean;
  model: string | null;
}

export interface BenchMachine {
  platform: string;
  cores: number;
  userAgent: string;
  crossOriginIsolated: boolean;
  viewport: { width: number; height: number };
}

export interface BenchMetrics {
  /** Harness command to the first changed block of any kind. */
  firstTextMs: number | null;
  /** Same, for prose that was on screen when the recorder first saw it. */
  firstVisibleTextMs: number | null;
  /** Every prose block that was on screen when first seen has a finished translation. */
  viewportDoneMs: number | null;
  /** The whole page settled, or null when the run hit the timeout. */
  fullPageMs: number | null;
  /** Blocks finished per second between first text and completion. */
  commitsPerSecond: number | null;
  /** Output characters that landed in the DOM. */
  outputChars: number;
  /** Rough output token rate from the characters and the elapsed time; live mode only. */
  estimatedOutputTokensPerSecond: number | null;
  /** The rate the page overlay itself reported, verbatim. */
  reportedRate: string | null;
  /**
   * How the page drove the engine, from the existing `sakutto-perf` hook. Batches and
   * pieces stay comparable in mock mode, where they are the only engine-side signals.
   */
  engineWork: {
    batches: number | null;
    pieces: number | null;
    previews: number | null;
    engineMs: number | null;
  };
  blocks: {
    total: number;
    prose: number;
    headings: number;
    ui: number;
    code: number;
    visibleProse: number;
    finished: number;
  };
  /** Marked blocks the extension never finished. Present only when the run was partial. */
  unfinished?: string[];
  lateBlocks: number;
  engines: Record<string, number>;
  codeUntouched: boolean | null;
  state: string | null;
  progress: string | null;
  timedOut: boolean;
}

export type BenchMetricKey =
  | 'firstTextMs'
  | 'firstVisibleTextMs'
  | 'viewportDoneMs'
  | 'fullPageMs'
  | 'commitsPerSecond'
  | 'estimatedOutputTokensPerSecond';

export const TIMING_METRICS: readonly BenchMetricKey[] = [
  'firstVisibleTextMs',
  'viewportDoneMs',
  'fullPageMs',
  'commitsPerSecond',
];

const MODES: ReadonlySet<string> = new Set(['mock', 'live']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Validates a parsed history line. CI runs this over what the mock bench wrote so a
 * schema change cannot silently leave the history unreadable for later comparisons.
 */
export function isBenchRecord(value: unknown): value is BenchRecord {
  if (!isRecord(value)) return false;
  if (value.schema !== 1) return false;
  if (typeof value.run !== 'string' || value.run.length === 0) return false;
  if (typeof value.mode !== 'string' || !MODES.has(value.mode)) return false;
  if (typeof value.commit !== 'string' || !/^[0-9a-f]{7,40}$/u.test(value.commit)) return false;
  if (typeof value.dirty !== 'boolean') return false;
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) return false;
  if (typeof value.page !== 'string' || value.page.length === 0) return false;
  if (typeof value.sample !== 'number' || value.sample < 1) return false;
  if (typeof value.samples !== 'number' || value.samples < value.sample) return false;

  const engine = value.engine;
  if (!isRecord(engine)) return false;
  if (typeof engine.label !== 'string') return false;
  if (typeof engine.chromeTranslator !== 'boolean') return false;
  if (engine.backend !== null && typeof engine.backend !== 'string') return false;
  if (engine.tier !== null && typeof engine.tier !== 'string') return false;
  if (engine.threads !== null && typeof engine.threads !== 'number') return false;
  if (engine.model !== null && typeof engine.model !== 'string') return false;

  const machine = value.machine;
  if (!isRecord(machine)) return false;
  if (typeof machine.platform !== 'string') return false;
  if (typeof machine.cores !== 'number') return false;
  if (typeof machine.userAgent !== 'string') return false;
  if (typeof machine.crossOriginIsolated !== 'boolean') return false;
  const viewport = machine.viewport;
  if (!isRecord(viewport)) return false;
  if (typeof viewport.width !== 'number' || typeof viewport.height !== 'number') return false;

  const metrics = value.metrics;
  if (!isRecord(metrics)) return false;
  for (const key of [
    'firstTextMs',
    'firstVisibleTextMs',
    'viewportDoneMs',
    'fullPageMs',
    'commitsPerSecond',
    'estimatedOutputTokensPerSecond',
  ] as const) {
    if (!isNullableNumber(metrics[key])) return false;
  }
  if (typeof metrics.outputChars !== 'number') return false;
  if (metrics.reportedRate !== null && typeof metrics.reportedRate !== 'string') return false;
  const work = metrics.engineWork;
  if (!isRecord(work)) return false;
  for (const key of ['batches', 'pieces', 'previews', 'engineMs'] as const) {
    if (!isNullableNumber(work[key])) return false;
  }
  if (typeof metrics.lateBlocks !== 'number') return false;
  if (typeof metrics.timedOut !== 'boolean') return false;
  if (metrics.codeUntouched !== null && typeof metrics.codeUntouched !== 'boolean') return false;
  if (metrics.state !== null && typeof metrics.state !== 'string') return false;
  if (metrics.progress !== null && typeof metrics.progress !== 'string') return false;

  const blocks = metrics.blocks;
  if (!isRecord(blocks)) return false;
  for (const key of [
    'total',
    'prose',
    'headings',
    'ui',
    'code',
    'visibleProse',
    'finished',
  ] as const) {
    if (typeof blocks[key] !== 'number') return false;
  }
  if (!isRecord(metrics.engines)) return false;
  for (const count of Object.values(metrics.engines)) {
    if (typeof count !== 'number') return false;
  }
  if (metrics.unfinished !== undefined) {
    if (!Array.isArray(metrics.unfinished)) return false;
    for (const id of metrics.unfinished) {
      if (typeof id !== 'string') return false;
    }
  }
  if (value.notes !== undefined && typeof value.notes !== 'string') return false;

  return true;
}

export function parseHistory(text: string): { records: BenchRecord[]; problems: string[] } {
  const records: BenchRecord[] = [];
  const problems: string[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isBenchRecord(parsed)) records.push(parsed);
      else problems.push(`line ${String(index + 1)} is not a bench record`);
    } catch {
      problems.push(`line ${String(index + 1)} is not JSON`);
    }
  }
  return { records, problems };
}

export function serializeRecord(record: BenchRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** Appends in one write so a crashed run cannot leave a half line in the history. */
export async function appendHistory(path: string, records: readonly BenchRecord[]): Promise<void> {
  if (records.length === 0) return;
  await appendFile(path, records.map(serializeRecord).join(''), 'utf8');
}

export function runsInOrder(records: readonly BenchRecord[]): string[] {
  const seen: string[] = [];
  for (const record of records) {
    if (!seen.includes(record.run)) seen.push(record.run);
  }
  return seen;
}

/** The newest record per page, for a "latest state of every fixture" table. */
export function latestByPage(records: readonly BenchRecord[]): BenchRecord[] {
  const latest = new Map<string, BenchRecord>();
  for (const record of records) latest.set(record.page, record);
  return [...latest.values()].sort((left, right) => left.page.localeCompare(right.page));
}

/** Records of the newest run, or of the run named by `run`. */
export function recordsOfRun(records: readonly BenchRecord[], run: string): BenchRecord[] {
  return records.filter((record) => record.run === run);
}

export function recordsForPage(records: readonly BenchRecord[], page: string): BenchRecord[] {
  return records.filter((record) => record.page === page);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1] ?? 0;
  const upper = sorted[middle] ?? 0;
  return Math.round(((lower + upper) / 2) * 10) / 10;
}

/** Median of one metric across the repetitions a run took for one page. */
export function medianMetric(
  records: readonly BenchRecord[],
  metric: BenchMetricKey,
): number | null {
  const values: number[] = [];
  for (const record of records) {
    const value = record.metrics[metric];
    if (value !== null) values.push(value);
  }
  return median(values);
}

export interface ComparisonRow {
  page: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  /** Percentage change; negative means the after run was faster for a timing metric. */
  percent: number | null;
  samplesBefore: number;
  samplesAfter: number;
}

export function comparisonRows(
  before: readonly BenchRecord[],
  after: readonly BenchRecord[],
  metric: BenchMetricKey,
): ComparisonRow[] {
  const pages = [...new Set(after.map((record) => record.page))].sort((left, right) =>
    left.localeCompare(right),
  );
  const rows: ComparisonRow[] = [];
  for (const page of pages) {
    const beforeSamples = recordsForPage(before, page);
    const afterSamples = recordsForPage(after, page);
    const beforeValue = medianMetric(beforeSamples, metric);
    const afterValue = medianMetric(afterSamples, metric);
    const delta =
      beforeValue === null || afterValue === null
        ? null
        : Math.round((afterValue - beforeValue) * 10) / 10;
    const percent =
      beforeValue === null || afterValue === null || beforeValue === 0
        ? null
        : Math.round(((afterValue - beforeValue) / beforeValue) * 1000) / 10;
    rows.push({
      page,
      before: beforeValue,
      after: afterValue,
      delta,
      percent,
      samplesBefore: beforeSamples.length,
      samplesAfter: afterSamples.length,
    });
  }
  return rows;
}

function cell(value: number | null): string {
  return value === null ? '—' : String(value);
}

function signed(value: number | null): string {
  if (value === null) return '—';
  return value > 0 ? `+${String(value)}` : String(value);
}

export function markdownComparison(
  title: string,
  rows: readonly ComparisonRow[],
  unit: string,
): string {
  const header = [
    `### ${title}`,
    '',
    `| Page | Before (${unit}) | After (${unit}) | Delta | Change |`,
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  const body = rows.map(
    (row) =>
      `| ${row.page} | ${cell(row.before)} | ${cell(row.after)} | ${signed(row.delta)} | ${
        row.percent === null ? '—' : `${signed(row.percent)}%`
      } |`,
  );
  return [...header, ...body].join('\n');
}

const METRIC_LABELS: Record<BenchMetricKey, { title: string; unit: string }> = {
  firstTextMs: { title: 'First text anywhere', unit: 'ms' },
  firstVisibleTextMs: { title: 'First visible translated text', unit: 'ms' },
  viewportDoneMs: { title: 'Visible viewport translated', unit: 'ms' },
  fullPageMs: { title: 'Whole page translated', unit: 'ms' },
  commitsPerSecond: { title: 'Blocks committed per second', unit: 'blocks/s' },
  estimatedOutputTokensPerSecond: { title: 'Estimated output tokens per second', unit: 'tok/s' },
};

export interface RunSummaryInput {
  run: string;
  mode: string;
  commit: string;
  dirty: boolean;
  at: string;
  records: readonly BenchRecord[];
  before?: { run: string; records: readonly BenchRecord[] } | undefined;
}

/** The human-readable half of the history: one markdown table per run. */
export function runSummary(input: RunSummaryInput): string {
  const pages = [...new Set(input.records.map((record) => record.page))];
  const lines: string[] = [
    `# Page bench — ${input.run}`,
    '',
    `- Mode: ${input.mode}`,
    `- Commit: \`${input.commit}\`${input.dirty ? ' (dirty working tree)' : ''}`,
    `- Started: ${input.at}`,
    `- Fixtures: ${String(pages.length)}, samples per fixture: ${String(
      input.records[0]?.samples ?? 0,
    )}`,
    '',
    '| Page | First visible text (ms) | Viewport done (ms) | Full page (ms) | Blocks/s | Output chars | Engine |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];

  for (const page of pages) {
    const samples = recordsForPage(input.records, page);
    const first = samples[0];
    if (!first) continue;
    lines.push(
      `| ${page} | ${cell(medianMetric(samples, 'firstVisibleTextMs'))} | ${cell(
        medianMetric(samples, 'viewportDoneMs'),
      )} | ${cell(medianMetric(samples, 'fullPageMs'))} | ${cell(
        medianMetric(samples, 'commitsPerSecond'),
      )} | ${String(first.metrics.outputChars)} | ${first.engine.label} |`,
    );
  }

  const timedOut = input.records.filter((record) => record.metrics.timedOut);
  if (timedOut.length > 0) {
    lines.push(
      '',
      `Timed out: ${[...new Set(timedOut.map((record) => record.page))].join(', ')}. Those rows have no full-page number.`,
    );
  }

  if (input.before) {
    lines.push('', `Compared with run \`${input.before.run}\`:`, '');
    for (const metric of TIMING_METRICS) {
      const rows = comparisonRows(input.before.records, input.records, metric);
      if (rows.length === 0) continue;
      const labels = METRIC_LABELS[metric];
      lines.push(markdownComparison(labels.title, rows, labels.unit), '');
    }
    lines.push(
      'For every timing row, a negative delta means the page finished faster and a negative',
      'percentage is the improvement. For blocks/s, higher is better.',
      '',
    );
  }

  if (input.mode === 'mock') {
    lines.push(
      '',
      'Mock mode replaces the model with an in-page stub, so these durations describe',
      'scheduling, DOM painting, batching and harness overhead — not translation speed.',
      'They are only comparable with other mock runs.',
      '',
    );
  }
  return lines.join('\n');
}

export { METRIC_LABELS };
