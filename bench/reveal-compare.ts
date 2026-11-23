/**
 * Mock-tier comparison of the page reveal modes: main's streaming behaviour, the
 * current smooth swap and the per-sentence reveal. Run after building the mock
 * extensions:
 *
 *   pnpm bench:build:mock
 *   pnpm exec wxt build   (from a main worktree with SAKUTTO_FAKE_ENGINE=1)
 *   node bench/reveal-compare.ts
 *
 * Results go to bench/results/reveal-compare.{json,md} and are not measured live.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runPageBench } from '../scripts/bench/pages-runner.ts';

const ROOT = resolve(import.meta.dirname, '..');
const PAGES = ['long-article', 'first-paragraph-then-long-tail', 'many-cards', 'mixed-ui'] as const;

const VARIANTS = [
  {
    label: 'main',
    mode: 'stream' as const,
    extension: resolve(process.env.MAIN_EXTENSION ?? '.bench-main/.output/chrome-mv3'),
  },
  {
    label: 'smooth',
    mode: 'smooth' as const,
    extension: resolve(ROOT, '.output/chrome-mv3'),
  },
  {
    label: 'sentence',
    mode: 'sentence' as const,
    extension: resolve(ROOT, '.output/chrome-mv3'),
  },
];

interface Row {
  variant: string;
  page: string;
  firstVisibleMs: number | null;
  fullPageMs: number | null;
  cls: number | null;
  layoutShifts: number | null;
}

const rows: Row[] = [];
for (const variant of VARIANTS) {
  for (const page of PAGES) {
    const result = await runPageBench({
      mode: 'mock',
      extension: variant.extension,
      only: page,
      samples: 1,
      run: `reveal-${variant.label}`,
      tier: 'c8',
      reveal: variant.mode,
      writeHistory: false,
      writeSummary: false,
    });
    for (const record of result.records) {
      rows.push({
        variant: variant.label,
        page: record.page,
        firstVisibleMs: record.metrics.firstVisibleTextMs,
        fullPageMs: record.metrics.fullPageMs,
        cls: record.metrics.cls ?? null,
        layoutShifts: record.metrics.layoutShifts ?? null,
      });
    }
  }
}

const cell = (value: number | null): string =>
  value === null ? '-' : String(Math.round(value * 10000) / 10000);

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
  `${JSON.stringify(rows, null, 2)}\n`,
);
writeFileSync(resolve(ROOT, 'bench/results/reveal-compare.md'), lines.join('\n'));
console.log(lines.join('\n'));
