import { expect, test, type Frame } from '@playwright/test';
import { loadExtension } from './extension';
import { FIXTURE_ORIGIN, MARKER, commandPage, resetExtensionStorage } from './page';
import {
  chooseEmptySharedFolder,
  readSharedFolder,
  reloadFolder,
  setPermissionOverride,
} from './folder-model-helpers';

test('grants a shared folder from the in-page iframe with a dynamic WAR origin', async () => {
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
    await commandPage(extension.worker, page, 'toggle');

    let grantFrame: Frame | undefined;
    await expect
      .poll(
        () => {
          grantFrame = page.frames().find((frame) => frame.url().includes('/folder-enable.html'));
          return Boolean(grantFrame);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    if (!grantFrame) throw new Error('missing in-page folder grant frame');

    await grantFrame.getByRole('button', { name: 'Enable Sakutto' }).click();

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
