import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ROOT, arg } from './host.ts';
import {
  HEADLINE_PAGE,
  comparisonRows,
  headlineSection,
  latestByPage,
  markdownComparison,
  METRIC_LABELS,
  parseHistory,
  recordsOfRun,
  runSummary,
  runsInOrder,
  TIMING_METRICS,
  type BenchMetricKey,
  type BenchRecord,
} from './history.ts';

const DEFAULT_HISTORY = resolve(ROOT, 'bench/history/pages.jsonl');

async function loadHistory(path: string): Promise<BenchRecord[]> {
  try {
    const text = await readFile(path, 'utf8');
    const { records, problems } = parseHistory(text);
    for (const problem of problems) console.error(`history: ${problem}`);
    return records;
  } catch {
    return [];
  }
}

function formatRow(record: BenchRecord): string {
  const metrics = record.metrics;
  const cell = (value: number | null): string => (value === null ? '—' : String(value));
  return [
    record.page.padEnd(24),
    cell(metrics.firstVisibleTextMs).padStart(9),
    cell(metrics.viewportDoneMs).padStart(9),
    cell(metrics.fullPageMs).padStart(9),
    cell(metrics.commitsPerSecond).padStart(9),
    record.mode.padStart(5),
  ].join('  ');
}

function pageTable(records: readonly BenchRecord[]): string[] {
  const lines = [
    'page                      firstVis  viewport     full  blocks/s   mode',
    '-----------------------  --------  --------  -------  --------  -----',
  ];
  for (const record of latestByPage(records)) lines.push(formatRow(record));
  return lines;
}

async function main(): Promise<void> {
  const path = resolve(arg('--history') ?? DEFAULT_HISTORY);
  const records = await loadHistory(path);

  if (arg('--summary') !== undefined) {
    const run = arg('--summary');
    const selected = run === undefined ? [] : recordsOfRun(records, run);
    if (selected.length === 0) {
      console.error(`No records for run "${run ?? ''}".`);
      process.exitCode = 1;
      return;
    }
    const previousRuns = runsInOrder(records).filter((label) => label !== run);
    const compareWith = arg('--compare') ?? previousRuns[previousRuns.length - 1];
    console.log(
      runSummary({
        run: run ?? '',
        mode: selected[0]?.mode ?? 'mock',
        commit: selected[0]?.commit ?? '',
        dirty: selected[0]?.dirty ?? false,
        at: selected[0]?.at ?? '',
        records: selected,
        ...(compareWith
          ? { before: { run: compareWith, records: recordsOfRun(records, compareWith) } }
          : {}),
      }),
    );
    return;
  }

  const compare = arg('--compare');
  const baseline = arg('--baseline');
  if (records.length === 0) {
    console.log(
      `${path} is empty. Run "pnpm bench:mock" or "pnpm bench:live" to add the first run.`,
    );
    return;
  }

  const runs = runsInOrder(records);
  console.log(`${path}`);
  console.log(`${String(runs.length)} run(s): ${runs.join(', ')}`);
  console.log('');
  console.log(pageTable(records));

  let before: BenchRecord[];
  let after: BenchRecord[];
  if (baseline !== undefined) {
    before = recordsOfRun(records, baseline);
    after = compare === undefined ? [] : recordsOfRun(records, compare);
    if (before.length === 0 || after.length === 0) {
      console.error('Both --baseline and --compare must name runs in the history.');
      process.exitCode = 1;
      return;
    }
  } else {
    const latest = runs[runs.length - 1];
    after = latest === undefined ? [] : recordsOfRun(records, latest);
    const previous = runs[runs.length - 2];
    before = previous === undefined ? [] : recordsOfRun(records, previous);
    if (previous !== undefined && latest !== undefined) {
      console.log('', `Comparing ${latest} with ${previous}.`);
    }
  }

  const latestRun = runs[runs.length - 1] ?? '';
  const latestRecords = latestRun === '' ? [] : recordsOfRun(records, latestRun);

  if (before.length === 0 || after.length === 0) {
    // A single run in the history still has headline numbers worth printing.
    if (latestRecords.length > 0) {
      console.log('');
      console.log(headlineSection(latestRecords, HEADLINE_PAGE).join('\n'));
    }
    return;
  }

  const modes = new Set([...before, ...after].map((record) => record.mode));
  if (modes.size > 1) {
    console.log('');
    console.log(
      'Warning: these runs used different modes; mock and live numbers cannot be compared.',
    );
  }

  for (const metric of TIMING_METRICS as readonly BenchMetricKey[]) {
    const rows = comparisonRows(before, after, metric);
    if (rows.every((row) => row.before === null && row.after === null)) continue;
    const labels = METRIC_LABELS[metric];
    console.log('');
    console.log(markdownComparison(labels.title, rows, labels.unit));
  }

  // The two headline numbers, in seconds, next to the previous run of the same page.
  const previousRun = runs[runs.length - 2];
  console.log('');
  console.log(
    headlineSection(after, HEADLINE_PAGE, {
      run: baseline ?? previousRun ?? '',
      records: before,
    }).join('\n'),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
