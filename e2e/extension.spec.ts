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

  test('renders the popup, options, typed and onboarding pages in English', async () => {
    const extension = await loadExtension('en-US');
    try {
      const pages = ['popup.html', 'options.html', 'onboarding.html', 'typed.html'];

      for (const path of pages) {
        const page = await extension.context.newPage();
        await page.goto(`chrome-extension://${extension.extensionId}/${path}`);
        await expect(page.locator('h1')).toHaveText('Sakutto - Local AI translation');
        if (path === 'onboarding.html') {
          await expect(page.getByRole('checkbox')).toHaveCount(0);
          await expect(
            page.getByRole('button', { name: 'Agree to the license and start' }),
          ).toBeEnabled();
          await expect(page.locator('#start-notice')).toHaveText(
            'Pressing "Agree to the license and start" means you agree to the PLaMo Community License.',
          );
          // The clearer structure: three short parts, then the age line, then the links.
          await expect(page.getByRole('heading', { name: 'PLaMo terms of use' })).toBeVisible();
          await expect(
            page.getByRole('heading', { name: 'Personal and academic use' }),
          ).toBeVisible();
          await expect(
            page.getByRole('heading', { name: 'Work and commercial use' }),
          ).toBeVisible();
          await expect(
            page.getByRole('heading', { name: 'When the conditions are not met' }),
          ).toBeVisible();
          await expect(page.getByText('Other license information')).toBeAttached();
        }
        if (path === 'typed.html') {
          await expect(page.locator('textarea')).toBeVisible();
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
      const pages = ['popup.html', 'options.html', 'onboarding.html', 'typed.html'];

      for (const path of pages) {
        const page = await extension.context.newPage();
        await page.goto(`chrome-extension://${extension.extensionId}/${path}`);
        await expect(page.locator('h1')).toHaveText('Sakutto - ローカルAI翻訳');
        if (path === 'onboarding.html') {
          await expect(page.getByRole('checkbox')).toHaveCount(0);
          await expect(
            page.getByRole('button', { name: 'ライセンスに同意して開始' }),
          ).toBeEnabled();
          await expect(page.locator('#start-notice')).toHaveText(
            '「ライセンスに同意して開始」を押すと、PLaMo Community Licenseに同意したことになります。',
          );
          await expect(page.getByRole('heading', { name: 'PLaMoの利用条件' })).toBeVisible();
          await expect(page.getByRole('heading', { name: '個人・学術目的での利用' })).toBeVisible();
          await expect(page.getByRole('heading', { name: '仕事・商業目的での利用' })).toBeVisible();
          await expect(page.getByRole('heading', { name: '条件を満たさない場合' })).toBeVisible();
          await expect(page.getByText('その他のライセンス情報')).toBeAttached();
          // The age line states the requirement and does not disclaim verification.
          await expect(
            page.getByText(
              '18歳未満など、単独で契約できる年齢に達していない場合は、親権者等の同意が必要です。',
            ),
          ).toBeVisible();
        }
        if (path === 'typed.html') {
          await expect(page.locator('textarea')).toBeVisible();
        }
        await page.close();
      }
    } finally {
      await extension.close();
    }
  });
});
