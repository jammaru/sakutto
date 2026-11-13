import { expect, test, type Page } from '@playwright/test';
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

test.describe('translation popup text size', () => {
  test('grows the selection popover when the setting changes', async ({
    browserName,
  }, testInfo) => {
    void browserName;
    const extension = await loadExtension('en-US');
    const artifactDir = join(testInfo.project.outputDir, 'popup-size');
    await mkdir(artifactDir, { recursive: true });
    try {
      await resetExtensionStorage(extension.worker, { translationPopupSize: 100 });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await injectContentScript(extension.worker, page);
      await waitForContentSession(extension.worker, page);

      await selectLead(page);
      await invokeOnCommandPath(extension.worker, page, 'selection');
      await expect.poll(async () => popoverWidth(page)).toBeGreaterThan(80);

      const width100 = await popoverWidth(page);
      await page.screenshot({ path: join(artifactDir, 'selection-100pct.png') });

      await extension.worker.evaluate(async () => {
        const chrome = (
          globalThis as unknown as {
            chrome: {
              storage: {
                local: {
                  get(k: string): Promise<Record<string, unknown>>;
                  set(i: Record<string, unknown>): Promise<void>;
                };
              };
            };
          }
        ).chrome;
        const stored = await chrome.storage.local.get('settings');
        const settings = stored.settings as Record<string, unknown>;
        await chrome.storage.local.set({
          settings: { ...settings, translationPopupSize: 150 },
        });
      });

      await expect
        .poll(async () => {
          return page
            .locator('sakutto-pop')
            .evaluate((host) => host.style.getPropertyValue('--sakutto-popup-scale'));
        })
        .toBe('1.5');

      const width150 = await popoverWidth(page);
      await page.screenshot({ path: join(artifactDir, 'selection-150pct.png') });

      expect(width150).toBeGreaterThan(width100 * 1.12);
      await page.close();
    } finally {
      await extension.close();
    }
  });
});
