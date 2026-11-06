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
        await expect(page.locator('h1')).toHaveText('Sakutto');
        if (path === 'onboarding.html') {
          await expect(page.getByRole('checkbox')).toHaveCount(0);
          await expect(
            page.getByRole('button', { name: 'Agree to the license and start' }),
          ).toBeEnabled();
          await expect(page.locator('#start-notice')).toHaveText(
            "Starting means you agree to the whole PLaMo Community License. You must be 18 or older, or have a parent or guardian's consent (Article 2). This extension does not check your age or ask a guardian to confirm.",
          );
        }
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
        await expect(page.locator('h1')).toHaveText('Sakutto');
        if (path === 'onboarding.html') {
          await expect(page.getByRole('checkbox')).toHaveCount(0);
          await expect(
            page.getByRole('button', { name: 'ライセンスに同意して開始' }),
          ).toBeEnabled();
          await expect(page.locator('#start-notice')).toHaveText(
            '開始すると、PLaMo Community License の全文に同意したものとみなされます。18歳以上であるか、保護者の同意が必要です（第2条）。この拡張機能は、年齢の確認や保護者への確認は行いません。',
          );
        }
        await page.close();
      }
    } finally {
      await extension.close();
    }
  });
});
