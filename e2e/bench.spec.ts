import { expect, test } from '@playwright/test';

import { BENCH_PAGES } from '../scripts/bench/pages';
import { isBenchRecord } from '../scripts/bench/history';
import { workingTree } from '../scripts/bench/pages-runner';

let tree: { commit: string; dirty: boolean };

test.beforeAll(() => {
  tree = workingTree();
});

test.skip(
  process.env.SAKUTTO_E2E_REAL === '1',
  'The mock bench needs the fake-engine build; run "pnpm bench:live" for real model numbers.',
);

/**
 * The default PR job runs the mock bench, so the fixtures, the unpacked extension and the
 * command path cannot rot. It downloads no model: the fake in-page translator answers
 * instead, and the numbers describe scheduling and harness overhead rather than model
 * speed. Live numbers come from `pnpm bench:live` on a machine that has the model.
 */
test.describe('page bench', () => {
  test.setTimeout(4 * 60 * 1000);

  // A live build has no fake engine, so the mock bench cannot run against it. The live
  // numbers come from `pnpm bench:live`, not from this suite.
  test.skip(
    process.env.SAKUTTO_E2E_REAL === '1',
    'The mock bench needs the fake-engine build; use "pnpm bench:live" for real model numbers.',
  );

  test('measures every fixture in Chromium with the unpacked extension', async () => {
    const { runPageBench } = await import('../scripts/bench/pages-runner');
    const result = await runPageBench({
      mode: 'mock',
      samples: 1,
      writeHistory: false,
      writeSummary: false,
    });

    expect(result.records).toHaveLength(BENCH_PAGES.length);
    expect(new Set(result.records.map((record) => record.page))).toEqual(
      new Set(BENCH_PAGES.map((page) => page.name)),
    );

    for (const record of result.records) {
      expect(isBenchRecord(record), `${record.page} does not match the schema`).toBe(true);
      expect(record.mode).toBe('mock');
      expect(record.engine.label).toBe('mock');
      expect(record.commit).toMatch(/^[0-9a-f]{7,40}$/u);

      // The recorder saw the extension translate the page: a null here means the harness
      // never reached a translation and the numbers would be meaningless.
      expect(record.metrics.firstTextMs, `${record.page} never painted`).not.toBeNull();
      expect(record.metrics.fullPageMs, `${record.page} never finished`).not.toBeNull();
      expect(record.metrics.outputChars).toBeGreaterThan(0);
      expect(record.metrics.commitsPerSecond).not.toBeNull();
      expect(record.metrics.timedOut).toBe(false);
      expect(record.metrics.state, `${record.page} settled in the wrong state`).toBe('translated');
      expect(record.metrics.blocks.finished).toBe(
        record.metrics.blocks.total - record.metrics.blocks.code,
      );
    }

    const article = result.records.find((record) => record.page === 'long-article');
    expect(article?.metrics.blocks.prose).toBeGreaterThanOrEqual(20);

    // The headline fixture must be identifiable and carry the two summary numbers.
    expect(article?.headline).toBe(true);
    expect(result.records.filter((record) => record.headline)).toHaveLength(1);
    expect(article?.engine.accelerator).toBe('mock');
    expect(article?.engine.accelerateLabel).toBe('mock translator');
    const headline = result.headline;
    expect(headline.fixture).toBe('long-article');
    expect(headline.timeToFirstParagraphMs).not.toBeNull();
    expect(headline.fullPageMs).not.toBeNull();

    // The lead-then-tail page must show a real gap: the first paragraph lands well
    // before the page finishes, which is the split the lead-then-tail page exists for.
    const tail = result.records.find((record) => record.page === 'first-paragraph-then-long-tail');
    expect(tail?.metrics.firstVisibleTextMs).not.toBeNull();
    expect(tail?.metrics.fullPageMs).not.toBeNull();
    expect(tail?.metrics.fullPageMs ?? 0).toBeGreaterThan(tail?.metrics.firstVisibleTextMs ?? 0);

    // A page that mounts content after first paint must be captured too, otherwise the
    // late-mount fixture would silently measure only the first screen.
    const spa = result.records.find((record) => record.page === 'late-mount-spa');
    expect(spa?.metrics.lateBlocks).toBeGreaterThan(0);

    expect(result.summary).toContain('Mock mode replaces the model');
    expect(result.summary).toContain('## Headline numbers (long-article)');
  });

  test('stamps records with the build commit', () => {
    expect(tree.commit).toMatch(/^[0-9a-f]{7,40}$/u);
    expect(typeof tree.dirty).toBe('boolean');
  });
});
