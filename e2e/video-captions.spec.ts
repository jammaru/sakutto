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
