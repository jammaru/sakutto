import { expect, test } from '@playwright/test';
import { loadExtension } from './extension';

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

test.describe('built extension', () => {
  test('starts the extension service worker', async () => {
    const extension = await loadExtension('en-US');
    try {
      expect(extension.extensionId).toMatch(EXTENSION_ID_PATTERN);
    } finally {
      await extension.close();
    }
  });

  test('renders the popup, options and onboarding pages in English', async () => {
    const extension = await loadExtension('en-US');
    try {
      const pages = ['popup.html', 'options.html', 'onboarding.html'];

      for (const path of pages) {
        const page = await extension.context.newPage();
        await page.goto(`chrome-extension://${extension.extensionId}/${path}`);
        await expect(page.locator('h1')).toHaveText('Sakutto for PLaMo');
        await page.close();
      }
    } finally {
      await extension.close();
    }
  });

  test('translates the bundled sample page', async () => {
    const extension = await loadExtension('ja');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/sample.html?to=ja`);
      await expect(page.locator('article h1')).toContainText('§ja§Morning at the station');
      await expect(page.locator('article[data-sample="ja"]')).toHaveCount(0);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('renders the pages in Japanese for a Japanese browser', async () => {
    const extension = await loadExtension('ja');
    try {
      const pages = ['popup.html', 'options.html', 'onboarding.html'];

      for (const path of pages) {
        const page = await extension.context.newPage();
        await page.goto(`chrome-extension://${extension.extensionId}/${path}`);
        await expect(page.locator('h1')).toHaveText('サクッと翻訳 for PLaMo');
        await page.close();
      }
    } finally {
      await extension.close();
    }
  });
});
