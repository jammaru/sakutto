import { expect, test } from '@playwright/test';
import { loadExtension, type LoadedExtension } from './extension';
import { FIXTURE_ORIGIN, commandPage, resetExtensionStorage, waitTranslated } from './page';

let extension: LoadedExtension;

test.describe('X timeline bilingual translation', () => {
  test.beforeAll(async () => {
    extension = await loadExtension('en-US');
  });

  test.afterAll(async () => {
    if (!extension) return;
    try {
      expect(extension.denied).toEqual([]);
    } finally {
      await extension.close();
    }
  });

  test('persists after completion and same-container React re-renders with line breaks', async () => {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'ja' });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html`);
      await page.locator('#show-more').click();
      const reconciliationsBeforeTranslation = await page.evaluate(
        () => (window as unknown as { __xReconciliations: number }).__xReconciliations,
      );

      // Start directly in bilingual mode, as an always-translate X site rule does.
      await commandPage(extension.worker, page, 'bilingual');
      await waitTranslated(page);

      const line = page.locator('#tweet > sakutto-line');
      await expect(line).toContainText(`§ja§The first paragraph`);
      await expect(line.locator('br')).toHaveCount(3);
      await expect(page.locator('#first')).toHaveText(
        'The first paragraph of this expanded post is deliberately long enough to be body copy.',
      );
      await expect(page.locator('#second')).toContainText('The second paragraph');
      await expect(page.locator('#third')).toContainText('The final paragraph');
      expect(
        await page.evaluate(
          () => (window as unknown as { __xReconciliations: number }).__xReconciliations,
        ),
      ).toBe(reconciliationsBeforeTranslation);

      // React can keep tweetText mounted and replace only its children. The cached
      // translation must be repainted onto that new source DOM, not discarded as unchanged.
      await page.locator('#force-rerender').click();
      await expect(line).toContainText(`§ja§The first paragraph`);
      await expect(line.locator('br')).toHaveCount(3);
      await expect(page.locator('#first')).toContainText('The first paragraph');
      await expect(page.locator('#second')).toContainText('The second paragraph');
      await expect(page.locator('#third')).toContainText('The final paragraph');
    } finally {
      await page.close();
    }
  });
});
