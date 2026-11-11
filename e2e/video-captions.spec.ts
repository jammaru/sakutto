import { expect, test, type Page } from '@playwright/test';
import { loadExtension } from './extension';
import {
  FIXTURE_ORIGIN,
  MARKER,
  commandPage,
  injectContentScript,
  resetExtensionStorage,
} from './page';

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
});
