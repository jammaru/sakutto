import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loadExtension, type LoadedExtension } from './extension';
import { injectContentScript, resetExtensionStorage } from './page';

const GMAIL_HTML = readFileSync(join(import.meta.dirname, 'fixtures/gmail-message.html'), 'utf8');

async function openGmail(page: Page): Promise<void> {
  await page.route('https://mail.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: GMAIL_HTML }),
  );
  await page.goto('https://mail.google.com/mail/u/0/#inbox');
}

async function dispatchBannerAction(
  page: Page,
  messageId: string,
  detail: 'translate' | 'show-original' | 'show-translation' | 'close',
): Promise<void> {
  await page.locator(`[data-sakutto-gmail-banner="${messageId}"]`).evaluate((element, detail) => {
    element.dispatchEvent(new CustomEvent('sakutto-gmail-action', { detail }));
  }, detail);
}

test.describe('Gmail translate banner', () => {
  let extension: LoadedExtension;

  test.beforeAll(async () => {
    extension = await loadExtension('en-US');
  });

  test.afterAll(async () => {
    if (extension) await extension.close();
  });

  test('shows the banner without the popup or a manual content-script injection', async () => {
    await resetExtensionStorage(extension.worker, {
      targetLanguage: 'ja',
      gmailTranslateBanner: true,
    });
    const page = await extension.context.newPage();
    try {
      await openGmail(page);
      await expect(page.locator('[data-sakutto-gmail-banner="msg-1"]')).toHaveAttribute(
        'data-sakutto-gmail-phase',
        'offer',
      );
    } finally {
      await page.close();
    }
  });

  test('offers translation above an English message and restores the original', async () => {
    await resetExtensionStorage(extension.worker, {
      targetLanguage: 'ja',
      gmailTranslateBanner: true,
    });
    const page = await extension.context.newPage();
    try {
      await openGmail(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        targetLanguage: 'ja',
        gmailTranslateBanner: true,
      });

      const english = page.locator('[data-sakutto-gmail-banner="msg-1"]');
      const japanese = page.locator('[data-sakutto-gmail-banner="msg-2"]');
      const body = page.locator('[data-message-id="msg-1"] .a3s');
      await expect(english).toHaveAttribute('data-sakutto-gmail-phase', 'offer');
      await expect(japanese).toHaveCount(0);
      await expect(page.locator('sakutto-gmail')).toHaveCount(1);

      await page.screenshot({ path: 'e2e-results/gmail-banner.png', fullPage: true });

      await dispatchBannerAction(page, 'msg-1', 'translate');
      await expect(english).toHaveAttribute('data-sakutto-gmail-phase', 'translated');
      await expect(body).toContainText('§ja§');
      await page.screenshot({ path: 'e2e-results/gmail-banner-translated.png', fullPage: true });

      await dispatchBannerAction(page, 'msg-1', 'show-original');
      await expect(english).toHaveAttribute('data-sakutto-gmail-phase', 'original');
      await expect(body).not.toContainText('§ja§');
      await expect(body).toContainText('The release candidate is ready for review.');

      await dispatchBannerAction(page, 'msg-1', 'show-translation');
      await expect(english).toHaveAttribute('data-sakutto-gmail-phase', 'translated');
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
      await openGmail(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        targetLanguage: 'ja',
        gmailTranslateBanner: true,
        gmailAutoTranslateLangs: ['en'],
      });

      const english = page.locator('[data-sakutto-gmail-banner="msg-1"]');
      const body = page.locator('[data-message-id="msg-1"] .a3s');
      await expect(english).toHaveAttribute('data-sakutto-gmail-phase', 'translated');
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
      await openGmail(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        targetLanguage: 'ja',
        gmailTranslateBanner: true,
      });

      const english = page.locator('[data-sakutto-gmail-banner="msg-1"]');
      const body = page.locator('[data-message-id="msg-1"] .a3s');
      await dispatchBannerAction(page, 'msg-1', 'translate');
      await expect(english).toHaveAttribute('data-sakutto-gmail-phase', 'translated');
      await expect(body).toContainText('§ja§');

      await dispatchBannerAction(page, 'msg-1', 'close');
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
      await openGmail(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        targetLanguage: 'ja',
        gmailTranslateBanner: true,
      });

      await expect(page.locator('[data-sakutto-gmail-banner="msg-1"]')).toHaveCount(1);
      await dispatchBannerAction(page, 'msg-1', 'close');
      await expect(page.locator('[data-sakutto-gmail-banner="msg-1"]')).toHaveCount(0);
      await page.waitForTimeout(250);
      await expect(page.locator('[data-sakutto-gmail-banner="msg-1"]')).toHaveCount(0);
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
      await openGmail(page);
      await injectContentScript(extension.worker, page);
      await expect(page.locator('sakutto-gmail')).toHaveCount(0);
    } finally {
      await page.close();
    }
  });
});
