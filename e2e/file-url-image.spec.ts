import { expect, test, type Page } from '@playwright/test';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchExtension, type LoadedExtension } from './extension';
import { resetExtensionStorage } from './page';
import { seedStandardOcrModels } from './ocr-model-helpers';

/**
 * A file:// image menu click cannot be handed to a content script: Chrome refuses to script
 * file URLs even when Allow access to file URLs is on. These tests drive the real built
 * extension, with the chrome://extensions file-access setting set in the profile, and check
 * that the fallback page is visible and can still translate the chosen image.
 */
const IMAGE_FIXTURE = resolve('bench/ocr/fixtures/en-scan.png');
const IMAGE_PATH = join(homedir(), 'sakutto-e2e-en-scan.png');

interface ChromeInWorker {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  extension: { isAllowedFileSchemeAccess(callback: (allowed: boolean) => void): void };
  tabs: {
    get(tabId: number): Promise<unknown>;
    query(query: Record<string, unknown>): Promise<Array<{ id?: number; url?: string }>>;
  };
  contextMenus: { onClicked: unknown };
  runtime: { sendMessage(message: unknown): Promise<unknown> };
}

interface ChromePreferences {
  extensions: { settings: Record<string, { newAllowFileAccess?: boolean }> };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * newAllowFileAccess is the preference the chrome://extensions file-access toggle writes.
 * It is set while the browser is closed so the toggle does not reload the extension (and
 * retire Playwright's service-worker handle) mid-test.
 */
async function launchWithFileAccess(enabled: boolean): Promise<LoadedExtension> {
  const profile = await mkdtemp(join(tmpdir(), 'sakutto-fileurl-'));
  const first = await launchExtension('en-US', profile);
  const extensionId = first.extensionId;
  await first.close();

  const preferencesPath = join(profile, 'Default', 'Preferences');
  const preferences = JSON.parse(await readFile(preferencesPath, 'utf8')) as ChromePreferences;
  const settings = preferences.extensions.settings[extensionId];
  if (!settings) throw new Error('extension preferences were not written to the profile');
  settings.newAllowFileAccess = enabled;
  await writeFile(preferencesPath, JSON.stringify(preferences));

  return launchExtension('en-US', profile, true);
}

function fileSchemeAccess(extension: LoadedExtension): Promise<boolean> {
  return extension.worker.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const chrome = (globalThis as unknown as { chrome: ChromeInWorker }).chrome;
        chrome.extension.isAllowedFileSchemeAccess(resolve);
      }),
  );
}

/** The fake build never needs the real translation model, but OCR still uses real PP-OCR. */
async function prepareExtension(extension: LoadedExtension): Promise<void> {
  await extension.context.unroute('**/*');
  await resetExtensionStorage(extension.worker);
  await extension.worker.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: ChromeInWorker }).chrome;
    const stored = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: {
        ...(stored.settings ?? {}),
        schemaVersion: 1,
        selectedOcrTier: 'standard',
        consent: {
          license: 'plamo-community',
          version: '2026-11-05',
          notice: '2026-11-06',
          acceptedAt: '2026-11-05T00:00:00.000Z',
          ageNoticeShown: true,
        },
      },
    });
  });
  await seedStandardOcrModels(extension);
}

async function dispatchImageMenu(extension: LoadedExtension, imagePage: Page): Promise<void> {
  await imagePage.bringToFront();
  // Without file access Chrome hides file:// URLs from tabs.query, so use the active tab.
  const tabId = await extension.worker.evaluate(async (url) => {
    const chrome = (globalThis as unknown as { chrome: ChromeInWorker }).chrome;
    const tabs = await chrome.tabs.query({});
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs.find((tab) => tab.url === url)?.id ?? active[0]?.id;
  }, imagePage.url());
  if (tabId === undefined) throw new Error('file image tab was not found');
  await extension.worker.evaluate(
    async ({ tabId, srcUrl }) => {
      const chrome = (globalThis as unknown as { chrome: ChromeInWorker }).chrome;
      const tab = await chrome.tabs.get(tabId);
      await (
        chrome.contextMenus.onClicked as unknown as {
          dispatch(info: { menuItemId: string; srcUrl: string }, tab: unknown): Promise<void>;
        }
      ).dispatch({ menuItemId: 'translate-image', srcUrl }, tab);
    },
    { tabId, srcUrl: imagePage.url() },
  );
}

async function openFallback(extension: LoadedExtension, imagePage: Page): Promise<Page> {
  await dispatchImageMenu(extension, imagePage);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const page = extension.context
      .pages()
      .find((candidate) => candidate.url().includes('image-translate.html'));
    if (page) {
      await page.waitForLoadState('domcontentloaded');
      return page;
    }
    await delay(100);
  }
  const pages = extension.context
    .pages()
    .map((page) => page.url())
    .join(', ');
  throw new Error('image fallback page did not open (pages: ' + pages + ')');
}

async function expectGuidance(page: Page): Promise<void> {
  const message = page.locator('[data-sakutto=file-access-message]');
  await expect(message).toBeVisible();
  await expect(message).toContainText('Allow access to file URLs');
  await expect(message).toContainText('ファイルの URL へのアクセスを許可する');
  await expect(page.locator('input[type=file]')).toBeVisible();
}

test.describe('file URL image context menu', () => {
  test.beforeAll(async () => {
    await copyFile(IMAGE_FIXTURE, IMAGE_PATH);
  });

  test.afterAll(async () => {
    await rm(IMAGE_PATH, { force: true });
  });

  test('explains the setting and translates a chosen image with file access granted', async () => {
    test.setTimeout(30_000);
    const extension = await launchWithFileAccess(true);
    try {
      await expect.poll(() => fileSchemeAccess(extension)).toBe(true);
      await prepareExtension(extension);

      const imagePage = await extension.context.newPage();
      await imagePage.goto('file://' + IMAGE_PATH);
      const fallback = await openFallback(extension, imagePage);
      await expectGuidance(fallback);

      await fallback.locator('input[type=file]').setInputFiles(IMAGE_PATH);
      await expect(fallback.locator('[data-sakutto=chosen-file]')).toContainText(
        'sakutto-e2e-en-scan',
      );
      // Real PP-OCR models recognize the scan; the fake engine prefixes every line.
      await expect(fallback.locator('.translation')).toContainText('§en§', { timeout: 15_000 });
      await expect(fallback.locator('.translation')).toContainText('LOCAL TRANSLATION NOTES', {
        timeout: 15_000,
      });
    } finally {
      await extension.close();
    }
  });

  test('shows an explicit message when file access is not granted', async () => {
    test.setTimeout(30_000);
    const extension = await launchWithFileAccess(false);
    try {
      await expect.poll(() => fileSchemeAccess(extension)).toBe(false);
      await prepareExtension(extension);

      const imagePage = await extension.context.newPage();
      await imagePage.goto('file://' + IMAGE_PATH);
      const fallback = await openFallback(extension, imagePage);
      await expectGuidance(fallback);
      await expect(fallback.locator('body')).not.toBeEmpty();
    } finally {
      await extension.close();
    }
  });
});
