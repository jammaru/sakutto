import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflowsDir = new URL('../.github/workflows/', import.meta.url);

function workflowSource(name: string): string {
  return readFileSync(new URL(name, workflowsDir), 'utf8');
}

describe('CI workflow guardrails', () => {
  it('gives every job a timeout', () => {
    for (const name of readdirSync(workflowsDir).filter((file) => file.endsWith('.yml'))) {
      const source = workflowSource(name);
      const jobsBlock = source.split(/^jobs:\n/m)[1];
      expect(jobsBlock, name).toBeDefined();
      const jobs = [...(jobsBlock ?? '').matchAll(/^ {2}[a-z][\w-]*:/gm)];
      expect(jobs.length, name).toBeGreaterThan(0);
      const timeouts = [...source.matchAll(/timeout-minutes:/g)].length;
      expect(timeouts, name).toBeGreaterThanOrEqual(jobs.length);
    }
  });

  it('does not cancel in-progress compiles on main', () => {
    const ci = workflowSource('ci.yml');
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(ci).not.toMatch(/^ {2}cancel-in-progress: true$/mu);
  });

  it('runs pull_request checks on drafts and on ready_for_review', () => {
    const ci = workflowSource('ci.yml');
    expect(ci).toContain('types: [opened, synchronize, reopened, ready_for_review]');
    expect(ci).not.toContain('github.event.pull_request.draft == false');
  });

  it('builds wllama once and packages from that artifact', () => {
    const ci = workflowSource('ci.yml');
    expect(ci).toMatch(/^ {2}wllama:$/m);
    expect(ci).toContain('needs: [changes, wllama]');
    expect(ci).toContain('skip-wllama: true');
    expect(ci).toContain('name: wllama-dist');
    expect(ci).toContain('target: [chrome, firefox]');
  });

  it('keeps quality jobs on every PR', () => {
    const ci = workflowSource('ci.yml');
    expect(ci).toContain('pnpm lint');
    expect(ci).toContain('pnpm format:check');
    expect(ci).toContain('pnpm typecheck');
    expect(ci).toContain('pnpm test');
    expect(ci).toContain('pnpm test:e2e');
    expect(ci).toContain('pnpm bench:equality --check');
    expect(ci).toContain('pnpm bench:pdf:layout');
    expect(ci).toContain('node scripts/wllama/build.ts --check');
    expect(
      ci.replaceAll('pnpm bench:equality --check', '').replaceAll('pnpm bench:pdf:layout', ''),
    ).not.toContain('pnpm bench');
  });

  it('documents SLOs, cache busting, and the merge-conflict skip', () => {
    const docs = readFileSync(new URL('../docs/CI.md', import.meta.url), 'utf8');
    expect(docs).toContain('PR feedback p50');
    expect(docs).toContain('wllama-v2-');
    expect(docs).toContain('merge conflict');
    expect(docs).toContain('from-source');
    expect(docs).toContain('fetch-depth: 0');
    expect(docs).toContain('Required checks');
  });
});
