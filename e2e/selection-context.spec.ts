import { expect, test, type Page } from '@playwright/test';
import { loadExtension } from './extension';
import {
  FIXTURE_ORIGIN,
  injectContentScript,
  invokeOnCommandPath,
  openExtensionShadowRoots,
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

test('copies the translated selection from the popup', async () => {
  const extension = await loadExtension('en-US');
  try {
    // The popup lives in a closed shadow root that no page-side query can enter, and the
    // roots are created in the extension's isolated world. The roots are opened there
    // before the content script runs, so the copy control and its feedback become
    // addressable. The product build keeps them closed.
    await extension.context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: FIXTURE_ORIGIN,
    });
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    await page.goto(FIXTURE_ORIGIN + '/article.html');
    await openExtensionShadowRoots(extension.worker, page);
    await injectContentScript(extension.worker, page);
    await waitForContentSession(extension.worker, page);

    await selectLead(page);
    await page.waitForTimeout(100);
    await invokeOnCommandPath(extension.worker, page, 'selection');

    // The stub engine streams the translation, so the control must already offer the
    // finished portion instead of waiting for a completion the fake engine never signals.
    const copy = page.locator('sakutto-pop .copy');
    await expect(copy).toBeVisible({ timeout: 15_000 });
    await expect(copy).toBeEnabled({ timeout: 15_000 });
    await expect(copy).toHaveAttribute('aria-label', 'Copy the translation');

    const shown = (await page.locator('sakutto-pop .body').textContent()) ?? '';
    await copy.click();

    // The copied feedback auto-hides after a moment, so the polls stay inside that
    // window instead of using the default timeout, which could outlive it.
    const withinFeedback = { timeout: 2500 };
    await expect
      .poll(async () => page.locator('sakutto-pop .copy-note').textContent(), withinFeedback)
      .toBe('Copied');
    await expect.poll(async () => copy.getAttribute('aria-label'), withinFeedback).toBe('Copied');
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
    await page.close();
  } finally {
    await extension.close();
  }
});
