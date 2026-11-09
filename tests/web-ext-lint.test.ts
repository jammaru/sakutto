import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveWebExtCli, webExtLintErrors } from '../scripts/web-ext-lint.ts';

describe('web-ext lint parser', () => {
  it('treats a clean report as zero errors', () => {
    expect(webExtLintErrors('Validation Summary:\n0 errors\n2 warnings')).toBe(0);
    expect(webExtLintErrors('0 error')).toBe(0);
  });

  it('fails when web-ext reports errors', () => {
    expect(webExtLintErrors('Validation Summary:\n3 errors\n0 warnings')).toBe(3);
  });

  it('invokes web-ext through node rather than pnpm, so Windows can find the CLI', () => {
    const source = readFileSync(new URL('../scripts/web-ext-lint.ts', import.meta.url), 'utf8');
    expect(source).toContain('process.execPath');
    expect(source).not.toMatch(/spawnSync\(\s*'pnpm'/);
    expect(resolveWebExtCli()).toMatch(/web-ext\.js$/);
  });
});
