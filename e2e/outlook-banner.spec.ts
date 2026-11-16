import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loadExtension, type LoadedExtension } from './extension';
import { injectContentScript, resetExtensionStorage } from './page';

const OUTLOOK_HTML = readFileSync(
  join(import.meta.dirname, 'fixtures/outlook-message.html'),
  'utf8',
);

async function openOutlook(page: Page): Promise<void> {
  await page.route('https://outlook.office.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: OUTLOOK_HTML }),
  );
  await page.goto('https://outlook.office.com/mail/');
}

async function dispatchBannerAction(
  page: Page,
  messageId: string,
  detail: 'translate' | 'show-original' | 'show-translation' | 'close',
): Promise<void> {
  await page.locator(`[data-sakutto-outlook-banner="${messageId}"]`).evaluate((element, detail) => {
    element.dispatchEvent(new CustomEvent('sakutto-outlook-action', { detail }));
  }, detail);
}

test.describe('Outlook translate banner', () => {
  let extension: LoadedExtension;

  test.beforeAll(async () => {
    extension = await loadExtension('en-US');
  });

  test.afterAll(async () => {
    if (extension) await extension.close();
  });

  test('offers translation above an English message and restores the original', async () => {
    await resetExtensionStorage(extension.worker, {
      targetLanguage: 'ja',
      gmailTranslateBanner: true,
    });
    const page = await extension.context.newPage();
    try {
      await openOutlook(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        targetLanguage: 'ja',
        gmailTranslateBanner: true,
      });

      const english = page.locator('[data-sakutto-outlook-banner="conv-1:msg-1"]');
      const japanese = page.locator('[data-sakutto-outlook-banner="conv-2:msg-2"]');
      const body = page.locator('[data-convid="conv-1"] [role="document"]');
      await expect(english).toHaveAttribute('data-sakutto-outlook-phase', 'offer');
      await expect(japanese).toHaveCount(0);
      await expect(page.locator('sakutto-outlook')).toHaveCount(1);

      await page.screenshot({ path: 'e2e-results/outlook-banner.png', fullPage: true });

      await dispatchBannerAction(page, 'conv-1:msg-1', 'translate');
      await expect(english).toHaveAttribute('data-sakutto-outlook-phase', 'translated');
      await expect(body).toContainText('§ja§');
      await page.screenshot({ path: 'e2e-results/outlook-banner-translated.png', fullPage: true });

      await dispatchBannerAction(page, 'conv-1:msg-1', 'show-original');
      await expect(english).toHaveAttribute('data-sakutto-outlook-phase', 'original');
      await expect(body).not.toContainText('§ja§');
      await expect(body).toContainText('The release candidate is ready for review.');

      await dispatchBannerAction(page, 'conv-1:msg-1', 'show-translation');
      await expect(english).toHaveAttribute('data-sakutto-outlook-phase', 'translated');
      await expect(body).toContainText('§ja§');
    } finally {
      await page.close();
    }
  });

  test('auto-translates a remembered source language and never skips it', async () => {
    await resetExtensionStorage(extension.worker, {
      targetLanguage: 'ja',
      gmailTranslateBanner: true,
      gmailAutoTranslateLangs: ['en'],
    });
    const page = await extension.context.newPage();
    try {
      await openOutlook(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        targetLanguage: 'ja',
        gmailTranslateBanner: true,
        gmailAutoTranslateLangs: ['en'],
      });

      const english = page.locator('[data-sakutto-outlook-banner="conv-1:msg-1"]');
      const body = page.locator('[data-convid="conv-1"] [role="document"]');
      await expect(english).toHaveAttribute('data-sakutto-outlook-phase', 'translated');
      await expect(body).toContainText('§ja§');

      await resetExtensionStorage(extension.worker, {
        targetLanguage: 'ja',
        gmailTranslateBanner: true,
        gmailNeverTranslateLangs: ['en'],
      });
      await expect(english).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  test('close restores the original body after translating', async () => {
    await resetExtensionStorage(extension.worker, {
      targetLanguage: 'ja',
      gmailTranslateBanner: true,
    });
    const page = await extension.context.newPage();
    try {
      await openOutlook(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        targetLanguage: 'ja',
        gmailTranslateBanner: true,
      });

      const english = page.locator('[data-sakutto-outlook-banner="conv-1:msg-1"]');
      const body = page.locator('[data-convid="conv-1"] [role="document"]');
      await dispatchBannerAction(page, 'conv-1:msg-1', 'translate');
      await expect(english).toHaveAttribute('data-sakutto-outlook-phase', 'translated');
      await expect(body).toContainText('§ja§');

      await dispatchBannerAction(page, 'conv-1:msg-1', 'close');
      await expect(english).toHaveCount(0);
      await expect(body).not.toContainText('§ja§');
      await expect(body).toContainText('The release candidate is ready for review.');
    } finally {
      await page.close();
    }
  });

  test('close hides the banner for that message only', async () => {
    await resetExtensionStorage(extension.worker, {
      targetLanguage: 'ja',
      gmailTranslateBanner: true,
    });
    const page = await extension.context.newPage();
    try {
      await openOutlook(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        targetLanguage: 'ja',
        gmailTranslateBanner: true,
      });

      await expect(page.locator('[data-sakutto-outlook-banner="conv-1:msg-1"]')).toHaveCount(1);
      await dispatchBannerAction(page, 'conv-1:msg-1', 'close');
      await expect(page.locator('[data-sakutto-outlook-banner="conv-1:msg-1"]')).toHaveCount(0);
      await page.waitForTimeout(250);
      await expect(page.locator('[data-sakutto-outlook-banner="conv-1:msg-1"]')).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  test('the setting turns the banner off', async () => {
    await resetExtensionStorage(extension.worker, {
      targetLanguage: 'ja',
      gmailTranslateBanner: false,
    });
    const page = await extension.context.newPage();
    try {
      await openOutlook(page);
      await injectContentScript(extension.worker, page);
      await expect(page.locator('sakutto-outlook')).toHaveCount(0);
    } finally {
      await page.close();
    }
  });
});
