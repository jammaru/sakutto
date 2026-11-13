import { expect, test, type Page, type Worker } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadExtension } from './extension';
import {
  FIXTURE_ORIGIN,
  injectContentScript,
  invokeOnCommandPath,
  resetExtensionStorage,
  waitForContentSession,
} from './page';

async function selectLead(page: Page): Promise<void> {
  await page.evaluate(() => {
    const lead = document.getElementById('lead');
    if (!lead) throw new Error('missing #lead');
    const range = document.createRange();
    range.selectNodeContents(lead);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function popoverWidth(page: Page): Promise<number> {
  return page.locator('sakutto-pop').evaluate((host) => host.getBoundingClientRect().width);
}

async function storedWidth(worker: Worker): Promise<number> {
  return worker.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: {
          storage: {
            local: { get(k: string): Promise<Record<string, unknown>> };
          };
        };
      }
    ).chrome;
    const stored = await chrome.storage.local.get('settings');
    const settings = stored.settings as { translationPopupWidth?: number } | undefined;
    return settings?.translationPopupWidth ?? 0;
  });
}

test.describe('translation popup width', () => {
  test('drags the right edge, saves the chosen width, and reuses it', async ({
    browserName,
  }, testInfo) => {
    void browserName;
    const extension = await loadExtension('en-US');
    const artifactDir = join(testInfo.project.outputDir, 'popup-width');
    await mkdir(artifactDir, { recursive: true });
    try {
      await resetExtensionStorage(extension.worker, {
        translationPopupSize: 100,
        translationPopupWidth: 0,
      });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await injectContentScript(extension.worker, page);
      await waitForContentSession(extension.worker, page);

      await selectLead(page);
      await invokeOnCommandPath(extension.worker, page, 'selection');
      await expect.poll(async () => popoverWidth(page)).toBeGreaterThan(80);

      const before = await popoverWidth(page);
      const box = await page.locator('sakutto-pop').boundingBox();
      if (!box) throw new Error('missing selection popover box');
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width - 3, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width + 80, y, { steps: 8 });
      await page.mouse.up();

      await expect.poll(async () => popoverWidth(page)).toBeGreaterThan(before + 20);
      await expect.poll(async () => storedWidth(extension.worker)).toBeGreaterThan(14);
      await page.screenshot({ path: join(artifactDir, 'selection-resized.png') });

      const resized = await popoverWidth(page);
      await page.keyboard.press('Escape');
      await expect
        .poll(async () =>
          page.locator('sakutto-pop').evaluate((host) => (host as HTMLElement).hidden),
        )
        .toBe(true);
      await selectLead(page);
      await invokeOnCommandPath(extension.worker, page, 'selection');
      await expect.poll(async () => popoverWidth(page)).toBeGreaterThan(resized - 2);
      await page.close();
    } finally {
      await extension.close();
    }
  });
});
