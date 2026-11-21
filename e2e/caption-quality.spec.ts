import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loadExtension } from './extension';
import {
  FIXTURE_ORIGIN,
  injectContentScript,
  openExtensionShadowRoots,
  resetExtensionStorage,
} from './page';
import {
  computeQualityReport,
  driveScenario,
  installCaptionSampler,
  readSamples,
  stopCaptionSampler,
  type QualityRun,
  type ScenarioStep,
} from './caption-quality-helpers';

/**
 * Deterministic regression harness for real-time YouTube captions. It drives only the
 * local fake player and the fake engine (SAKUTTO_FAKE_ENGINE); no network or real model is
 * involved. ${pnpm caption:quality} builds that extension first.
 */
const JA: QualityRun = {
  language: 'ja',
  target: 'en',
  sentences: [
    { text: '駅は夜明けに開きます。', startMs: 0, endMs: 1800 },
    { text: '赤い列車が2番線で待っています。', startMs: 2200, endMs: 3900 },
    { text: '切符は北側の窓口で売っています。', startMs: 4200, endMs: 6000 },
    { text: '次の列車は午後三時に出ます。', startMs: 6300, endMs: 8000 },
  ],
};

const EN: QualityRun = {
  language: 'en',
  target: 'ja',
  sentences: [
    { text: 'The station opens at dawn.', startMs: 0, endMs: 1800 },
    { text: 'A red train waits on platform two.', startMs: 2200, endMs: 3900 },
    { text: 'Tickets are sold near the north gate.', startMs: 4200, endMs: 6000 },
    { text: 'The next train leaves at three.', startMs: 6300, endMs: 8000 },
  ],
};

/** Exercise each display path in one pass; marks let the analyser attribute frames. */
const STEPS: readonly ScenarioStep[] = [
  { phase: 'normal', dwellMs: 4_700 },
  { phase: 'seek-forward', seekMs: 4_200, dwellMs: 700 },
  { phase: 'seek-back', seekMs: 2_200, dwellMs: 700 },
  { phase: 'pause', pause: true, dwellMs: 500 },
  { phase: 'resume', dwellMs: 2_300 },
  { phase: 'tail', seekMs: 6_100, dwellMs: 900 },
  { phase: 'rate-1.5', seekMs: 0, rate: 1.5, dwellMs: 1_700 },
  { phase: 'rate-2', seekMs: 0, rate: 2, dwellMs: 1_350 },
];

const DECOY = 'INJECTED_UNRELATED_PAGE_COPY_5C1D';
const ARTIFACTS = process.env.CAPTION_QUALITY_ARTIFACTS ?? '';
const VARIANT = process.env.CAPTION_QUALITY_VARIANT ?? 'head';

async function artifactsDir(subdir = ''): Promise<string | null> {
  if (!ARTIFACTS) return null;
  const path = subdir ? join(ARTIFACTS, subdir) : ARTIFACTS;
  await mkdir(path, { recursive: true });
  return path;
}

async function preparePlayer(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (
      globalThis as unknown as {
        __captionQuality?: { videoReady?: Promise<void> };
      }
    ).__captionQuality?.videoReady;
  });
  await page.locator('#player').evaluate(async (element) => {
    const video = element as HTMLVideoElement;
    video.muted = true;
    if (video.readyState < 1) throw new Error('video metadata missing');
    // Start/stop once so the session binds to the playing video like a watch page.
    await video.play().catch(() => undefined);
    video.pause();
    video.currentTime = 0;
  });
}

async function measure(run: QualityRun): Promise<void> {
  const videoDir = await artifactsDir('video');
  const extension = await loadExtension('en-US', {
    ...(videoDir ? { recordVideoDir: videoDir } : {}),
  });
  try {
    await resetExtensionStorage(extension.worker, {
      translateVideoCaptions: true,
      targetLanguage: run.target,
      videoCaptionDisplay: 'replace',
    });
    const page = await extension.context.newPage();
    await page.goto(FIXTURE_ORIGIN + '/youtube-quality.html?lang=' + run.language);
    // Deterministic fake engine: 80ms prefill, no streaming deltas, no per-char decode.
    // The 80ms headroom makes a >250ms show latency meaningful without slowing e2e.
    await page.evaluate(
      ({ decoy }) => {
        document.documentElement.setAttribute(
          'data-bench-pace',
          JSON.stringify({ ttfbMs: 80, msPerChar: 0, deltas: 0 }),
        );
        const banner = document.createElement('p');
        banner.id = 'injected-decoy';
        banner.textContent = decoy;
        document.body.append(banner);
        const fixture = (
          globalThis as unknown as {
            __captionQuality?: { decoy?: string };
          }
        ).__captionQuality;
        if (fixture) fixture.decoy = decoy;
      },
      { decoy: DECOY },
    );
    await preparePlayer(page);
    await openExtensionShadowRoots(extension.worker, page);
    await injectContentScript(extension.worker, page);
    await resetExtensionStorage(extension.worker, {
      translateVideoCaptions: true,
      targetLanguage: run.target,
      videoCaptionDisplay: 'replace',
    });

    const host = page.locator('sakutto-captions');
    await expect(host).toHaveAttribute('data-sakutto-caption', /§(?:en|ja)§/, { timeout: 20_000 });
    await installCaptionSampler(page);
    await driveScenario(page, STEPS);
    const samples = await readSamples(page);
    await stopCaptionSampler(page);
    expect(samples.length).toBeGreaterThan(100);

    const report = computeQualityReport(run, samples, STEPS);
    const metricsDir = await artifactsDir();
    if (metricsDir) {
      await writeFile(
        join(metricsDir, 'metrics-' + VARIANT + '-' + run.language + '.json'),
        JSON.stringify(report, null, 2) + '\n',
      );
      await writeFile(
        join(metricsDir, 'samples-' + VARIANT + '-' + run.language + '.json'),
        JSON.stringify(samples, null, 2),
      );
    }
    // A representative frame: the first full sentence near media time 900ms.
    await page.locator('#player').evaluate((element) => {
      (element as HTMLVideoElement).currentTime = 0.9;
    });
    await page.waitForTimeout(400);
    const screenshotDir = await artifactsDir('screenshots');
    if (screenshotDir) {
      await page.screenshot({
        path: join(screenshotDir, VARIANT + '-' + run.language + '-normal.png'),
      });
    }
    expect(
      report.failures,
      'caption quality metrics for ' +
        run.language +
        ':\n' +
        JSON.stringify(report.metrics, null, 2),
    ).toEqual([]);
  } finally {
    await extension.close();
  }
}

test.describe('caption quality', () => {
  test('Japanese rolling ASR windows stay sentence-level through seek/rate changes', async () => {
    await measure(JA);
  });

  test('English rolling ASR windows stay sentence-level through seek/rate changes', async () => {
    await measure(EN);
  });
});
