import { expect, test, type Page } from '@playwright/test';
import { loadExtension, type LoadedExtension } from './extension';
import { FIXTURE_ORIGIN, MARKER, commandPage, resetExtensionStorage, waitTranslated } from './page';

interface PerfBreakdown {
  requestMs: number | null;
  ttfbMs: number | null;
  paintMs: number | null;
  domWriteMs: number | null;
}

let extension: LoadedExtension;

test.describe('sentence reveal above the fold', () => {
  test.beforeAll(async () => {
    extension = await loadExtension('en-US');
  });

  test('paints decoded tokens before a sentence terminator arrives', async () => {
    await resetExtensionStorage(extension.worker, { translationReveal: 'sentence' });
    const page: Page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      // A slow mock decode with several deltas: the first delta is a prefix with no
      // sentence terminator. Below the fold sentence mode would keep the source until
      // the terminator; above the fold it must write that prefix at once.
      await page.evaluate(() => {
        document.documentElement.setAttribute(
          'data-bench-pace',
          JSON.stringify({ ttfbMs: 30, msPerChar: 14, deltas: 3 }),
        );
        const seen: string[] = [];
        (globalThis as unknown as { __leadSnapshots: string[] }).__leadSnapshots = seen;
        const lead = document.querySelector('#lead');
        if (!lead) throw new Error('missing lead paragraph');
        const record = (): void => {
          const text = lead.textContent ?? '';
          if (seen[seen.length - 1] !== text) seen.push(text);
        };
        new MutationObserver(record).observe(lead, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      });
      await commandPage(extension.worker, page, 'toggle');
      await waitTranslated(page);

      const result = await page.evaluate(() => {
        const raw = document.querySelector('sakutto-perf')?.textContent ?? '{}';
        return {
          snapshots: (globalThis as unknown as { __leadSnapshots: string[] }).__leadSnapshots,
          final: document.querySelector('#lead')?.textContent ?? '',
          perf: JSON.parse(raw) as PerfBreakdown,
        };
      });

      expect(result.final).toContain(MARKER);
      const partial = result.snapshots.find(
        (text) => text.startsWith(MARKER) && text.length > MARKER.length && text !== result.final,
      );
      expect(partial, `snapshots were ${JSON.stringify(result.snapshots)}`).toBeDefined();
      // The page's own hook breaks the first painted word down for the live bench.
      expect(result.perf.requestMs).not.toBeNull();
      expect(result.perf.ttfbMs).not.toBeNull();
      expect(result.perf.paintMs).not.toBeNull();
      // Each stage is rounded independently, so allow a millisecond of drift.
      expect(
        Math.abs(
          result.perf.requestMs! +
            result.perf.ttfbMs! +
            result.perf.paintMs! -
            result.perf.domWriteMs!,
        ),
      ).toBeLessThanOrEqual(2);
    } finally {
      await page.close();
    }
  });

  test.afterAll(async () => {
    if (extension) await extension.close();
  });
});
