import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface DurationSample {
  seconds: number;
  conclusion: string;
}

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low] ?? null;
  const weight = rank - low;
  return (sorted[low] ?? 0) * (1 - weight) + (sorted[high] ?? 0) * weight;
}

export function summarizeSeconds(samples: readonly number[]): {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1) ?? null,
  };
}

interface GhRun {
  databaseId: number;
  workflowName: string;
  event: string;
  conclusion: string | null;
  status: string;
  headBranch: string;
  displayTitle: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

function ghJson(args: readonly string[]): unknown {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `gh ${args.join(' ')}`).trim());
  }
  return JSON.parse(result.stdout) as unknown;
}

function durationSeconds(run: GhRun): number {
  return (Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000;
}

function formatSeconds(value: number | null): string {
  if (value === null) return '—';
  if (value < 90) return `${Math.round(value)}s`;
  return `${(value / 60).toFixed(1)}m`;
}

function printTable(title: string, runs: readonly GhRun[]): void {
  const finished = runs.filter(
    (run) =>
      run.status === 'completed' && (run.conclusion === 'success' || run.conclusion === 'failure'),
  );
  const success = finished.filter((run) => run.conclusion === 'success');
  const failure = finished.filter((run) => run.conclusion === 'failure');
  const cancelled = runs.filter((run) => run.conclusion === 'cancelled');
  const stats = summarizeSeconds(finished.map(durationSeconds));
  process.stdout.write(`\n## ${title}\n`);
  process.stdout.write(
    `n=${String(runs.length)} success=${String(success.length)} fail=${String(failure.length)} cancel=${String(cancelled.length)} ` +
      `p50=${formatSeconds(stats.p50)} p95=${formatSeconds(stats.p95)} max=${formatSeconds(stats.max)}\n`,
  );
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(realpathSync(entry)).href;
}

if (isDirectRun()) {
  const repo = process.argv[2] ?? 'jammaru/sakutto';
  const limit = process.argv[3] ?? '200';
  const runs = ghJson([
    'run',
    'list',
    '--repo',
    repo,
    '--limit',
    limit,
    '--json',
    'databaseId,workflowName,event,conclusion,status,headBranch,displayTitle,createdAt,updatedAt,url',
  ]) as GhRun[];

  process.stdout.write(`# CI stats for ${repo} (${String(runs.length)} runs)\n`);
  const names = [...new Set(runs.map((run) => run.workflowName))].sort();
  for (const name of names) {
    printTable(
      name,
      runs.filter((run) => run.workflowName === name),
    );
  }
  printTable(
    'CI pull_request',
    runs.filter((run) => run.workflowName === 'CI' && run.event === 'pull_request'),
  );
  printTable(
    'CI push (including main)',
    runs.filter((run) => run.workflowName === 'CI' && run.event === 'push'),
  );
  printTable(
    'CI main',
    runs.filter((run) => run.workflowName === 'CI' && run.headBranch === 'main'),
  );
}
