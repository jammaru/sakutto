import { expect, test } from '@playwright/test';
import { loadExtension } from './extension';
import {
  FIXTURE_ORIGIN,
  MARKER,
  injectContentScript,
  invokeOnCommandPath,
  readCommandBindings,
  resetExtensionStorage,
  waitForContentSession,
  waitTranslated,
} from './page';

test.describe('translate-page command', () => {
  test('starts translation through the onCommand handler path', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await invokeOnCommandPath(extension.worker, page, 'toggle');
      await waitTranslated(page);
      await expect(page.locator('#lead')).toContainText(MARKER);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('keeps the page translated when Chrome command and in-page Alt+A arrive together', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await injectContentScript(extension.worker, page);
      await waitForContentSession(extension.worker, page);
      await page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            code: 'KeyA',
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await invokeOnCommandPath(extension.worker, page, 'toggle');
      await waitTranslated(page);
      await expect(page.locator('#lead')).toContainText(MARKER);
      await expect
        .poll(async () => page.evaluate(() => document.documentElement.dataset.sakuttoState))
        .toBe('translated');
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('options names the key Chrome actually assigned for translate-page', async () => {
    const extension = await loadExtension('en-US');
    try {
      const bindings = await readCommandBindings(extension.worker);
      const pageCommand = bindings.find((entry) => entry.name === 'translate-page');
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      const kbd = options.locator('kbd').first();
      await expect(kbd).toBeVisible();
      if (pageCommand?.shortcut) {
        await expect(kbd).toHaveText(pageCommand.shortcut);
      } else {
        await expect(options.locator('[class="fallback"]').first()).toBeVisible();
      }
      await options.close();
    } finally {
      await extension.close();
    }
  });
});
