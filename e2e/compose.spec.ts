import { expect, test, type Page } from '@playwright/test';
import { loadExtension, type LoadedExtension } from './extension';
import { FIXTURE_ORIGIN, MARKER, commandPage, resetExtensionStorage } from './page';

let extension: LoadedExtension;

async function openComposePage(): Promise<Page> {
  await resetExtensionStorage(extension.worker);
  const page = await extension.context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}/compose.html`);
  return page;
}

async function applyCompose(page: Page): Promise<void> {
  await commandPage(extension.worker, page, 'compose');
  await expect
    .poll(async () => page.locator('sakutto-compose').evaluate((el) => (el as HTMLElement).hidden))
    .toBe(false);
  await page.waitForTimeout(150);
  await page.locator('sakutto-compose').evaluate((el) => {
    el.dispatchEvent(new CustomEvent('sakutto-compose-action', { detail: 'replace' }));
  });
}

test.describe('compose translation', () => {
  test.beforeAll(async () => {
    extension = await loadExtension('en-US');
  });

  test.afterAll(async () => {
    if (!extension) return;
    await extension.close();
  });

  test('replaces a textarea draft only after Replace', async () => {
    const page = await openComposePage();
    try {
      const box = page.locator('#plain');
      await box.fill('明日会いましょう。');
      await box.focus();
      await commandPage(extension.worker, page, 'compose');
      await expect(box).toHaveValue('明日会いましょう。');
      await expect
        .poll(async () =>
          page.locator('sakutto-compose').evaluate((el) => (el as HTMLElement).hidden),
        )
        .toBe(false);
      await page.screenshot({ path: 'e2e-results/compose-preview.png', fullPage: true });
      await page.waitForTimeout(150);
      await page.locator('sakutto-compose').evaluate((el) => {
        el.dispatchEvent(new CustomEvent('sakutto-compose-action', { detail: 'replace' }));
      });
      await expect(box).toHaveValue(`${MARKER}明日会いましょう。`);
      await page.screenshot({ path: 'e2e-results/compose-replaced.png', fullPage: true });
    } finally {
      await page.close();
    }
  });

  test('replaces a plain contenteditable region', async () => {
    const page = await openComposePage();
    try {
      const rich = page.locator('#rich');
      await rich.fill('会議は明日です。');
      await rich.focus();
      await applyCompose(page);
      await expect(rich).toContainText(`${MARKER}会議は明日です。`);
    } finally {
      await page.close();
    }
  });

  test('replaces a Slate-style editor through beforeinput', async () => {
    const page = await openComposePage();
    try {
      await page.evaluate(() => {
        (window as unknown as { __slate: { set(text: string): void } }).__slate.set(
          'よろしくお願いします。',
        );
      });
      await page.locator('#slate').focus();
      await applyCompose(page);
      await expect
        .poll(async () =>
          page.evaluate(() => document.querySelector('#slate')?.getAttribute('data-slate-value')),
        )
        .toBe(`${MARKER}よろしくお願いします。`);
      await page.screenshot({ path: 'e2e-results/compose-slate.png', fullPage: true });
    } finally {
      await page.close();
    }
  });

  test('keeps Gmail signature and quoted history when replacing the body', async () => {
    const page = await openComposePage();
    try {
      await page.locator('#mail').focus();
      await applyCompose(page);
      await expect(page.locator('#mail')).toContainText(`${MARKER}会議は明日です。`);
      await expect(page.locator('.gmail_signature_prefix')).toHaveText('-- ');
      await expect(page.locator('.gmail_signature')).toHaveText('Jane Doe');
      await expect(page.locator('.gmail_quote')).toContainText('On Monday');
    } finally {
      await page.close();
    }
  });

  test('keeps Outlook quoted siblings after the reply header', async () => {
    const page = await openComposePage();
    try {
      await page.locator('#outlook').focus();
      await applyCompose(page);
      await expect(page.locator('#outlook')).toContainText(`${MARKER}会議は明日です。`);
      await expect(page.locator('#appendonsend')).toHaveCount(1);
      await expect(page.locator('#divRplyFwdMsg')).toContainText('From: Alex');
      await expect(page.locator('#quoted')).toHaveText('Quoted original that must survive');
      await expect(page.locator('#Signature')).toHaveText('Sent from Outlook');
    } finally {
      await page.close();
    }
  });

  test('never writes into a password field', async () => {
    const page = await openComposePage();
    try {
      const secret = page.locator('#secret');
      await secret.focus();
      await commandPage(extension.worker, page, 'compose');
      await expect(secret).toHaveValue('hunter2');
      await expect
        .poll(async () =>
          page.locator('sakutto-compose').evaluate((el) => (el as HTMLElement).hidden),
        )
        .toBe(false);
    } finally {
      await page.close();
    }
  });

  test('leaves drafts alone while the page around them is translated', async () => {
    const page = await openComposePage();
    try {
      await page.locator('#plain').fill('This is my unsent draft');
      await commandPage(extension.worker, page, 'toggle');
      await expect(page.locator('h1')).toContainText(MARKER);
      await expect(page.locator('#plain')).toHaveValue('This is my unsent draft');
      await expect(page.locator('sakutto-compose')).toHaveCount(1);
      await expect(page.locator('sakutto-compose')).toBeHidden();
    } finally {
      await page.close();
    }
  });
});
