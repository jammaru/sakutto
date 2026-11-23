/**
 * Re-measures only the sentence rows of the mock-tier reveal comparison. The main and
 * smooth builds are unchanged by the viewport fast path, so their rows in
 * bench/results/reveal-compare.{json,md} are kept verbatim; the sentence rows are
 * rebuilt from a fresh run against the current .output/chrome-mv3 build.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=... node --import ./scripts/bench/register-ts.mjs bench/reveal-sentence-bench.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runPageBench } from '../scripts/bench/pages-runner.ts';

const ROOT = resolve(import.meta.dirname, '..');
const PAGES = ['long-article', 'first-paragraph-then-long-tail', 'many-cards', 'mixed-ui'] as const;

interface Row {
  variant: string;
  page: string;
  firstVisibleMs: number | null;
  fullPageMs: number | null;
  cls: number | null;
  layoutShifts: number | null;
  requestMs?: number | null;
  ttfbMs?: number | null;
  paintMs?: number | null;
}

const previous = JSON.parse(
  readFileSync(resolve(ROOT, 'bench/results/reveal-compare.json'), 'utf8'),
) as Row[];
const rows: Row[] = previous.filter((row) => row.variant !== 'sentence');

for (const page of PAGES) {
  const result = await runPageBench({
    mode: 'mock',
    extension: resolve(ROOT, '.output/chrome-mv3'),
    only: page,
    samples: 1,
    run: 'reveal-sentence',
    tier: 'c8',
    reveal: 'sentence',
    writeHistory: false,
    writeSummary: false,
  });
  for (const record of result.records) {
    rows.push({
      variant: 'sentence',
      page: record.page,
      firstVisibleMs: record.metrics.firstVisibleTextMs,
      fullPageMs: record.metrics.fullPageMs,
      cls: record.metrics.cls ?? null,
      layoutShifts: record.metrics.layoutShifts ?? null,
      requestMs: record.metrics.engineWork.requestMs ?? null,
      ttfbMs: record.metrics.engineWork.ttfbMs ?? null,
      paintMs: record.metrics.engineWork.paintMs ?? null,
    });
  }
}

const cell = (value: number | null | undefined): string =>
  value === null || value === undefined ? '-' : String(Math.round(value * 10000) / 10000);

const lines = [
  '# Reveal mode comparison (mock tier c8)',
  '',
  '`main` is the pre-reveal streaming build; `smooth` and `sentence` are this branch.',
  'Mock pace: 12 ms prefill, 0.35 ms per character, 3 deltas. Times are milliseconds.',
  '',
  '| Page | Mode | First visible | Full page | CLS | Layout shifts |',
  '| --- | --- | ---: | ---: | ---: | ---: |',
  ...rows.map(
    (row) =>
      `| ${row.page} | ${row.variant} | ${cell(row.firstVisibleMs)} | ${cell(
        row.fullPageMs,
      )} | ${cell(row.cls)} | ${cell(row.layoutShifts)} |`,
  ),
  '',
];

writeFileSync(
  resolve(ROOT, 'bench/results/reveal-compare.json'),
  `${JSON.stringify(rows, null, 2)}
`,
);
writeFileSync(resolve(ROOT, 'bench/results/reveal-compare.md'), lines.join('\n'));
console.log(lines.join('\n'));
