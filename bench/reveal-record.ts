/**
 * Records one clip per reveal mode on a long article and a compact, HN-like page.
 * The clips use the fake engine's synthetic token pace, so the three columns of the
 * composed comparison show the same translation work at a readable speed.
 *
 *   pnpm bench:build:mock
 *   node bench/reveal-record.ts
 */
import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium, type Worker } from '@playwright/test';

import { settings, type ChromeApi } from '../scripts/bench/host.ts';
import { startStaticServer } from '../scripts/bench/static.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'bench/results/videos');
const VIEWPORT = { width: 1280, height: 800 };
/** Roughly the pace of the small on-device model at a human-readable speed. */
const PACE = { ttfbMs: 120, msPerChar: 3.5, deltas: 6 };
const ALL_MODES = [
  { label: 'stream', reveal: 'stream' as const },
  { label: 'smooth', reveal: 'smooth' as const },
  { label: 'sentence', reveal: 'sentence' as const },
];
const ALL_PAGES = [
  { label: 'long-article', file: 'long-article.html' },
  { label: 'hn-like', file: 'many-cards.html' },
  { label: 'single-long-paragraph', file: 'single-long-paragraph.html' },
  { label: 'model-card-sidebar', file: 'model-card-sidebar.html' },
];
/** Env filters let an artifact refresh re-record only the clips that changed. */
const wanted = (value: string | undefined): string[] =>
  value === undefined || value.length === 0 ? [] : value.split(',').map((part) => part.trim());
const modeFilter = wanted(process.env.REVEAL_RECORD_MODES);
const pageFilter = wanted(process.env.REVEAL_RECORD_PAGES);
const MODES = ALL_MODES.filter(
  (mode) => modeFilter.length === 0 || modeFilter.includes(mode.label),
);
const PAGES = ALL_PAGES.filter(
  (page) => pageFilter.length === 0 || pageFilter.includes(page.label),
);

function launchArgs(extension: string): string[] {
  return [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-features=Translate,TranslateUI,DisableLoadExtensionCommandLineSwitch',
  ];
}

async function commandPage(worker: Worker, pageUrl: string): Promise<void> {
  await worker.evaluate(async (url) => {
    const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
    const matched = await chrome.tabs.query({ url });
    const tabId = matched[0]?.id;
    if (tabId === undefined) throw new Error('The fixture tab was not found.');
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['/content-scripts/content.js'],
    });
    await chrome.tabs.sendMessage(tabId, { type: 'page:command', command: 'toggle' });
  }, pageUrl);
}

await mkdir(OUT, { recursive: true });
const server = await startStaticServer({ directory: resolve(ROOT, 'bench/pages') });
const extension = resolve(ROOT, '.output/chrome-mv3');

try {
  for (const mode of MODES) {
    for (const fixture of PAGES) {
      const name = `${fixture.label}-${mode.label}`;
      const profile = resolve(OUT, `.profile-${name}`);
      await mkdir(profile, { recursive: true });
      const context = await chromium.launchPersistentContext(profile, {
        headless: false,
        locale: 'en-US',
        viewport: VIEWPORT,
        args: launchArgs(extension),
        recordVideo: { dir: OUT, size: VIEWPORT },
      });
      try {
        const worker =
          context.serviceWorkers()[0] ??
          (await context.waitForEvent('serviceworker', { timeout: 60_000 }));
        const extensionId = new URL(worker.url()).host;
        const options = await context.newPage();
        await options.goto(`chrome-extension://${extensionId}/options.html`);
        await options.evaluate(
          async (stored) => {
            const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
            await chrome.storage.local.set({ settings: stored, siteRules: {} });
          },
          settings('auto', { reveal: mode.reveal }),
        );
        await options.close();

        const page = await context.newPage();
        await page.goto(`${server.origin}/${fixture.file}`, { waitUntil: 'load' });
        await page.evaluate((pace) => {
          document.documentElement.setAttribute('data-bench-pace', JSON.stringify(pace));
        }, PACE);
        await page.waitForTimeout(400);
        await commandPage(worker, page.url());
        await page
          .waitForFunction(
            () => document.documentElement.dataset.sakuttoState === 'translated',
            null,
            { timeout: 90_000 },
          )
          .catch(() => undefined);
        await page.waitForTimeout(1200);
        const video = page.video();
        await context.close();
        const recorded = await video?.path();
        if (recorded) await rename(recorded, resolve(OUT, `${name}.webm`));
        console.log(`recorded ${name}`);
      } finally {
        await context.close().catch(() => undefined);
      }
    }
  }
} finally {
  await server.close();
}
