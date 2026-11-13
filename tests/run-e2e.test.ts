import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../scripts/run-e2e.mjs', import.meta.url), 'utf8');

describe('run-e2e spawn', () => {
  it('uses a shell only on Windows so pnpm.cmd does not throw EINVAL', () => {
    expect(source).toContain("const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'");
    expect(source).toContain("shell: process.platform === 'win32'");
  });
});
