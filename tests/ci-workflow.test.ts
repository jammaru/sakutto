import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeEol } from './support/eol';

const workflowsDir = new URL('../.github/workflows/', import.meta.url);

function workflowSource(name: string): string {
  return normalizeEol(readFileSync(new URL(name, workflowsDir), 'utf8'));
}

function workflowJob(source: string, id: string): string {
  const jobsBlock = source.split(/^jobs:\n/m)[1] ?? '';
  const jobs = jobsBlock.split(/^(?= {2}[a-z][\w-]*:\n)/m);
  return jobs.find((job) => job.startsWith(`  ${id}:\n`)) ?? '';
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

  it('splits static, unit, and sharded e2e behind the checks aggregate', () => {
    const ci = workflowSource('ci.yml');
    const staticJob = workflowJob(ci, 'checks-static');
    expect(staticJob).toContain('pnpm lint');
    expect(staticJob).toContain('pnpm format:check');
    expect(staticJob).toContain('pnpm typecheck');
    expect(staticJob).not.toContain('pnpm test');

    const unitJob = workflowJob(ci, 'checks-unit');
    expect(unitJob).toContain('fetch-depth: 0');
    expect(unitJob).toContain('pnpm test\n');
    expect(unitJob).toContain('pnpm bench:pdf:layout');
    expect(unitJob).toContain('pnpm bench:equality --check');
    expect(unitJob).not.toContain('pnpm test:e2e');

    const e2eJob = workflowJob(ci, 'e2e');
    expect(e2eJob).toContain('shard: [1, 2, 3]');
    expect(e2eJob).toContain('pnpm test:e2e --shard=${{ matrix.shard }}/3');
    expect(e2eJob).toContain(
      "if: ${{ github.event_name != 'pull_request' || needs.changes.outputs.code == 'true' }}",
    );
    expect(e2eJob).toContain('playwright-chromium-');
    expect(e2eJob).toContain('pnpm exec playwright install chromium');
    expect(e2eJob).not.toMatch(/run:.*--with-deps/);
    expect(e2eJob).toContain("PLAYWRIGHT_SKIP_INSTALL: '1'");
    expect(e2eJob).toContain("steps.playwright-cache.outputs.cache-hit != 'true'");

    for (const id of ['checks-static', 'checks-unit', 'e2e']) {
      const job = workflowJob(ci, id);
      expect(job).toContain('pnpm/action-setup@v6');
      expect(job).toContain('cache: pnpm');
      expect(job).toContain('pnpm install --frozen-lockfile');
    }

    const checksJob = workflowJob(ci, 'checks');
    expect(checksJob).toContain('name: checks');
    expect(checksJob).toContain('needs: [changes, checks-static, checks-unit, e2e]');
    expect(checksJob).toContain('if: ${{ always() }}');
    expect(checksJob).toContain("contains(needs.*.result, 'failure')");
    expect(checksJob).toContain("contains(needs.*.result, 'cancelled')");
  });

  it('shards Playwright at the test level so one large spec cannot unbalance e2e', () => {
    const config = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');
    expect(config).toContain('fullyParallel: true');
    expect(config).toMatch(/workers:\s*process\.env\.CI\s*\?\s*2\s*:\s*1/);
  });

  it('documents SLOs, cache busting, and the merge-conflict skip', () => {
    const docs = normalizeEol(readFileSync(new URL('../docs/CI.md', import.meta.url), 'utf8'));
    expect(docs).toContain('PR feedback p50');
    expect(docs).toContain('wllama-v2-');
    expect(docs).toContain('merge conflict');
    expect(docs).toContain('from-source');
    expect(docs).toContain('fetch-depth: 0');
    expect(docs).toContain('Required checks');
  });
});
