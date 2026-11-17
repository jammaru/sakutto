import { expect, test, type Page } from '@playwright/test';
import { loadExtension } from './extension';
import { FIXTURE_ORIGIN, invokeOnCommandPath, resetExtensionStorage, waitTranslated } from './page';

test('does not leave unchecked lastError across BFCache navigation', async () => {
  test.setTimeout(120_000);
  const extension = await loadExtension('en-US');
  const messages: string[] = [];
  const watch = (page: Page): void => {
    page.on('console', (message) => messages.push(message.text()));
    page.on('pageerror', (error) => messages.push(error.message));
  };
  extension.context.pages().forEach(watch);
  extension.context.on('page', watch);
  extension.worker.on('console', (message) => messages.push(message.text()));

  try {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    watch(page);
    await page.goto(`${FIXTURE_ORIGIN}/article.html`);
    await invokeOnCommandPath(extension.worker, page, 'toggle');
    await waitTranslated(page);

    await page.goto(`${FIXTURE_ORIGIN}/docs.html`);
    await page.waitForLoadState('load');
    await page.goBack();
    await page.waitForLoadState('load');
    await page.goForward();
    await page.waitForLoadState('load');
    await page.goBack();
    await page.waitForLoadState('load');

    const lead = page.locator('#lead');
    if (await lead.count()) {
      await page.evaluate(() => {
        const target = document.getElementById('lead');
        if (!target) return;
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      await invokeOnCommandPath(extension.worker, page, 'selection');
    }
    await page.waitForTimeout(1000);

    expect(messages.filter((message) => message.includes('Unchecked runtime.lastError'))).toEqual(
      [],
    );
    await page.close();
  } finally {
    await extension.close();
  }
});
