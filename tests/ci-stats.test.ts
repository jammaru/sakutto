import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { percentile, summarizeSeconds } from '../scripts/ci-stats.ts';

describe('CI duration stats', () => {
  it('interpolates percentiles', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10], 50)).toBe(10);
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(summarizeSeconds([60, 120, 180]).p50).toBe(120);
    expect(summarizeSeconds([]).n).toBe(0);
  });

  it('is documented as a maintainer command, not a CI job', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(workflow).not.toContain('ci-stats');
    const docs = readFileSync(new URL('../docs/CI.md', import.meta.url), 'utf8');
    expect(docs).toContain('node scripts/ci-stats.ts');
  });
});
