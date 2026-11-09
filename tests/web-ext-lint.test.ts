import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  resolveWebExtCli,
  webExtLintErrors,
  webExtLintFailed,
  webExtLintHasSummary,
} from '../scripts/web-ext-lint.ts';

describe('web-ext lint parser', () => {
  it('treats a clean report as zero errors', () => {
    expect(webExtLintErrors('Validation Summary:\n0 errors\n2 warnings')).toBe(0);
    expect(webExtLintErrors('0 error')).toBe(0);
    expect(webExtLintHasSummary('Validation Summary:\n0 errors\n2 warnings')).toBe(true);
  });

  it('reads the table summary web-ext actually prints', () => {
    const text = [
      'Validation Summary:',
      '',
      'errors          0              ',
      '',
      'warnings        3              ',
      '',
      'UNSAFE_VAR_ASSIGNMENT   Unsafe        Due to both security     chunks/mou…   1',
      'UNSAFE_VAR_ASSIGNMENT   Unsafe call   Due to both security     chunks/off…   4',
      'UNSAFE_VAR_ASSIGNMENT   Unsafe        Due to both security     content-sc…   7',
    ].join('\n');
    expect(webExtLintErrors(text)).toBe(0);
    expect(webExtLintHasSummary(text)).toBe(true);
    expect(webExtLintFailed(text, 1)).toBe(false);
  });

  it('fails when web-ext reports errors', () => {
    expect(webExtLintErrors('Validation Summary:\n3 errors\n0 warnings')).toBe(3);
    expect(webExtLintErrors('errors          2\nwarnings        0')).toBe(2);
  });

  it('invokes web-ext through node rather than pnpm, so Windows can find the CLI', () => {
    const source = readFileSync(new URL('../scripts/web-ext-lint.ts', import.meta.url), 'utf8');
    expect(source).toContain('process.execPath');
    expect(source).not.toMatch(/spawnSync\(\s*'pnpm'/);
    expect(resolveWebExtCli()).toMatch(/web-ext\.js$/);
  });
});
