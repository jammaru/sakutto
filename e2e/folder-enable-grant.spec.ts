import { expect, test } from '@playwright/test';
import { loadExtension } from './extension';
import { FIXTURE_ORIGIN, MARKER, commandPage, resetExtensionStorage } from './page';
import {
  chooseEmptySharedFolder,
  readSharedFolder,
  reloadFolder,
  setPermissionOverride,
} from './folder-model-helpers';

test('grants a shared folder from a real folder-enable tab with a dynamic WAR origin', async () => {
  test.setTimeout(120_000);
  const extension = await loadExtension('en-US');
  try {
    const urls = await extension.worker.evaluate(() => {
      const chrome = (
        globalThis as unknown as {
          chrome: { runtime: { getURL(path: string): string } };
        }
      ).chrome;
      const root = chrome.runtime.getURL('/');
      const page = chrome.runtime.getURL('/folder-enable.html');
      return {
        root,
        page,
        rootOrigin: new URL(root).origin,
        pageOrigin: new URL(page).origin,
      };
    });
    expect(urls.page).not.toBe(urls.root);
    expect(urls.pageOrigin).not.toBe(urls.rootOrigin);

    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const options = await extension.context.newPage();
    await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
    await chooseEmptySharedFolder(options);
    // Close Settings before making the grant dormant: its restore card auto-settles on the
    // next status change and would turn the prompt override back into a grant.
    await options.close();

    const popup = await extension.context.newPage();
    await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
    await setPermissionOverride(popup, 'prompt');
    await reloadFolder(popup);
    await expect
      .poll(async () => readSharedFolder(popup), { timeout: 15_000 })
      .toMatchObject({ configured: true, permission: 'prompt' });
    await popup.close();

    const page = await extension.context.newPage();
    await page.goto(`${FIXTURE_ORIGIN}/article.html`);
    const grantTabPromise = extension.context.waitForEvent('page');
    await commandPage(extension.worker, page, 'toggle');

    expect(page.frames().some((frame) => frame.url().includes('/folder-enable.html'))).toBe(false);
    const grantTab = await grantTabPromise;
    const grantUrl = `chrome-extension://${extension.extensionId}/folder-enable.html`;
    await grantTab.waitForTimeout(250);
    if (!grantTab.url().startsWith(grantUrl)) {
      // Headless Chromium can surface the SW-created tab as chrome-error; navigate the same
      // tab so the grant still exercises the real top-level page and its user gesture.
      await grantTab.goto(grantUrl);
    }
    await grantTab.waitForURL(/folder-enable\.html/);
    const enable = grantTab.locator('[data-sakutto="folder-enable-grant"]');
    await expect(enable).toBeVisible({ timeout: 15_000 });
    await enable.click();
    await expect.poll(() => grantTab.isClosed()).toBe(true);

    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelector('sakutto-folder-enable')?.hasAttribute('hidden') ?? null,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect(page.locator('#lead')).toContainText(MARKER, { timeout: 15_000 });
    await expect(page.locator('html')).toHaveAttribute('data-sakutto-state', 'translated');
    const verify = await extension.context.newPage();
    await verify.goto(`chrome-extension://${extension.extensionId}/popup.html`);
    await expect
      .poll(async () => readSharedFolder(verify), { timeout: 15_000 })
      .toMatchObject({ permission: 'granted' });
    await verify.close();

    // A duplicated deferred toggle would restore the page instead of leaving it translated.
    await page.waitForTimeout(600);
    await expect(page.locator('#lead')).toContainText(MARKER);
    await expect(page.locator('html')).toHaveAttribute('data-sakutto-state', 'translated');
    await page.close();
  } finally {
    await extension.close();
  }
});
