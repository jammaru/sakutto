import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function firefoxOutputDirectory(root: string): string {
  const output = join(root, '.output');
  const named = join(output, 'firefox-mv3');
  if (existsSync(named)) return named;
  const fallback = readdirSync(output, { withFileTypes: true }).find(
    (entry) => entry.isDirectory() && entry.name.startsWith('firefox'),
  );
  if (!fallback) throw new Error(`no firefox output in ${output}`);
  return join(output, fallback.name);
}

export function webExtLintErrors(text: string): number {
  const match = /(\d+)\s+error/i.exec(text);
  if (!match?.[1]) return /error/i.test(text) ? 1 : 0;
  return Number(match[1]);
}

function run(root: string): void {
  const sourceDir = firefoxOutputDirectory(root);
  const result = spawnSync(
    'pnpm',
    ['exec', 'web-ext', 'lint', '--source-dir', sourceDir, '--output', 'text'],
    { cwd: root, encoding: 'utf8' },
  );
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  process.stdout.write(text);
  const errors = webExtLintErrors(text);
  if (result.status !== 0 && errors === 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
  if (errors > 0) {
    console.error(`web-ext lint reported ${String(errors)} error(s)`);
    process.exitCode = 1;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  run(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
