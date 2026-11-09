import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
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

const TABLE_ERRORS = /(?:^|\n)errors\s+(\d+)/i;
const INLINE_ERRORS = /(?:^|\n)(\d+)\s+errors?(?:\s|$)/im;

/** True when the text includes a web-ext validation summary we can parse. */
export function webExtLintHasSummary(text: string): boolean {
  return TABLE_ERRORS.test(text) || INLINE_ERRORS.test(text);
}

/**
 * Error count from `web-ext lint --output text`.
 * Accepts both `0 errors` and the table form `errors          0`.
 * The word "errors" in a 0-error summary is not a failure.
 */
export function webExtLintErrors(text: string): number {
  const table = TABLE_ERRORS.exec(text);
  if (table?.[1] !== undefined) return Number(table[1]);
  const inline = INLINE_ERRORS.exec(text);
  if (inline?.[1] !== undefined) return Number(inline[1]);
  return 0;
}

/** Fail on a counted error, or on a non-zero exit with no summary (a crash). */
export function webExtLintFailed(text: string, status: number | null): boolean {
  if (webExtLintErrors(text) > 0) return true;
  return status !== 0 && !webExtLintHasSummary(text);
}

/** Absolute path to web-ext's CLI, so Windows does not have to find `pnpm.cmd`. */
export function resolveWebExtCli(fromUrl = import.meta.url): string {
  const require = createRequire(fromUrl);
  return join(dirname(require.resolve('web-ext')), 'bin/web-ext.js');
}

function run(root: string): void {
  const sourceDir = firefoxOutputDirectory(root);
  const result = spawnSync(
    process.execPath,
    [resolveWebExtCli(), 'lint', '--source-dir', sourceDir, '--output', 'text'],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.error) {
    console.error(result.error.message);
    process.exitCode = 1;
    return;
  }
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  process.stdout.write(text);
  if (!webExtLintFailed(text, result.status)) return;
  const errors = webExtLintErrors(text);
  if (errors > 0) {
    console.error(`web-ext lint reported ${String(errors)} error(s)`);
  }
  process.exitCode = 1;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  run(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
