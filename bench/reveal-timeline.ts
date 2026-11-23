/**
 * Per-block timelines for the fixtures whose first paint was late: the long article,
 * the single long paragraph, the model card and the late-mounting SPA. The headline
 * numbers only show the first word; these rows separate a block that never got a
 * request slot, one that decoded late, and one that held its text back for a clause,
 * a paint frame or a reveal offer.
 *
 *   pnpm bench:build:mock
 *   pnpm bench:timeline
 *
 * Writes bench/results/reveal-timeline.{json,md}; no history is appended.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runPageBench } from '../scripts/bench/pages-runner.ts';

const ROOT = resolve(import.meta.dirname, '..');
const PAGES = [
  'long-article',
  'model-card-sidebar',
  'single-long-paragraph',
  'late-mount-spa',
] as const;

async function formatMarkdown(markdown: string): Promise<string> {
  try {
    const prettier = await import('prettier');
    const config = (await prettier.resolveConfig(ROOT)) ?? {};
    return await prettier.format(markdown, { ...config, parser: 'markdown' });
  } catch {
    return markdown;
  }
}

const reports: {
  page: string;
  commit: string;
  dirty: boolean;
  firstVisibleMs: number | null;
  paintMs: number | null;
  rows: Record<string, unknown>[];
}[] = [];
const lines: string[] = [
  '# Reveal first-paint timelines (mock tier c8)',
  '',
  'Sentence reveal on the four first-paint fixtures. Request, token and write',
  'come from the content script clock; dom is the recorder polling the page. Fast',
  'marks a block with an above-fold token fast-path slot, prio its queue priority.',
  'A visible block whose write equals its token painted in the decode turn.',
  '',
];

for (const page of PAGES) {
  const result = await runPageBench({
    mode: 'mock',
    extension: resolve(ROOT, '.output/chrome-mv3'),
    only: page,
    samples: 1,
    run: 'reveal-timeline',
    tier: 'c8',
    reveal: 'sentence',
    captureTrace: true,
    writeHistory: false,
    writeSummary: false,
  });
  const record = result.records[0];
  if (!record?.trace) throw new Error('no per-block trace for ' + page);
  const domById = new Map(record.trace.dom.map((entry) => [entry.id, entry]));
  const rows = [...record.trace.perf]
    .sort((a, b) => a.index - b.index)
    .map((entry) => {
      const dom = domById.get(entry.benchId ?? '');
      return {
        ...entry,
        domFirstChangeMs: dom?.firstChangeMs ?? null,
        domDoneMs: dom?.doneMs ?? null,
      };
    });
  reports.push({
    page,
    commit: result.commit,
    dirty: result.dirty,
    firstVisibleMs: record.metrics.firstVisibleTextMs,
    paintMs: record.metrics.engineWork.paintMs,
    rows,
  });

  const cell = (value: number | null): string => (value === null ? '-' : String(value));
  lines.push(
    '## ' + page,
    '',
    'First visible text: ' +
      String(record.metrics.firstVisibleTextMs) +
      ' ms; first painted word: request ' +
      String(record.metrics.engineWork.requestMs) +
      ' / ttfb ' +
      String(record.metrics.engineWork.ttfbMs) +
      ' / paint ' +
      String(record.metrics.engineWork.paintMs) +
      ' ms.',
    '',
    '| Block | Tag | Kind | Band | Fast | Prio | Request | Token | Write | DOM |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map((row) => {
      const fast = row.fast ? 'yes' : 'no';
      return (
        '| ' +
        (row.benchId ?? row.id) +
        ' | ' +
        row.tag +
        ' | ' +
        row.kind +
        ' | ' +
        row.band +
        ' | ' +
        fast +
        ' | ' +
        row.priority +
        ' | ' +
        cell(row.requestMs) +
        ' | ' +
        cell(row.tokenMs) +
        ' | ' +
        cell(row.writeMs) +
        ' | ' +
        cell(row.domFirstChangeMs) +
        ' |'
      );
    }),
    '',
  );
}

writeFileSync(
  resolve(ROOT, 'bench/results/reveal-timeline.json'),
  JSON.stringify({ reports }, null, 2) + '\n',
);
writeFileSync(
  resolve(ROOT, 'bench/results/reveal-timeline.md'),
  await formatMarkdown(lines.join('\n')),
);
console.log(lines.join('\n'));
