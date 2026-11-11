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
const X_INLINE_HTML = readFileSync(join(FIXTURE_DIR, 'x-inline.html'));
const X_HLS_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.500
The station opens at dawn.

00:00:02.500 --> 00:00:05.000
A red train waits at platform two.

00:00:05.000 --> 00:00:08.000
Tickets are sold at the north window.
`;

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

async function seekVideo(page: Page, seconds: number): Promise<void> {
  await page.locator('#player').evaluate((element, time) => {
    (element as HTMLVideoElement).currentTime = time;
  }, seconds);
}

async function installCapturingPlayerHandler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const player = document.querySelector('#movie_player');
    if (!player) throw new Error('movie_player missing');
    const state = { count: 0 };
    (globalThis as unknown as { __sakuttoPlayerStolen: { count: number } }).__sakuttoPlayerStolen =
      state;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      player.addEventListener(
        type,
        (event) => {
          state.count += 1;
          event.stopPropagation();
        },
        true,
      );
    }
  });
}

async function playerStolenCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (globalThis as unknown as { __sakuttoPlayerStolen?: { count: number } }).__sakuttoPlayerStolen
        ?.count ?? -1,
  );
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
      await revealCaptionToggle(page);
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-show-original',
        '0',
      );
      await revealCaptionToggle(page);
      await toggle.click();
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-show-original',
        '1',
      );
    } finally {
      await extension.close();
    }
  });

  test('keeps the original hidden after a real click through player chrome and later cues', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/youtube-captions.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const host = page.locator('sakutto-captions');
      await expect(host).toHaveAttribute('data-sakutto-show-original', '1');
      await installCapturingPlayerHandler(page);
      const toggle = page.locator('[data-sakutto="caption-original-toggle"]');
      await revealCaptionToggle(page);
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(host).toHaveAttribute('data-sakutto-show-original', '0');
      await expect.poll(() => playerStolenCount(page)).toBe(0);

      await seekVideo(page, 2.7);
      await expect(host).toHaveAttribute('data-sakutto-original', /赤い列車/);
      await expect(host).toHaveAttribute('data-sakutto-show-original', '0');
      await seekVideo(page, 5.5);
      await expect(host).toHaveAttribute('data-sakutto-original', /切符は北側/);
      await expect(host).toHaveAttribute('data-sakutto-show-original', '0');
      await new Promise((resolve) => setTimeout(resolve, 1600));
      await expect(host).toHaveAttribute('data-sakutto-show-original', '0');
      await expect.poll(() => playerStolenCount(page)).toBe(0);

      await revealCaptionToggle(page);
      await toggle.click();
      await expect(host).toHaveAttribute('data-sakutto-show-original', '1');
      await new Promise((resolve) => setTimeout(resolve, 1600));
      await expect(host).toHaveAttribute('data-sakutto-show-original', '1');
    } finally {
      await extension.close();
    }
  });

  test('a long press on the original-caption pill does not flip twice', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/youtube-captions.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const host = page.locator('sakutto-captions');
      await expect(host).toHaveAttribute('data-sakutto-show-original', '1');
      await installCapturingPlayerHandler(page);
      const toggle = page.locator('[data-sakutto="caption-original-toggle"]');
      await revealCaptionToggle(page);
      await expect(toggle).toBeVisible();
      const box = await toggle.boundingBox();
      if (!box) throw new Error('caption toggle had no box');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await page.mouse.up();
      await expect(host).toHaveAttribute('data-sakutto-show-original', '0');
      await new Promise((resolve) => setTimeout(resolve, 1600));
      await expect(host).toHaveAttribute('data-sakutto-show-original', '0');
      await expect.poll(() => playerStolenCount(page)).toBe(0);
    } finally {
      await extension.close();
    }
  });

  test('lets a press-and-hold drag the caption and reset puts it back', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/youtube-captions.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, { translateVideoCaptions: true });
      const host = page.locator('sakutto-captions');
      await expect(host).toHaveAttribute('data-sakutto-caption', new RegExp(MARKER));
      await expect(host).toHaveCSS('pointer-events', 'none');
      const start = await host.evaluate((element) => ({
        left: (element as HTMLElement).style.left,
        top: (element as HTMLElement).style.top,
        transform: (element as HTMLElement).style.transform,
      }));
      expect(start.left).toBe('50%');
      expect(start.top).toBe('auto');
      expect(start.transform).toBe('translateX(-50%)');

      const box = await host.boundingBox();
      if (!box) throw new Error('caption overlay had no box');
      const fromX = box.x + box.width / 2;
      const fromY = box.y + box.height / 2;
      await page.evaluate(() => {
        const player = document.querySelector('#movie_player');
        const video = document.querySelector('#player') as HTMLVideoElement | null;
        if (!player || !video) throw new Error('player missing');
        let hold: number | null = null;
        player.addEventListener(
          'pointerdown',
          () => {
            hold = window.setTimeout(() => {
              video.playbackRate = 2;
            }, 400);
          },
          true,
        );
        player.addEventListener(
          'pointerup',
          () => {
            if (hold !== null) window.clearTimeout(hold);
          },
          true,
        );
      });
      await page.mouse.move(fromX, fromY);
      await page.mouse.down();
      await new Promise((resolve) => setTimeout(resolve, 550));
      await expect(host).toHaveAttribute('data-sakutto-dragging', '1');
      expect(
        await page
          .locator('#player')
          .evaluate((element) => (element as HTMLVideoElement).playbackRate),
      ).toBe(1);
      await page.mouse.move(fromX, fromY - 90, { steps: 8 });
      await page.mouse.up();
      await expect(host).not.toHaveAttribute('data-sakutto-dragging', '1');
      const moved = await host.evaluate((element) => ({
        left: (element as HTMLElement).style.left,
        top: (element as HTMLElement).style.top,
        transform: (element as HTMLElement).style.transform,
      }));
      expect(moved.transform).toBe('translate(-50%, -50%)');
      expect(moved.top).not.toBe('auto');
      expect(Number.parseFloat(moved.top)).toBeLessThan(50);

      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      const toggle = options.locator('[data-sakutto="video-captions"]');
      await expect(toggle).toBeVisible();
      await expect(toggle).toBeChecked();
      await options.locator('[data-sakutto="video-captions-position-reset"]').click();
      await expect
        .poll(async () => host.evaluate((element) => (element as HTMLElement).style.transform))
        .toBe('translateX(-50%)');
      await expect
        .poll(async () => host.evaluate((element) => (element as HTMLElement).style.left))
        .toBe('50%');
      await expect
        .poll(async () => host.evaluate((element) => (element as HTMLElement).style.top))
        .toBe('auto');
      await options.close();

      const playingBefore = await page.locator('#player').evaluate((element) => {
        const video = element as HTMLVideoElement;
        return !video.paused;
      });
      await page.mouse.move(fromX, fromY);
      await page.mouse.down();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await page.mouse.up();
      await expect(host).not.toHaveAttribute('data-sakutto-dragging', '1');
      await expect
        .poll(async () =>
          page.locator('#player').evaluate((element) => (element as HTMLVideoElement).paused),
        )
        .toBe(playingBefore);
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

  test('keeps native captions visible until the first translated overlay line', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/youtube-en.html`);
      await prepareVideo(page);
      await page.evaluate(() => {
        document.documentElement.setAttribute(
          'data-bench-pace',
          JSON.stringify({ ttfbMs: 800, msPerChar: 0, deltas: 0 }),
        );
      });
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      await expect(page.locator('.ytp-caption-window-container')).toHaveCSS(
        'visibility',
        'visible',
      );
      await expect(page.locator('sakutto-captions[data-sakutto-caption]')).toHaveCount(0);
      await expect(page.locator('.ytp-caption-segment')).toContainText(
        'The station opens at dawn.',
      );
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        /§ja§The station opens at dawn/,
      );
      await expect(page.locator('.ytp-caption-window-container')).toHaveCSS('visibility', 'hidden');
      await expect(page.locator('html')).toHaveAttribute('data-sakutto-captions', 'overlay');
    } finally {
      await extension.close();
    }
  });

  test('translates the playhead cue first on an English YouTube-shaped player', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/youtube-en.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        'The station opens at dawn.',
      );
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        /§ja§The station opens at dawn/,
      );
      await expect(page.locator('sakutto-captions')).not.toHaveAttribute(
        'data-sakutto-original',
        /red train|north window/,
      );
    } finally {
      await extension.close();
    }
  });

  test('leaves native Japanese captions visible when the target is Japanese', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/youtube-captions.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      await expect(page.locator('html')).toHaveAttribute('data-sakutto-captions', 'native');
      await expect(page.locator('sakutto-captions[data-sakutto-caption]')).toHaveCount(0);
      await expect(page.locator('.ytp-caption-window-container')).toHaveCSS(
        'visibility',
        'visible',
      );
      await expect(page.locator('.ytp-caption-segment')).toContainText('駅は夜明けに開きます。');
    } finally {
      await extension.close();
    }
  });

  test('falls back to native English captions when the target switches to English mid-play', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/youtube-en.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        /§ja§/,
      );
      await expect(page.locator('.ytp-caption-window-container')).toHaveCSS('visibility', 'hidden');
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'en',
      });
      await expect(page.locator('html')).toHaveAttribute('data-sakutto-captions', 'native');
      await expect(page.locator('sakutto-captions[data-sakutto-caption]')).toHaveCount(0);
      await expect(page.locator('.ytp-caption-window-container')).toHaveCSS(
        'visibility',
        'visible',
      );
      await expect(page.locator('.ytp-caption-segment')).toContainText(
        'The station opens at dawn.',
      );
    } finally {
      await extension.close();
    }
  });

  test('retranslates mid-play into a new target language and drops the old lines', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/youtube-en.html`);
      await prepareVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        /§ja§/,
      );
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'zh-hans',
      });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        /§zh-hans§/,
      );
      await expect(page.locator('sakutto-captions')).not.toHaveAttribute(
        'data-sakutto-caption',
        /§ja§/,
      );
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
      await expect(
        options.locator('[data-sakutto="video-captions-original-toggle"]'),
      ).toBeVisible();
      await expect(options.locator('[data-sakutto="caption-custom-hosts"]')).toBeVisible();
      await expect(options.locator('.caption-preview-original')).toHaveText(
        'The north window sells tickets.',
      );
      await expect(options.locator('.caption-preview-translation')).toHaveText(
        '北側窓口では切符を売っています。',
      );
      const atDefault = await options
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
        .toBeGreaterThan(atDefault);
      await slider.evaluate((element) => {
        const input = element as HTMLInputElement;
        input.value = '50';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await expect
        .poll(async () =>
          options
            .locator('.caption-preview-translation')
            .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
        )
        .toBeLessThan(atDefault - 4);
      await expect(options.locator('[data-sakutto="video-captions-position-reset"]')).toBeVisible();
      await expect(options.locator('[data-sakutto="video-captions-position-reset"]')).toHaveText(
        'Reset position',
      );
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

  test('translates an inline overflow-hidden X player from an HLS subtitle playlist', async () => {
    const extension = await loadExtension('en-US');
    try {
      await mockXOrigin(extension.context, { inline: true });
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      const page = await extension.context.newPage();
      await page.goto('https://x.com/i/status/inline');
      await preparePlayingXVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        'The station opens at dawn.',
      );
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        /§ja§The station opens at dawn/,
      );
      const inside = await page.evaluate(() => {
        const player = document.querySelector('[data-testid="videoPlayer"]');
        const overlay = document.querySelector('sakutto-captions');
        if (!(player instanceof HTMLElement) || !(overlay instanceof HTMLElement)) return false;
        const playerBox = player.getBoundingClientRect();
        const overlayBox = overlay.getBoundingClientRect();
        return (
          overlayBox.width > 0 &&
          overlayBox.height > 0 &&
          overlayBox.left >= playerBox.left - 2 &&
          overlayBox.right <= playerBox.right + 2 &&
          overlayBox.top >= playerBox.top - 2 &&
          overlayBox.bottom <= playerBox.bottom + 2
        );
      });
      expect(inside).toBe(true);
      await revealCaptionToggle(page);
      const toggleAboveControls = await page.evaluate(() => {
        const toggle = document.querySelector('[data-sakutto="caption-original-toggle"]');
        const controls = document.querySelector('[data-sakutto="x-controls"]');
        if (!(toggle instanceof HTMLElement) || !(controls instanceof HTMLElement)) return false;
        const toggleBox = toggle.getBoundingClientRect();
        const controlsBox = controls.getBoundingClientRect();
        return toggleBox.bottom <= controlsBox.top + 4;
      });
      expect(toggleAboveControls).toBe(true);
    } finally {
      await extension.close();
    }
  });

  test('seeking an inline X video shows native captions until the new playhead cue is ready', async () => {
    const extension = await loadExtension('en-US');
    try {
      await mockXOrigin(extension.context, { inline: true });
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      const page = await extension.context.newPage();
      await page.goto('https://x.com/i/status/inline');
      await preparePlayingXVideo(page);
      await page.evaluate(() => {
        document.documentElement.setAttribute(
          'data-bench-pace',
          JSON.stringify({ ttfbMs: 700, msPerChar: 0, deltas: 0 }),
        );
      });
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        'The station opens at dawn.',
      );
      const afterSeek = await page.evaluate(() => {
        const video = document.querySelector('#playing') as HTMLVideoElement | null;
        const native = document.querySelector('.native-caption');
        if (!video) return { waiting: false, nativeVisible: false, stamped: true };
        video.currentTime = 3;
        video.dispatchEvent(new Event('seeking', { bubbles: true }));
        video.dispatchEvent(new Event('seeked', { bubbles: true }));
        const nativeVisible =
          native instanceof HTMLElement && getComputedStyle(native).visibility !== 'hidden';
        return {
          waiting: document.documentElement.getAttribute('data-sakutto-captions') === 'waiting',
          nativeVisible,
          stamped: Boolean(
            document
              .querySelector('[data-sakutto="x-native-caption"]')
              ?.hasAttribute('data-sakutto-native-caption'),
          ),
        };
      });
      expect(afterSeek.waiting).toBe(true);
      expect(afterSeek.nativeVisible).toBe(true);
      expect(afterSeek.stamped).toBe(false);
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        'A red train waits at platform two.',
      );
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        /§ja§A red train waits at platform two/,
      );
    } finally {
      await extension.close();
    }
  });

  test('starts X captions with target ja already set, without changing language', async () => {
    const extension = await loadExtension('en-US');
    try {
      await mockXOrigin(extension.context, { inline: true, failTwimg: true });
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      const page = await extension.context.newPage();
      await page.goto('https://x.com/i/status/inline');
      await preparePlayingXVideo(page);
      await injectContentScript(extension.worker, page);
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        'The station opens at dawn.',
      );
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        /§ja§The station opens at dawn/,
      );
    } finally {
      await extension.close();
    }
  });

  test('hides the original-toggle until the X player is hovered and never paints empty boxes', async () => {
    const extension = await loadExtension('en-US');
    try {
      await mockXOrigin(extension.context, { inline: true });
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      const page = await extension.context.newPage();
      await page.goto('https://x.com/i/status/inline');
      await preparePlayingXVideo(page);
      await injectContentScript(extension.worker, page);
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      const host = page.locator('sakutto-captions');
      await expect(host).toHaveAttribute('data-sakutto-caption', /§ja§The station opens at dawn/);
      const toggle = page.locator('[data-sakutto="caption-original-toggle"]');
      await page.locator('p').first().hover();
      await expect(toggle).toBeHidden();
      const emptyPaint = await page.evaluate(() => {
        const overlay = document.querySelector('sakutto-captions');
        if (!(overlay instanceof HTMLElement)) return 'missing';
        if (overlay.hidden) {
          const style = getComputedStyle(overlay);
          return style.display === 'none' || style.visibility === 'hidden'
            ? 'hidden'
            : 'visible-while-hidden';
        }
        const caption = overlay.getAttribute('data-sakutto-caption') ?? '';
        return caption.trim().length > 0 ? 'showing' : 'empty-visible';
      });
      expect(emptyPaint).toBe('showing');
      await revealCaptionToggle(page);
      await expect(toggle).toBeVisible();
      await page.locator('p').first().hover();
      await expect(toggle).toBeHidden();
    } finally {
      await extension.close();
    }
  });

  test('translates the native X caption after seek when twimg cues are missing', async () => {
    const extension = await loadExtension('en-US');
    try {
      await mockXOrigin(extension.context, { inline: true, failTwimg: true });
      await resetExtensionStorage(extension.worker, {
        translateVideoCaptions: true,
        targetLanguage: 'ja',
      });
      const page = await extension.context.newPage();
      await page.goto('https://x.com/i/status/inline');
      await preparePlayingXVideo(page);
      await injectContentScript(extension.worker, page);
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        'The station opens at dawn.',
      );
      await page.evaluate(() => {
        const video = document.querySelector('#playing') as HTMLVideoElement | null;
        const native = document.querySelector('.native-caption');
        if (native) native.textContent = 'A red train waits at platform two.';
        if (!video) return;
        video.currentTime = 3;
        video.dispatchEvent(new Event('seeking', { bubbles: true }));
        video.dispatchEvent(new Event('seeked', { bubbles: true }));
      });
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-original',
        'A red train waits at platform two.',
      );
      await expect(page.locator('sakutto-captions')).toHaveAttribute(
        'data-sakutto-caption',
        /§ja§A red train waits at platform two/,
      );
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

async function revealCaptionToggle(page: Page): Promise<void> {
  const player = page.locator('#movie_player, [data-testid="videoPlayer"]').first();
  await player.hover();
}

async function mockXOrigin(
  context: import('@playwright/test').BrowserContext,
  options: { empty?: boolean; inline?: boolean; failTwimg?: boolean } = {},
): Promise<void> {
  const html = options.empty ? X_EMPTY_HTML : options.inline ? X_INLINE_HTML : X_CAPTIONS_HTML;
  await context.route('https://video.twimg.com/**', async (route) => {
    if (options.failTwimg) {
      await route.fulfill({ status: 404, body: 'missing' });
      return;
    }
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
    const url = route.request().url();
    if (url.includes('.m3u8')) {
      const media = /en\.m3u8|\/subs\//iu.test(url);
      const body = media
        ? `#EXTM3U\n#EXTINF:10,\nhttps://video.twimg.com/subtitles/en-hls.vtt\n`
        : `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="https://video.twimg.com/amplify_video/fixture/pl/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,SUBTITLES="subs"
https://video.twimg.com/amplify_video/fixture/pl/video.m3u8
`;
      await route.fulfill({
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/vtt; charset=utf-8',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: url.includes('en-hls.vtt') ? X_HLS_VTT : CAPTIONS_VTT,
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
