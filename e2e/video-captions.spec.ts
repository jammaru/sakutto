import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loadExtension } from './extension';
import {
  FIXTURE_ORIGIN,
  MARKER,
  commandPage,
  injectContentScript,
  resetExtensionStorage,
} from './page';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');
const DUMMY_MP4 = readFileSync(join(FIXTURE_DIR, 'dummy.mp4'));
const CAPTIONS_VTT = readFileSync(join(FIXTURE_DIR, 'captions.vtt'));
const IDLE_VTT = readFileSync(join(FIXTURE_DIR, 'idle-captions.vtt'));
const X_CAPTIONS_HTML = readFileSync(join(FIXTURE_DIR, 'x-captions.html'));
const X_EMPTY_HTML = readFileSync(join(FIXTURE_DIR, 'x-empty.html'));

async function prepareVideo(page: Page): Promise<void> {
  await page.locator('#player').evaluate(async (element) => {
    const video = element as HTMLVideoElement;
    video.muted = true;
    if (video.readyState < 1) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('video metadata')), 5_000);
        video.addEventListener(
          'loadedmetadata',
          () => {
            window.clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        video.load();
      });
    }
    for (const track of video.textTracks) {
      if (track.mode === 'disabled') track.mode = 'hidden';
      if (track.cues && track.cues.length > 0) continue;
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => resolve(), 2_000);
        const done = (): void => {
          window.clearTimeout(timer);
          resolve();
        };
        track.addEventListener('load', done, { once: true });
        video.addEventListener('cuechange', done, { once: true });
      });
    }
    video.currentTime = 0.4;
    await video.play().catch(() => undefined);
  });
}

test.describe('video captions', () => {
  test('translates HTML5 subtitle cues over a dummy video', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/video-captions.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      await commandPage(extension.worker, page, 'toggle');
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        new RegExp(MARKER),
      );
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        /駅は夜明けに開きます|赤い列車|切符は北側/,
      );
    } finally {
      await extension.close();
    }
  });

  test('hides and shows the original caption line from the overlay button', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/youtube-captions.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-show-original',
        '1',
      );
      const toggle = page.locator('[data-sakutto="caption-original-toggle"]');
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-show-original',
        '0',
      );
      await toggle.click();
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-show-original',
        '1',
      );
    } finally {
      await extension.close();
    }
  });

  test('translates a YouTube-style caption track from the player response', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/youtube-captions.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      await commandPage(extension.worker, page, 'toggle');
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        new RegExp(MARKER),
      );
    } finally {
      await extension.close();
    }
  });

  test('does not paint captions when the setting is off', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/video-captions.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await commandPage(extension.worker, page, 'toggle');
      await expect(page.locator('#player')).toBeVisible();
      await expect(page.locator('sakutto-captions')).toHaveCount(0);
    } finally {
      await extension.close();
    }
  });

  test('does not send YouTube auto-translate Japanese as the source line', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      const page = await extension.context.newPage();
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${FIXTURE_ORIGIN}/youtube-mixed.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        'the north window sells tickets that do not require a reservation.',
      );
      await expect(page.locator('sakutto-captions')).not.toHaveAttribute(
        'data-sakutto-original',
        /北側|切符|予約/,
      );
      await expect(page.locator('sakutto-captions')).not.toHaveAttribute(
        'data-sakutto-pending',
        '1',
      );
    } finally {
      await extension.close();
    }
  });

  test('auto-runs on a YouTube-shaped live player without pressing translate', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/youtube-live.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        /駅は夜明けに開きます/,
      );
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        new RegExp(MARKER),
      );
    } finally {
      await extension.close();
    }
  });

  test('translates only the playing X video and skips a silent one', async () => {
    const extension = await loadExtension('en-US');
    try {
      await mockXOrigin(extension.context);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto('https://x.com/i/status/fixture');
      await preparePlayingXVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      await commandPage(extension.worker, page, 'toggle');
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        /駅は夜明けに開きます|赤い列車|切符は北側/,
      );
      await expect(page.locator('sakutto-captions')).not.toHaveAttribute(
        'data-sakutto-original',
        /待機中/,
      );
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        new RegExp(MARKER),
      );
    } finally {
      await extension.close();
    }
  });

  test('starts and stops captions from the popup switch without a reload', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/video-captions.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await expect(page.locator('sakutto-captions')).toHaveCount(0);

      const popup = await extension.context.newPage();
      await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      const toggle = popup.locator('[data-sakutto="video-captions"]');
      await expect(toggle).toBeVisible();
      await expect(toggle).not.toBeChecked();
      await stubPopupCaptionPermission(popup, true);
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        new RegExp(MARKER),
      );

      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await expect(page.locator('sakutto-captions')).toHaveCount(0);
      await popup.close();
    } finally {
      await extension.close();
    }
  });

  test('keeps the caption switch on after a permission prompt closes the popup', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/video-captions.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);

      const popup = await extension.context.newPage();
      await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      const toggle = popup.locator('[data-sakutto="video-captions"]');
      await expect(toggle).toBeVisible();
      await expect(toggle).not.toBeChecked();
      await stubPopupCaptionPermission(popup, false, { hang: true });
      await toggle.click();
      await expect.poll(async () => readCaptionEnableIntent(extension.worker)).toBe(true);
      await popup.close();

      const again = await extension.context.newPage();
      await stubCaptionPermissionBeforeLoad(again, true);
      await again.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(again.locator('[data-sakutto="video-captions"]')).toBeChecked();
      expect(await readTranslateVideoCaptions(extension.worker)).toBe(true);
      await again.close();
    } finally {
      await extension.close();
    }
  });

  test('finishes enabling captions on the settings page after a grant', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      const toggle = options.locator('[data-sakutto="video-captions"]');
      await expect(toggle).toBeVisible();
      await stubPopupCaptionPermission(options, false, { hang: true });
      await toggle.click();
      await expect.poll(async () => readCaptionEnableIntent(extension.worker)).toBe(true);
      await options.close();

      const again = await extension.context.newPage();
      await stubCaptionPermissionBeforeLoad(again, true);
      await again.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await expect(again.locator('[data-sakutto="video-captions"]')).toBeChecked();
      expect(await readTranslateVideoCaptions(extension.worker)).toBe(true);
      await again.close();
    } finally {
      await extension.close();
    }
  });

  test('shows caption size preview and custom site fields on the settings page', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      const toggle = options.locator('[data-sakutto="video-captions"]');
      await expect(toggle).toBeVisible();
      await stubPopupCaptionPermission(options, true);
      await toggle.click();
      await expect(toggle).toBeChecked();
      const slider = options.locator('[data-sakutto="video-captions-size-slider"]');
      await expect(slider).toBeVisible();
      await expect(options.locator('[data-sakutto="video-captions-original"]')).toBeVisible();
      await expect(options.locator('[data-sakutto="caption-custom-hosts"]')).toBeVisible();
      await expect(options.locator('.caption-preview-original')).toHaveText(
        'The north window sells tickets.',
      );
      await expect(options.locator('.caption-preview-translation')).toHaveText(
        '北側窓口では切符を売っています。',
      );
      const before = await options
        .locator('.caption-preview-translation')
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
      await slider.evaluate((element) => {
        const input = element as HTMLInputElement;
        input.value = '150';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await expect
        .poll(async () =>
          options
            .locator('.caption-preview-translation')
            .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
        )
        .toBeGreaterThan(before);
      await options.locator('[data-sakutto="caption-custom-host"]').fill('file://example.com');
      await options.locator('[data-sakutto="caption-custom-host-add"]').click();
      await expect(options.locator('[data-sakutto="caption-custom-host-invalid"]')).toBeVisible();
      await options.close();
    } finally {
      await extension.close();
    }
  });

  test('reverts the settings page switch when host permission is denied', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      const toggle = options.locator('[data-sakutto="video-captions"]');
      await expect(toggle).toBeVisible();
      await stubPopupCaptionPermission(options, false);
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await expect(options.locator('[data-sakutto="video-captions-denied"]')).toHaveText(
        'Access to YouTube and X was not granted.',
      );
      expect(await readTranslateVideoCaptions(extension.worker)).toBe(false);
      await options.close();
    } finally {
      await extension.close();
    }
  });

  test('reverts the popup switch when host permission is denied', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/video-captions.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);

      const popup = await extension.context.newPage();
      await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      const toggle = popup.locator('[data-sakutto="video-captions"]');
      await expect(toggle).toBeVisible();
      await stubPopupCaptionPermission(popup, false);
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await expect(popup.locator('[data-sakutto="video-captions-denied"]')).toHaveText(
        'Access to YouTube and X was not granted.',
      );
      await expect(page.locator('sakutto-captions')).toHaveCount(0);
      const stored = await extension.worker.evaluate(async () => {
        const chrome = (
          globalThis as unknown as {
            chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
          }
        ).chrome;
        const value = await chrome.storage.local.get('settings');
        return value.settings as { translateVideoCaptions?: boolean } | undefined;
      });
      expect(stored?.translateVideoCaptions).not.toBe(true);
      await popup.close();
    } finally {
      await extension.close();
    }
  });

  test('translates an inline X video after play without going fullscreen', async () => {
    const extension = await loadExtension('en-US');
    try {
      await mockXOrigin(extension.context);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto('https://x.com/i/status/fixture');
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      await expect(page.locator('sakutto-captions[data-sakutto-caption]')).toHaveCount(0);
      await preparePlayingXVideo(page);
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        /駅は夜明けに開きます|赤い列車|切符は北側/,
      );
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        new RegExp(MARKER),
      );
    } finally {
      await extension.close();
    }
  });

  test('clears YouTube captions after SPA navigation to a video without captions', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/youtube-spa.html?v=fixtureA0001`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        /駅は夜明けに開きます/,
      );
      await page.evaluate(() => {
        (
          globalThis as unknown as {
            __sakuttoShow: (id: string, timedtext: string | null) => void;
          }
        ).__sakuttoShow('fixtureB0002', null);
      });
      await expect(page.locator('sakutto-captions[data-sakutto-caption]')).toHaveCount(0);
      await expect(page.locator('sakutto-captions[data-sakutto-original]')).toHaveCount(0);
    } finally {
      await extension.close();
    }
  });

  test('does not keep the previous YouTube line after SPA navigation to another captioned video', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/youtube-spa.html?v=fixtureA0001`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        /駅は夜明けに開きます/,
      );
      await page.evaluate(() => {
        (
          globalThis as unknown as {
            __sakuttoShow: (id: string, timedtext: string | null) => void;
          }
        ).__sakuttoShow('fixtureB0002', '/youtube-timedtext-b.json');
      });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        /ホームの時計は正午を指しています/,
      );
      await expect(page.locator('sakutto-captions')).not.toHaveAttribute(
        'data-sakutto-original',
        /駅は夜明けに開きます/,
      );
    } finally {
      await extension.close();
    }
  });

  test('clears X captions when a later video without tracks starts', async () => {
    const extension = await loadExtension('en-US');
    try {
      await mockXOrigin(extension.context);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto('https://x.com/i/status/fixture');
      await preparePlayingXVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        /駅は夜明けに開きます|赤い列車|切符は北側/,
      );
      await page.evaluate(async () => {
        const previous = document.querySelector('#playing') as HTMLVideoElement | null;
        previous?.pause();
        const root = document.querySelector('[data-testid="videoPlayer"]');
        if (!root) return;
        const next = document.createElement('video');
        next.id = 'next';
        next.muted = true;
        next.loop = true;
        next.playsInline = true;
        const source = document.createElement('source');
        source.src = '/dummy.mp4';
        source.type = 'video/mp4';
        next.append(source);
        root.replaceChildren(next);
        next.currentTime = 0.4;
        await next.play().catch(() => undefined);
      });
      await expect(page.locator('sakutto-captions[data-sakutto-caption]')).toHaveCount(0);
    } finally {
      await extension.close();
    }
  });

  test('hides the native X caption while the overlay is shown', async () => {
    const extension = await loadExtension('en-US');
    try {
      await mockXOrigin(extension.context);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto('https://x.com/i/status/fixture');
      await preparePlayingXVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        new RegExp(MARKER),
      );
      const native = page.locator('[data-sakutto="x-native-caption"]');
      await expect(native).toHaveCSS('visibility', 'hidden');
      await expect(page.locator('[data-testid="videoPlayer"] sakutto-captions')).toHaveCount(1);
    } finally {
      await extension.close();
    }
  });

  test('shows nothing on an X video with no captions', async () => {
    const extension = await loadExtension('en-US');
    try {
      await mockXOrigin(extension.context, { empty: true });
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto('https://x.com/i/status/silent');
      await preparePlayingXVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      await page.waitForFunction(() => {
        const video = document.querySelector('#playing') as HTMLVideoElement | null;
        return Boolean(video && !video.paused);
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await expect(page.locator('sakutto-captions[data-sakutto-caption]')).toHaveCount(0);
    } finally {
      await extension.close();
    }
  });
});

async function stubPopupCaptionPermission(
  popup: Page,
  granted: boolean,
  options: { hang?: boolean } = {},
): Promise<void> {
  await popup.evaluate(
    ({ granted, hang }) => {
      const apply = (api: unknown) => {
        if (!api || typeof api !== 'object' || !('permissions' in api)) return;
        const permissions = Reflect.get(api, 'permissions') as
          { contains?: unknown; request?: unknown } | undefined;
        if (!permissions) return;
        permissions.contains = async () => granted;
        permissions.request = hang
          ? () => new Promise<boolean>(() => undefined)
          : async () => granted;
      };
      apply(Reflect.get(globalThis, 'chrome'));
      apply(Reflect.get(globalThis, 'browser'));
    },
    { granted, hang: options.hang === true },
  );
}

async function stubCaptionPermissionBeforeLoad(page: Page, granted: boolean): Promise<void> {
  await page.addInitScript((granted) => {
    const install = () => {
      const apply = (api: unknown) => {
        if (!api || typeof api !== 'object' || !('permissions' in api)) return;
        const permissions = Reflect.get(api, 'permissions') as
          { contains?: unknown; request?: unknown } | undefined;
        if (!permissions) return;
        permissions.contains = async () => granted;
        permissions.request = async () => granted;
      };
      apply(Reflect.get(globalThis, 'chrome'));
      apply(Reflect.get(globalThis, 'browser'));
    };
    install();
    document.addEventListener('DOMContentLoaded', install);
  }, granted);
}

async function readTranslateVideoCaptions(
  worker: import('@playwright/test').Worker,
): Promise<boolean> {
  const stored = await worker.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
      }
    ).chrome;
    const value = await chrome.storage.local.get('settings');
    return value.settings as { translateVideoCaptions?: boolean } | undefined;
  });
  return stored?.translateVideoCaptions === true;
}

async function readCaptionEnableIntent(
  worker: import('@playwright/test').Worker,
): Promise<boolean> {
  const stored = await worker.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
      }
    ).chrome;
    const value = await chrome.storage.local.get('captionEnableIntent');
    return value.captionEnableIntent;
  });
  return stored === true;
}

async function mockXOrigin(
  context: import('@playwright/test').BrowserContext,
  options: { empty?: boolean } = {},
): Promise<void> {
  const html = options.empty ? X_EMPTY_HTML : X_CAPTIONS_HTML;
  await context.route('https://video.twimg.com/**', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
        },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/vtt; charset=utf-8',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: CAPTIONS_VTT,
    });
  });
  await context.route('https://x.com/**', async (route) => {
    const url = route.request().url();
    if (url.includes('idle-captions.vtt')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/vtt; charset=utf-8',
        body: IDLE_VTT,
      });
      return;
    }
    if (url.endsWith('.mp4') || url.includes('dummy.mp4')) {
      await route.fulfill({
        status: 200,
        contentType: 'video/mp4',
        body: DUMMY_MP4,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: html,
    });
  });
}

async function preparePlayingXVideo(page: Page): Promise<void> {
  const playing = page.locator('#playing');
  await playing.waitFor();
  await playing.evaluate(async (element) => {
    const video = element as HTMLVideoElement;
    video.muted = true;
    video.loop = true;
    if (video.readyState < 1) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('video metadata')), 5_000);
        video.addEventListener(
          'loadedmetadata',
          () => {
            window.clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        video.load();
      });
    }
    for (const track of video.textTracks) {
      if (track.mode === 'disabled') track.mode = 'hidden';
      if (track.cues && track.cues.length > 0) continue;
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => resolve(), 2_000);
        const done = (): void => {
          window.clearTimeout(timer);
          resolve();
        };
        track.addEventListener('load', done, { once: true });
        video.addEventListener('cuechange', done, { once: true });
      });
    }
    video.currentTime = 0.4;
    await video.play().catch(() => undefined);
  });
}
