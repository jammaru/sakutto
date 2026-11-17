import { expect, test, type Page } from '@playwright/test';
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

test('translates a selection after the context-menu timing path', async () => {
  const extension = await loadExtension('en-US');
  try {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    await page.goto(`${FIXTURE_ORIGIN}/article.html`);
    await injectContentScript(extension.worker, page);
    await waitForContentSession(extension.worker, page);

    await selectLead(page);
    // The context menu takes a moment to close. The command must use the selection captured
    // at message receipt, not rely on the highlight still existing after the arm round-trip.
    await page.waitForTimeout(100);
    await invokeOnCommandPath(extension.worker, page, 'selection');

    const popover = page.locator('sakutto-pop');
    await expect(popover).toBeVisible({ timeout: 15_000 });
    await expect(popover).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
    const box = await popover.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(80);
    await page.close();
  } finally {
    await extension.close();
  }
});
