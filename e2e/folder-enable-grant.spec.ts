import { expect, test, type Page } from '@playwright/test';
import { loadExtension, type LoadedExtension } from './extension';
import {
  FIXTURE_ORIGIN,
  MARKER,
  dispatchCommand,
  dispatchContextMenu,
  resetExtensionStorage,
} from './page';
import {
  chooseEmptySharedFolder,
  readSharedFolder,
  reloadFolder,
  setPermissionOverride,
} from './folder-model-helpers';

async function makeFolderPermissionPrompt(extension: LoadedExtension): Promise<void> {
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
}

async function expectGrantTabAndResume(
  extension: LoadedExtension,
  page: Page,
  grantTabPromise: Promise<Page>,
): Promise<void> {
  expect(page.frames().some((frame) => frame.url().includes('/folder-enable.html'))).toBe(false);
  const grantTab = await grantTabPromise;
  const grantUrl = `chrome-extension://${extension.extensionId}/folder-enable.html`;
  await grantTab.waitForTimeout(400);
  if (!grantTab.url().startsWith(grantUrl)) {
    // Headless Chromium can surface the SW-created tab as chrome-error; navigate the same
    // tab so the grant still exercises the real top-level page and its user gesture.
    await grantTab.goto(grantUrl);
  }
  await grantTab.waitForURL(/folder-enable\.html/);
  expect(extension.context.pages().filter((item) => item.url().startsWith(grantUrl))).toHaveLength(
    1,
  );
  await expect(grantTab.getByText(/blocked by Chrome/i)).toHaveCount(0);
  await expect(grantTab.getByRole('heading')).toBeVisible({ timeout: 15_000 });
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
}

for (const trigger of [
  {
    name: 'the keyboard command',
    dispatch: (extension: LoadedExtension, page: Page) =>
      dispatchCommand(extension.worker, page, 'translate-page'),
  },
  {
    name: 'the context menu',
    dispatch: (extension: LoadedExtension, page: Page) =>
      dispatchContextMenu(extension.worker, page, 'translate-page'),
  },
]) {
  test(`grants a shared folder from a top-level folder-enable tab via ${trigger.name}`, async () => {
    test.setTimeout(120_000);
    const extension = await loadExtension('en-US');
    try {
      await makeFolderPermissionPrompt(extension);

      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      const grantTabPromise = extension.context.waitForEvent('page');
      // Dispatch the browser event itself, not the content-script page:command shortcut.
      await trigger.dispatch(extension, page);
      await expectGrantTabAndResume(extension, page, grantTabPromise);
      await page.close();
    } finally {
      await extension.close();
    }
  });
}

test('defers a PDF shortcut until the folder grant and resumes the reader', async () => {
  test.setTimeout(120_000);
  const extension = await loadExtension('en-US');
  try {
    await makeFolderPermissionPrompt(extension);

    const page = await extension.context.newPage();
    await page.goto(`${FIXTURE_ORIGIN}/article.html`);
    // Keep the source tab on a .pdf URL without navigating to Chrome's own viewer. The
    // command only needs the tab URL; the resume path fetches the fixture bytes.
    await page.evaluate(() => history.replaceState({}, '', '/sample.pdf'));
    await expect(page).toHaveURL(/sample\.pdf$/);

    const grantTabPromise = extension.context.waitForEvent('page');
    await dispatchCommand(extension.worker, page, 'translate-pdf');

    const grantTab = await grantTabPromise;
    const grantUrl = `chrome-extension://${extension.extensionId}/folder-enable.html`;
    await grantTab.waitForTimeout(400);
    if (!grantTab.url().startsWith(grantUrl)) await grantTab.goto(grantUrl);
    await grantTab.waitForURL(/folder-enable\.html/);
    expect(
      extension.context.pages().filter((item) => item.url().startsWith(grantUrl)),
    ).toHaveLength(1);
    expect(extension.context.pages().some((item) => item.url().includes('/reader.html'))).toBe(
      false,
    );

    const readerTabPromise = extension.context.waitForEvent('page');
    await grantTab.locator('[data-sakutto="folder-enable-grant"]').click();
    const readerTab = await readerTabPromise;
    await readerTab.waitForURL(/reader\.html\?id=/, { timeout: 30_000 });
    await expect.poll(() => grantTab.isClosed()).toBe(true);

    const pending = await extension.worker.evaluate(async () => {
      const chrome = (
        globalThis as unknown as {
          chrome: { storage: { session: { get(key: string): Promise<Record<string, unknown>> } } };
        }
      ).chrome;
      return chrome.storage.session.get('folderGrantPending');
    });
    expect(pending).toEqual({});

    await readerTab.close();
    await page.close();
  } finally {
    await extension.close();
  }
});
