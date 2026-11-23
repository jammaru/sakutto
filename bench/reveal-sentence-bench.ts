/**
 * Re-measures only the sentence rows of the mock-tier reveal comparison. The main and
 * smooth builds are unchanged by the viewport fast path, so their rows in
 * bench/results/reveal-compare.{json,md} are kept verbatim when that file exists;
 * the sentence rows are rebuilt from a fresh run against the current
 * .output/chrome-mv3 build. A fresh checkout has no committed baseline, so a
 * missing file starts with empty main/smooth rows and writes only the new rows.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=... node --import ./scripts/bench/register-ts.mjs bench/reveal-sentence-bench.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runPageBench } from '../scripts/bench/pages-runner.ts';

const ROOT = resolve(import.meta.dirname, '..');

/** Keeps the generated report in the format `pnpm format:check` expects. */
async function formatMarkdown(markdown: string): Promise<string> {
  try {
    const prettier = await import('prettier');
    const config = (await prettier.resolveConfig(ROOT)) ?? {};
    return await prettier.format(markdown, { ...config, parser: 'markdown' });
  } catch {
    return markdown;
  }
}
const PAGES = [
  'long-article',
  'first-paragraph-then-long-tail',
  'many-cards',
  'mixed-ui',
  'single-long-paragraph',
  'model-card-sidebar',
  'headline-in-header',
  'late-mount-spa',
] as const;

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

const BASELINE = resolve(ROOT, 'bench/results/reveal-compare.json');
/** A fresh checkout has no generated baseline; start with empty main/smooth rows then. */
const previous: Row[] = existsSync(BASELINE)
  ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as Row[])
  : [];
const rows: Row[] = previous.filter((row) => row.variant !== 'sentence');

/** The mock harness still has a few milliseconds of jitter; each row is a median. */
function median(values: readonly (number | null | undefined)[]): number | null {
  const found = values.filter((value): value is number => value !== null && value !== undefined);
  if (found.length === 0) return null;
  found.sort((a, b) => a - b);
  const middle = Math.floor(found.length / 2);
  return found.length % 2 === 1 ? found[middle]! : (found[middle - 1]! + found[middle]!) / 2;
}

for (const page of PAGES) {
  const result = await runPageBench({
    mode: 'mock',
    extension: resolve(ROOT, '.output/chrome-mv3'),
    only: page,
    samples: 3,
    run: 'reveal-sentence',
    tier: 'c8',
    reveal: 'sentence',
    writeHistory: false,
    writeSummary: false,
  });
  rows.push({
    variant: 'sentence',
    page,
    firstVisibleMs: median(result.records.map((record) => record.metrics.firstVisibleTextMs)),
    fullPageMs: median(result.records.map((record) => record.metrics.fullPageMs)),
    cls: median(result.records.map((record) => record.metrics.cls)),
    layoutShifts: median(result.records.map((record) => record.metrics.layoutShifts)),
    requestMs: median(result.records.map((record) => record.metrics.engineWork.requestMs)),
    ttfbMs: median(result.records.map((record) => record.metrics.engineWork.ttfbMs)),
    paintMs: median(result.records.map((record) => record.metrics.engineWork.paintMs)),
  });
}

const cell = (value: number | null | undefined): string =>
  value === null || value === undefined ? '-' : String(Math.round(value * 10000) / 10000);

const lines = [
  '# Reveal mode comparison (mock tier c8)',
  '',
  '`main` is the pre-reveal streaming build; `smooth` and `sentence` are this branch.',
  'Mock pace: 12 ms prefill, 0.35 ms per character, 3 deltas. Sentence rows are medians of 3 samples; times are milliseconds.',
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

writeFileSync(BASELINE, `${JSON.stringify(rows, null, 2)}\n`);
const report = await formatMarkdown(lines.join('\n'));
writeFileSync(resolve(ROOT, 'bench/results/reveal-compare.md'), report);
console.log(report);
