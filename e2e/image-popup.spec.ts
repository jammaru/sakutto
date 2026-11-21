import { expect, test, type Page } from '@playwright/test';
import { loadExtension } from './extension';
import {
  FIXTURE_ORIGIN,
  injectContentScript,
  openExtensionShadowRoots,
  resetExtensionStorage,
  tabIdForPage,
  waitForContentSession,
} from './page';

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

async function addImage(page: Page): Promise<string> {
  return page.evaluate((src) => {
    const image = document.createElement('img');
    image.id = 'target-image';
    image.src = src;
    image.alt = 'target';
    image.style.cssText = 'display:block;width:180px;height:90px;margin:40px 0 0 120px';
    document.body.prepend(image);
    return image.src;
  }, PIXEL);
}

async function translateImage(
  worker: import('@playwright/test').Worker,
  page: Page,
  srcUrl: string,
) {
  const tabId = await tabIdForPage(worker, page);
  await worker.evaluate(
    async ({ tabId, srcUrl }) => {
      const chrome = (
        globalThis as unknown as {
          chrome: { tabs: { sendMessage(tabId: number, message: unknown): Promise<unknown> } };
        }
      ).chrome;
      await chrome.tabs.sendMessage(tabId, { type: 'image:translate', srcUrl });
    },
    { tabId, srcUrl },
  );
}

function shadowText(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((name) => {
    const host = document.querySelector('[data-sakutto-image-translation]');
    const node = host?.shadowRoot?.querySelector(name);
    return node?.textContent ?? null;
  }, selector);
}

test('image popup anchors below the image, copies, and persists a resize', async () => {
  const extension = await loadExtension('en-US');
  try {
    await extension.context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: FIXTURE_ORIGIN,
    });
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    await page.goto(FIXTURE_ORIGIN + '/long.html');
    await openExtensionShadowRoots(extension.worker, page);
    await injectContentScript(extension.worker, page);
    await waitForContentSession(extension.worker, page);
    const srcUrl = await addImage(page);
    await translateImage(extension.worker, page, srcUrl);

    const host = page.locator('[data-sakutto-image-translation]');
    await expect(host).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => shadowText(page, '.body')).toContain('LOCAL TRANSLATION NOTES');
    await expect(host.locator('details')).toBeVisible();
    await expect(host.locator('details summary')).toHaveText('Recognized text');

    const imageBox = await page.locator('#target-image').boundingBox();
    const popupBox = await host.boundingBox();
    expect(imageBox).not.toBeNull();
    expect(popupBox).not.toBeNull();
    if (!imageBox || !popupBox) throw new Error('missing boxes');
    expect(popupBox.y).toBeGreaterThanOrEqual(imageBox.y + imageBox.height);
    expect(popupBox.y).toBeLessThan(imageBox.y + imageBox.height + 24);
    expect(Math.abs(popupBox.x - imageBox.x)).toBeLessThan(16);

    // Copy uses the same control and feedback as the selection bubble.
    await host.locator('button.copy').click();
    await expect.poll(() => shadowText(page, '.copy-note')).toBe('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      'LOCAL TRANSLATION NOTES',
    );

    // Drag the right edge; the chosen width lands in settings so it survives a reload.
    const before = (await host.locator('.card').boundingBox())?.width ?? 0;
    await page.evaluate(() => {
      const host = document.querySelector('[data-sakutto-image-translation]');
      const handle = host?.shadowRoot?.querySelector('.resize-handle.right');
      if (!(handle instanceof HTMLElement)) throw new Error('resize handle missing');
      const start = handle.getBoundingClientRect().x + 4;
      const event = (type: string, x: number) =>
        new PointerEvent(type, {
          bubbles: true,
          composed: true,
          button: 0,
          pointerId: 1,
          clientX: x,
        });
      handle.dispatchEvent(event('pointerdown', start));
      document.dispatchEvent(event('pointermove', start + 90));
      document.dispatchEvent(event('pointerup', start + 90));
    });
    const after = (await host.locator('.card').boundingBox())?.width ?? 0;
    expect(after).toBeGreaterThan(before + 20);
    const stored = await extension.worker.evaluate(async () => {
      const chrome = (
        globalThis as unknown as {
          chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
        }
      ).chrome;
      const result = await chrome.storage.local.get('settings');
      return (result.settings as { imagePopupWidth?: number } | undefined)?.imagePopupWidth;
    });
    expect(stored).toBeGreaterThan(0);

    // Scrolling with the target visible keeps the popup next to the image.
    await page.evaluate(() => window.scrollBy(0, 40));
    await expect.poll(async () => (await host.boundingBox())?.y ?? 0).toBeLessThan(popupBox.y);
    await page.close();
  } finally {
    await extension.close();
  }
});

test('image popup handles an image near the bottom edge without leaving the viewport', async () => {
  const extension = await loadExtension('en-US');
  try {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    await page.goto(FIXTURE_ORIGIN + '/long.html');
    await openExtensionShadowRoots(extension.worker, page);
    await injectContentScript(extension.worker, page);
    await waitForContentSession(extension.worker, page);
    const srcUrl = await page.evaluate((src) => {
      const image = document.createElement('img');
      image.src = src;
      image.style.cssText =
        'display:block;width:180px;height:90px;position:fixed;left:40px;bottom:8px';
      document.body.prepend(image);
      return image.src;
    }, PIXEL);
    await translateImage(extension.worker, page, srcUrl);

    const host = page.locator('[data-sakutto-image-translation]');
    await expect(host).toBeVisible({ timeout: 15_000 });
    const box = await host.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    if (!box || !viewport) throw new Error('missing popup or viewport');
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    await page.close();
  } finally {
    await extension.close();
  }
});
