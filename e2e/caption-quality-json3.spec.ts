import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import rawFixtureImport from './fixtures/youtube-vod-json3-en.json' with { type: 'json' };
import expectedFixtureImport from './fixtures/youtube-vod-json3-en.expected.json' with { type: 'json' };
import { loadExtension } from './extension';
import {
  FIXTURE_ORIGIN,
  injectContentScript,
  openExtensionShadowRoots,
  resetExtensionStorage,
} from './page';
import {
  auditJson3Fixture,
  computeJson3QualityReport,
  computeSchedulerAudit,
  driveJson3Replay,
  installJson3Recorder,
  JSON3_THRESHOLDS,
  linearPercentile,
  makeLongJson3Track,
  normalizeJson3Caption,
  numericLexemes,
  prepareJson3Player,
  readJson3Recording,
  type ExpectedJson3Manifest,
  type Json3QualityReport,
  type Json3Recording,
  type Json3Track,
  type NetworkRequestCounts,
} from './caption-quality-json3-helpers';

const rawFixture = rawFixtureImport as Json3Track;
const manifest = expectedFixtureImport as ExpectedJson3Manifest;
const ARTIFACTS = process.env.CAPTION_QUALITY_ARTIFACTS ?? '';
const VARIANT = process.env.CAPTION_QUALITY_VARIANT ?? 'head';
const JSON3_FIXTURE_ORIGIN = process.env.CAPTION_JSON3_FIXTURE_ORIGIN ?? FIXTURE_ORIGIN;
const DEFAULT_PACE = {
  ttfbMs: 80,
  msPerChar: 2,
  deltas: 0,
  warmupMs: 150,
  concurrent: 1,
} as const;

function jsonWithNonFinite(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_key, entry: unknown) =>
        typeof entry === 'number' && !Number.isFinite(entry) ? String(entry) : entry,
      2,
    ) + '\n'
  );
}

async function artifactDirectory(subdir = ''): Promise<string | null> {
  if (!ARTIFACTS) return null;
  const path = subdir ? join(ARTIFACTS, subdir) : ARTIFACTS;
  await mkdir(path, { recursive: true });
  return path;
}

async function saveReplayArtifacts(
  name: string,
  report: unknown,
  recording: Json3Recording,
): Promise<void> {
  const directory = await artifactDirectory();
  if (!directory) return;
  await writeFile(
    join(directory, 'json3-metrics-' + VARIANT + '-' + name + '.json'),
    jsonWithNonFinite(report),
  );
  await writeFile(
    join(directory, 'json3-trace-' + VARIANT + '-' + name + '.json'),
    jsonWithNonFinite(recording),
  );
}

async function saveFailureFrame(name: string, page: Page): Promise<void> {
  const directory = await artifactDirectory('screenshots');
  if (!directory) return;
  await page.screenshot({ path: join(directory, VARIANT + '-json3-' + name + '.png') });
}

async function openJson3Fixture(
  options: { query?: string; longTrack?: boolean; live?: boolean } = {},
) {
  const extension = await loadExtension('en-US');
  const page = await extension.context.newPage();
  const requests: NetworkRequestCounts = { json3: 0, vtt: 0 };
  const trackPath = options.live
    ? '/youtube-vod-json3-live.json'
    : options.longTrack
      ? '/youtube-vod-json3-long.json'
      : '/youtube-vod-json3-en.json';
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname !== trackPath) return;
    if (url.searchParams.get('fmt') === 'vtt') requests.vtt += 1;
    if (url.searchParams.get('fmt') === 'json3') requests.json3 += 1;
  });
  if (options.longTrack) {
    const longTrack = makeLongJson3Track();
    await page.route('**/youtube-vod-json3-long.json*', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(longTrack) }),
    );
  }
  await resetExtensionStorage(extension.worker, {
    translateVideoCaptions: false,
    targetLanguage: 'ja',
    videoCaptionDisplay: 'replace',
  });
  const query = options.live
    ? '?live=1'
    : options.longTrack
      ? '?track=long'
      : (options.query ?? '');
  await page.goto(JSON3_FIXTURE_ORIGIN + '/youtube-vod-json3.html' + query);
  await page.evaluate((pace) => {
    document.documentElement.setAttribute('data-bench-pace', JSON.stringify(pace));
  }, DEFAULT_PACE);
  await prepareJson3Player(page);
  await openExtensionShadowRoots(extension.worker, page);
  await installJson3Recorder(page);
  const trackLoaded = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return url.pathname === trackPath && url.searchParams.get('fmt') === 'json3' && response.ok();
    },
    { timeout: 20_000 },
  );
  await resetExtensionStorage(extension.worker, {
    translateVideoCaptions: true,
    targetLanguage: 'ja',
    videoCaptionDisplay: 'replace',
  });
  await injectContentScript(extension.worker, page);
  await trackLoaded;
  return { extension, page, requests };
}

function subsetManifest(ids: readonly string[]): ExpectedJson3Manifest {
  return {
    ...manifest,
    scenarioId: manifest.scenarioId + '-interaction',
    minimumCueCount: ids.length,
    cues: manifest.cues.filter((cue) => ids.includes(cue.id)),
  };
}

test('synthetic json3 vectors and independent oracle are non-vacuous', () => {
  const audit = auditJson3Fixture(rawFixture, manifest);
  expect(audit.failures).toEqual([]);
  expect(audit.offsetSegmentCount).toBe(audit.segmentCount);
  expect(audit.repeatedRollingInstanceCount).toBeGreaterThan(20);
  expect(audit.distinctOffsetCount).toBeGreaterThan(10);
  expect(audit.pauseCount).toBeGreaterThanOrEqual(3);
  expect(audit.shortCueCount).toBeGreaterThanOrEqual(3);
  expect(manifest.cues.flatMap((cue) => cue.numericLexemes)).toEqual(['5.5', '5.2', '4.5']);
  expect(numericLexemes('Opus 5.5, Fable 5.2, Opus 4.5.')).toEqual(['5.5', '5.2', '4.5']);
  expect(numericLexemes('Opus 55 Fable 52 Opus 45')).toEqual(['55', '52', '45']);
  expect(numericLexemes('5 .5')).not.toEqual(['5.5']);
  expect(linearPercentile([0, 100, 200, 300, 400], 0.95)).toBe(380);
  expect(linearPercentile([0, 100, Number.POSITIVE_INFINITY], 0.95)).toBe(Number.POSITIVE_INFINITY);
  expect(makeLongJson3Track().events).toHaveLength(96);
});

test('continuous VOD replay gates cue lag, dwell, content, numbers, and request bounds', async () => {
  test.setTimeout(60_000);
  const { extension, page, requests } = await openJson3Fixture();
  try {
    await driveJson3Replay(page, [
      { phase: 'normal', play: true, untilMediaMs: 22_000, dwellMs: 1_400 },
    ]);
    const recording = await readJson3Recording(page);
    const fixtureBytes = await readFile(
      new URL('./fixtures/youtube-vod-json3-en.json', import.meta.url),
    );
    const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
    const report = computeJson3QualityReport(manifest, recording, requests, {
      fixtureSha256,
    });
    await saveReplayArtifacts('continuous', report, recording);
    console.log(
      'json3 continuous metrics',
      JSON.stringify({
        median: report.lag.medianMs,
        p95: report.lag.p95Ms,
        shortestDwell: report.dwell.shortestMs,
        requests: report.requests,
        scheduler: report.scheduler,
        failures: report.failures,
      }),
    );
    if (report.failures.length > 0) await saveFailureFrame('continuous', page);
    expect(report.sampleCount).toBeGreaterThan(350);
    expect(report.failures, jsonWithNonFinite(report)).toEqual([]);
  } finally {
    await extension.close();
  }
});

test('seek, rewind, pause, and rate changes reconcile without refetching', async () => {
  test.setTimeout(60_000);
  const { extension, page, requests } = await openJson3Fixture();
  try {
    await driveJson3Replay(page, [
      { phase: 'warm', seekMs: 0, play: true, untilMediaMs: 6_500 },
      { phase: 'seek-forward', seekMs: 11_000, play: true, dwellMs: 4_000 },
      { phase: 'seek-back', seekMs: 0, play: true, dwellMs: 4_000 },
      { phase: 'pause', pause: true, dwellMs: 500 },
      { phase: 'resume', play: true, dwellMs: 500 },
      { phase: 'rate-2', seekMs: 7_000, rate: 2, play: true, dwellMs: 5_000 },
      { phase: 'rate-1', seekMs: 20_500, rate: 1, play: true, dwellMs: 3_200 },
    ]);
    const recording = await readJson3Recording(page);
    const reports: Json3QualityReport[] = [
      computeJson3QualityReport(subsetManifest(['complete']), recording, requests, {
        phase: 'seek-forward',
        allowUnexpected: true,
      }),
      computeJson3QualityReport(subsetManifest(['intro']), recording, requests, {
        phase: 'seek-back',
        allowUnexpected: true,
      }),
      computeJson3QualityReport(subsetManifest(['final']), recording, requests, {
        phase: 'rate-1',
      }),
    ];
    const interactionFailures = reports.flatMap((report) => report.failures);
    const destinationStarts = recording.requests.filter(
      (request) =>
        request.phase === 'seek-forward' &&
        request.action === 'start' &&
        normalizeJson3Caption(request.sourceText) === 'The decoded answer stays complete.',
    );
    const destinationCacheHits = recording.requests.filter(
      (request) =>
        request.phase === 'seek-forward' &&
        request.action === 'cache-hit' &&
        normalizeJson3Caption(request.sourceText) === 'The decoded answer stays complete.',
    );
    if (destinationStarts.length === 0 && destinationCacheHits.length === 0)
      interactionFailures.push('seek destination was not requested or reused');
    if (destinationStarts[0] && destinationStarts[0].priority > 2) {
      interactionFailures.push('seek destination was not promoted');
    }
    const rewindHits = recording.requests.filter(
      (request) =>
        request.phase === 'seek-back' &&
        request.action === 'cache-hit' &&
        normalizeJson3Caption(request.sourceText) === 'Welcome to the model review.',
    );
    if (rewindHits.length === 0)
      interactionFailures.push('rewind did not reuse cached translation');
    const seekGenerations = recording.requests
      .filter((request) => request.phase === 'seek-forward')
      .map((request) => request.generation);
    const rateGenerations = recording.requests
      .filter((request) => request.phase === 'rate-2')
      .map((request) => request.generation);
    if (
      seekGenerations.length === 0 ||
      rateGenerations.length === 0 ||
      Math.max(...rateGenerations) <= Math.max(...seekGenerations)
    ) {
      interactionFailures.push('rate change did not advance scheduling generation');
    }
    const pauseSamples = recording.samples.filter((sample) => sample.phase === 'pause');
    if (pauseSamples.length > 1) {
      const first = pauseSamples[0];
      const last = pauseSamples.at(-1);
      if (first && last && Math.abs(last.mediaMs - first.mediaMs) > 100) {
        interactionFailures.push('playhead advanced while paused');
      }
    }
    if (
      recording.transitions.some(
        (transition) => transition.phase === 'pause' && transition.caption.length === 0,
      )
    ) {
      interactionFailures.push('pause cleared the active caption');
    }
    const denseRateReport = computeJson3QualityReport(
      subsetManifest(['short-fable', 'short-opus', 'short-ready', 'complete']),
      recording,
      requests,
      { phase: 'rate-2', allowUnexpected: true },
    );
    const artifact = { reports, denseRateReport, interactionFailures };
    await saveReplayArtifacts('interactions', artifact, recording);
    console.log('json3 interaction failures', interactionFailures);
    console.log('json3 dense 2x owner trade-off', denseRateReport.failures);
    if (interactionFailures.length > 0) await saveFailureFrame('interactions', page);
    expect(interactionFailures, jsonWithNonFinite(artifact)).toEqual([]);
    // Dense 2x is an explicit owner-visible feasibility failure, not a silent green.
    // Content/order/dwell still pass; only the documented lag targets are expected to fail.
    expect(denseRateReport.failures, jsonWithNonFinite(denseRateReport)).toEqual(
      expect.arrayContaining(['median cue-start lag', 'p95 cue-start lag']),
    );
    expect(
      denseRateReport.failures.filter(
        (failure) => failure !== 'median cue-start lag' && failure !== 'p95 cue-start lag',
      ),
      jsonWithNonFinite(denseRateReport),
    ).toEqual([]);
  } finally {
    await extension.close();
  }
});

test('long track stays bounded with no initial whole-track engine burst', async () => {
  test.setTimeout(35_000);
  const { extension, page, requests } = await openJson3Fixture({ longTrack: true });
  try {
    await driveJson3Replay(page, [
      { phase: 'normal', seekMs: 0, play: true, dwellMs: 1_000 },
      { phase: 'tail', pause: true, dwellMs: 100 },
    ]);
    const recording = await readJson3Recording(page);
    const scheduler = computeSchedulerAudit(recording, false);
    const failures: string[] = [];
    if (!scheduler.instrumentationPresent)
      failures.push('translation/scheduler instrumentation is missing');
    if (scheduler.maxOutstanding > JSON3_THRESHOLDS.maximumOutstanding)
      failures.push('outstanding request budget exceeded');
    if (scheduler.initialRequests > JSON3_THRESHOLDS.maximumInitialRequests)
      failures.push('initial translation burst exceeded the two-request product budget');
    if (requests.json3 !== 1) failures.push('long track was not fetched exactly once');
    if (requests.vtt !== 0) failures.push('unexpected VTT request');
    await saveReplayArtifacts('long-track', { scheduler, requests, failures }, recording);
    console.log('json3 long-track scheduler', scheduler, failures);
    expect(failures).toEqual([]);
  } finally {
    await extension.close();
  }
});

test('a seek beyond the prefetch window paints the destination cue', async () => {
  test.setTimeout(60_000);
  const { extension, page } = await openJson3Fixture({ longTrack: true });
  try {
    await driveJson3Replay(page, [
      // Warm only the first cue: the destination is never reached by prefetch.
      { phase: 'warm', seekMs: 0, play: true, dwellMs: 300 },
      { phase: 'far-seek', seekMs: 20_000, play: true, dwellMs: 4_000 },
    ]);
    const recording = await readJson3Recording(page);
    const destinationPaints = recording.transitions.filter(
      (transition) =>
        transition.phase === 'far-seek' &&
        transition.visible &&
        !transition.censored &&
        normalizeJson3Caption(transition.original).includes('Long track cue 4'),
    );
    const failures: string[] = [];
    const destinationErrors = recording.requests.filter(
      (request) =>
        request.phase === 'far-seek' &&
        request.action === 'finish' &&
        request.reason === 'error' &&
        normalizeJson3Caption(request.sourceText).includes('Long track cue 4'),
    );
    if (destinationErrors.length > 0)
      failures.push('seek destination translation was aborted by the generation change');
    if (destinationPaints.length === 0)
      failures.push('seek destination original was never painted');
    if (!destinationPaints.some((paint) => paint.caption.trim().length > 0))
      failures.push('seek destination translation was never painted');
    await saveReplayArtifacts('far-seek', { failures, destinationPaints }, recording);
    console.log('json3 far-seek destination paints', destinationPaints.length, failures);
    expect(failures).toEqual([]);
  } finally {
    await extension.close();
  }
});

test('live incremental ASR never enters the VOD scheduler', async () => {
  test.setTimeout(35_000);
  const { extension, page, requests } = await openJson3Fixture({ live: true });
  try {
    await driveJson3Replay(page, [
      { phase: 'live', seekMs: 0, play: true, untilMediaMs: 1_800, dwellMs: 500 },
    ]);
    const recording = await readJson3Recording(page);
    const scheduler = computeSchedulerAudit(recording, true);
    const livePaints = recording.transitions.filter(
      (transition) =>
        transition.phase === 'live' && transition.caption.includes('Live rolling answer'),
    );
    const failures: string[] = [];
    if (livePaints.length === 0) failures.push('live incremental Japanese paint is missing');
    if (!livePaints.some((transition) => transition.caption.includes('§ja§'))) {
      failures.push('live fake-engine marker is missing');
    }
    if (scheduler.liveVodSchedulerEvents !== 0) failures.push('live used VOD scheduling');
    await saveReplayArtifacts(
      'live-isolation',
      { scheduler, requests, livePaints: livePaints.length, failures },
      recording,
    );
    expect(failures).toEqual([]);
  } finally {
    await extension.close();
  }
});
