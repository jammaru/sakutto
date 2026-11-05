import { expect, test } from '@playwright/test';
import { loadExtension } from './extension';
import { FIXTURE_ORIGIN, commandPage, resetExtensionStorage, waitTranslated } from './page';

test('translates with the local PLaMo model', async () => {
  test.skip(
    process.env.SAKUTTO_E2E_REAL !== '1',
    'Set SAKUTTO_E2E_REAL=1 after the model is downloaded to run this smoke test.',
  );

  const extension = await loadExtension('en-US');
  try {
    await resetExtensionStorage(extension.worker);
    const page = await extension.context.newPage();
    await page.goto(`${FIXTURE_ORIGIN}/article.html`);
    await commandPage(extension.worker, page, 'toggle');
    await waitTranslated(page);
    await expect(page.locator('#lead')).toHaveAttribute('data-sakutto-engine', 'plamo');
    await expect(page.locator('#lead')).not.toContainText('§en§');
    expect(extension.denied).toEqual([]);
    await page.close();
  } finally {
    await extension.close();
  }
});
