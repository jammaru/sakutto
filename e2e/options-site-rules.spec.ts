import { expect, test, type Page } from '@playwright/test';
import { loadExtension } from './extension';
import { resetExtensionStorage } from './page';

interface StorageChrome {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
    };
  };
}

async function storedSiteRules(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: StorageChrome }).chrome;
    const value = await chrome.storage.local.get('siteRules');
    return (value.siteRules ?? {}) as Record<string, unknown>;
  });
}

test.describe('options site rules', () => {
  test('adds and removes a per-site rule from the settings page', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await expect(options.getByRole('heading', { name: 'Per-site translation' })).toBeVisible();

      // Nothing to remove before a site is added.
      await expect(options.getByText('No per-site settings yet.')).toBeVisible();

      await options.getByLabel('Host name').fill('news.example');
      await options.getByRole('button', { name: 'Add site' }).click();
      await expect(options.locator('.sites .site-host')).toHaveText('news.example');

      // The row offers removal, and the delete persists to chrome.storage.local.
      await options.getByRole('button', { name: 'news.example Remove' }).click();
      await expect(options.getByText('No per-site settings yet.')).toBeVisible();
      await expect(options.locator('.sites .site-host')).toHaveCount(0);
      expect(await storedSiteRules(options)).toEqual({});

      // Adding the site again starts over from the ask default.
      await options.getByLabel('Host name').fill('news.example');
      await options.getByRole('button', { name: 'Add site' }).click();
      await expect(options.locator('.sites .site-host')).toHaveText('news.example');
      await options.close();
    } finally {
      await extension.close();
    }
  });

  test('removes only the row the reader asked about', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await expect(options.getByRole('heading', { name: 'Per-site translation' })).toBeVisible();

      for (const host of ['docs.example', 'news.example']) {
        await options.getByLabel('Host name').fill(host);
        await options.getByRole('button', { name: 'Add site' }).click();
      }
      await expect(options.locator('.sites .site-host')).toHaveCount(2);

      await options.getByRole('button', { name: 'news.example Remove' }).click();
      await expect(options.locator('.sites .site-host')).toHaveText('docs.example');

      const rules = await storedSiteRules(options);
      expect(Object.keys(rules)).toEqual(['docs.example']);
      await options.close();
    } finally {
      await extension.close();
    }
  });
});
