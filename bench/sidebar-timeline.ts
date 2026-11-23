/**
 * Per-block timeline for the model-card sidebar fixture. Unlike the headline numbers,
 * this keeps every job's request order, first token and first DOM write, so a slowdown
 * can be told apart: a block that never got a slot, one that decoded late, and one that
 * held its text back for the clause/budget flush all look different here.
 *
 *   pnpm bench:build:mock
 *   node bench/sidebar-timeline.ts
 *
 * Writes bench/results/sidebar-timeline.{json,md}; no history is appended.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runPageBench } from '../scripts/bench/pages-runner.ts';

const ROOT = resolve(import.meta.dirname, '..');

async function formatMarkdown(markdown: string): Promise<string> {
  try {
    const prettier = await import('prettier');
    const config = (await prettier.resolveConfig(ROOT)) ?? {};
    return await prettier.format(markdown, { ...config, parser: 'markdown' });
  } catch {
    return markdown;
  }
}

const result = await runPageBench({
  mode: 'mock',
  extension: resolve(ROOT, '.output/chrome-mv3'),
  only: 'model-card-sidebar',
  samples: 1,
  run: 'sidebar-timeline',
  tier: 'c8',
  reveal: 'sentence',
  captureTrace: true,
  writeHistory: false,
  writeSummary: false,
});

const record = result.records[0];
if (!record?.trace) throw new Error('the bench did not return a per-block trace');
const perf = new Map(record.trace.perf.map((entry) => [entry.id, entry]));
const domById = new Map(record.trace.dom.map((entry) => [entry.id, entry]));

const rows = [...perf.values()]
  .sort((a, b) => a.index - b.index)
  .map((entry) => {
    const dom = domById.get(entry.benchId ?? '');
    return {
      ...entry,
      domFirstChangeMs: dom?.firstChangeMs ?? null,
      domDoneMs: dom?.doneMs ?? null,
    };
  });
const cell = (value: number | null): string => (value === null ? '-' : String(value));
const lines = [
  '# Model-card sidebar: per-block timeline (mock tier c8)',
  '',
  'Sentence reveal on `bench/pages/model-card-sidebar.html`. `request`, `token` and',
  '`write` come from the content script clock; `dom` is the recorder polling the page.',
  '`fast` marks a block that gets the above-fold token fast path, `prio` its queue priority.',
  '',
  '| Block | Tag | Kind | Band | Fast | Prio | Request | Token | Write | DOM |',
  '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ...rows.map((row) => {
    const fast = row.fast ? 'yes' : 'no';
    return `| ${row.benchId ?? row.id} | ${row.tag} | ${row.kind} | ${row.band} | ${fast} | ${row.priority} | ${cell(row.requestMs)} | ${cell(row.tokenMs)} | ${cell(row.writeMs)} | ${cell(row.domFirstChangeMs)} |`;
  }),
  '',
  `First visible text: ${String(record.metrics.firstVisibleTextMs)} ms; first painted word: request ${String(
    record.metrics.engineWork.requestMs,
  )} / ttfb ${String(record.metrics.engineWork.ttfbMs)} / paint ${String(record.metrics.engineWork.paintMs)} ms.`,
  '',
];

writeFileSync(
  resolve(ROOT, 'bench/results/sidebar-timeline.json'),
  `${JSON.stringify(
    { page: record.page, commit: result.commit, dirty: result.dirty, rows },
    null,
    2,
  )}\n`,
);
writeFileSync(
  resolve(ROOT, 'bench/results/sidebar-timeline.md'),
  await formatMarkdown(lines.join('\n')),
);
console.log(lines.join('\n'));
