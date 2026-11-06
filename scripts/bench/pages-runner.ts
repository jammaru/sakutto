import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';

import {
  JA_TOKENS_PER_CHAR,
  MODEL_ID,
  ROOT,
  clearCache,
  ensureModel,
  log,
  prepareModel,
  readStatus,
  routeModel,
  settings,
  type ChromeApi,
} from './host.ts';
import {
  HEADLINE_PAGE,
  acceleratorFor,
  appendHistory,
  comparableRun,
  headlineFor,
  type BenchHeadline,
  comparisonRows,
  medianMetric,
  parseHistory,
  recordsOfRun,
  runSummary,
  TIMING_METRICS,
  type BenchEngine,
  type BenchMachine,
  type BenchMetricKey,
  type BenchRecord,
} from './history.ts';
import {
  MOCK_TIMEOUT_MS,
  PAGE_TIMEOUT_MS,
  commitRatePerSecond,
  installMockPace,
  installPageRecorder,
  startPageRecorder,
  waitForPageRecorder,
} from './page-metrics.ts';
import { BENCH_PAGES, type BenchPage } from './pages.ts';
import { startStaticServer } from './static.ts';

export type BenchMode = 'mock' | 'live';

export const DEFAULT_HISTORY_PATH = resolve(ROOT, 'bench/history/pages.jsonl');
export const RUNS_DIR = resolve(ROOT, 'bench/results/pages');
export const VIEWPORT = { width: 1280, height: 800 };

/**
 * Japanese runs about 1.3 tokens per character for this model family. The same constant
 * the older model bench uses, so the two outputs can be read side by side.
 */
export interface RunPageBenchOptions {
  mode: BenchMode;
  /** Extension directory. The mock mode expects the fake-engine build. */
  extension?: string | undefined;
  /** Which fixtures to run. Defaults to every page. */
  only?: string | undefined;
  /** Repetitions per fixture; the summary reports the median. */
  samples?: number | undefined;
  /** Label grouping this run in the history. */
  run?: string | undefined;
  /** Append to the JSONL history. False leaves the checked-in history untouched. */
  writeHistory?: boolean | undefined;
  historyPath?: string | undefined;
  /** Compare against an earlier run label, or the newest different one in the history. */
  compare?: string | undefined;
  /** Write `bench/results/pages/<run>.md`. */
  writeSummary?: boolean | undefined;
  /** Cached GGUF for live mode. */
  modelPath?: string | undefined;
  /** Called after every fixture so a caller can stream progress. */
  onRecord?: ((record: BenchRecord) => void) | undefined;
}

export interface RunPageBenchResult {
  run: string;
  mode: BenchMode;
  commit: string;
  dirty: boolean;
  records: BenchRecord[];
  /** The two summary numbers, derived from `records`. */
  headline: BenchHeadline;
  summary: string;
  summaryPath: string | null;
  historyPath: string | null;
  table: string;
  comparisons: { metric: BenchMetricKey; text: string }[];
}

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: ROOT, encoding: 'utf8' }).trim();
}

/**
 * Files the bench writes itself. Changing them is not a code change, and a run would
 * otherwise mark itself dirty merely by appending its own history line, which would make
 * every record look untrustworthy.
 */
const BENCH_OUTPUT_PATHS = ['bench/history', 'bench/results'] as const;

export function workingTree(): { commit: string; dirty: boolean } {
  try {
    const commit = git(['rev-parse', 'HEAD']);
    const status = git([
      'status',
      '--porcelain',
      '--untracked-files=no',
      '--',
      '.',
      ...BENCH_OUTPUT_PATHS.map((path) => `:(exclude)${path}`),
    ]);
    return { commit, dirty: status.length > 0 };
  } catch {
    // A source archive has no git metadata. The record still validates; the commit is a
    // placeholder so a reader can tell the numbers were not taken from a clone.
    return { commit: '0000000', dirty: true };
  }
}

async function waitForServiceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { timeout: 30_000 });
}

interface ExtensionHarness {
  context: BrowserContext;
  worker: Worker;
  options: Page;
  engine: BenchEngine;
  machine: Omit<BenchMachine, 'viewport'>;
  close: () => Promise<void>;
}

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
    // The extension translates with PLaMo only, but Chrome's own translator is disabled
    // anyway: a browser-level translation would change the page under the recorder and
    // blur which engine a number describes.
    '--disable-features=Translate,TranslateUI,DisableLoadExtensionCommandLineSwitch',
    '--enable-precise-memory-info',
  ];
}

/**
 * Reads the built content script to see which engine it carries. The fake engine is the
 * only build that understands the synthetic pace attribute, so it doubles as a marker.
 * A mismatched build is the easiest way to get a meaningless run, so it is checked up
 * front instead of surfacing as a five-minute timeout.
 */
async function builtEngine(extension: string): Promise<'fake' | 'real' | 'unknown'> {
  try {
    const bundle = await readFile(resolve(extension, 'content-scripts/content.js'), 'utf8');
    if (bundle.includes('data-bench-pace')) return 'fake';
    return 'real';
  } catch {
    return 'unknown';
  }
}

async function openHarness(
  mode: BenchMode,
  extension: string,
  modelPath: string,
): Promise<ExtensionHarness> {
  await readFile(resolve(extension, 'manifest.json'));

  let profile = resolve(ROOT, 'bench/.chrome-profile');
  let temporary: string | null = null;
  if (mode === 'mock') {
    // A fresh profile per run keeps a stale site rule or a warm translation cache from
    // making one sample faster than the next.
    temporary = await mkdtemp(join(tmpdir(), 'sakutto-bench-'));
    profile = temporary;
  }
  await mkdir(profile, { recursive: true });

  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    locale: 'en-US',
    viewport: VIEWPORT,
    args: launchArgs(extension),
  });
  context.setDefaultTimeout(180_000);
  context.setDefaultNavigationTimeout(60_000);

  const dropProfile = async (): Promise<void> => {
    if (temporary !== null) await rm(temporary, { recursive: true, force: true });
  };

  if (mode === 'live') await routeModel(context, modelPath);

  const worker = await waitForServiceWorker(context).catch(async (error: unknown) => {
    await context.close();
    await dropProfile();
    throw error;
  });
  const extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);

  let engine: BenchEngine;
  if (mode === 'live') {
    const prepared = await prepareModel(options);
    log(
      'page-bench',
      `download ${String(prepared.downloadMs)}ms warm ${String(prepared.warmMs)}ms ${
        prepared.status.backend ?? 'unknown'
      } threads ${String(prepared.status.threads)}`,
    );
    engine = {
      label: prepared.status.backend ?? 'plamo',
      backend: prepared.status.backend,
      tier: prepared.status.tier,
      threads: prepared.status.threads,
      chromeTranslator: prepared.status.chromeSupported,
      model: MODEL_ID,
      ...acceleratorFor({ mode: 'live', backend: prepared.status.backend }),
    };
  } else {
    await options.evaluate(async (stored) => {
      const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
      await chrome.storage.local.set({ settings: stored, siteRules: {} });
    }, settings());
    const status = await readStatus(options).catch(() => null);
    engine = {
      label: 'mock',
      backend: null,
      tier: status?.tier ?? null,
      threads: null,
      chromeTranslator: false,
      model: null,
      ...acceleratorFor({ mode: 'mock', backend: null }),
    };
  }

  const isolated = await options.evaluate(() => crossOriginIsolated);
  const cores = await options.evaluate(() => navigator.hardwareConcurrency);
  const userAgent = await options.evaluate(() => navigator.userAgent);
  const platform = await options.evaluate(() => navigator.platform);

  return {
    context,
    worker,
    options,
    engine,
    machine: { platform, cores, userAgent, crossOriginIsolated: isolated },
    close: async () => {
      await context.close();
      await dropProfile();
    },
  };
}

/** Sends the same `page:command` message the popup and the Alt+A shortcut send. */
async function commandPage(worker: Worker, page: Page, name: 'toggle' | 'restore'): Promise<void> {
  const url = page.url();
  await worker.evaluate(
    async ({ url: target, command }) => {
      const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
      const matched = await chrome.tabs.query({ url: target });
      const tabId = matched[0]?.id;
      if (tabId === undefined) throw new Error('The fixture tab was not found.');
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['/content-scripts/content.js'],
      });
      await chrome.tabs.sendMessage(tabId, { type: 'page:command', command });
    },
    { url, command: name },
  );
}

async function measurePage(input: {
  harness: ExtensionHarness;
  origin: string;
  fixture: BenchPage;
  mode: BenchMode;
  run: string;
  sample: number;
  samples: number;
  tree: { commit: string; dirty: boolean };
}): Promise<BenchRecord> {
  const { harness, fixture } = input;
  if (input.mode === 'live') await clearCache(harness.options);

  const page = await harness.context.newPage();
  await page.setViewportSize(VIEWPORT);
  try {
    await page.goto(`${input.origin}/${fixture.file}`, { waitUntil: 'load' });
    const timeoutMs = input.mode === 'mock' ? MOCK_TIMEOUT_MS : PAGE_TIMEOUT_MS;
    await installPageRecorder(page, timeoutMs);
    if (input.mode === 'mock') await installMockPace(page);
    await startPageRecorder(page);
    const startedAt = Date.now();
    await commandPage(harness.worker, page, 'toggle');
    const recorded = await waitForPageRecorder(page, timeoutMs);
    const wallMs = Date.now() - startedAt;

    const outputChars = await page.evaluate(() => {
      let total = 0;
      for (const element of document.querySelectorAll('[data-bench-id]')) {
        const kind = element.getAttribute('data-bench');
        if (kind === 'code') continue;
        total += (element.textContent ?? '').trim().length;
      }
      return total;
    });

    const seconds = (recorded.fullPageMs ?? wallMs) / 1000;
    const estimatedOutputTokensPerSecond =
      input.mode === 'live' && recorded.fullPageMs !== null && seconds > 0
        ? Math.round(((outputChars * JA_TOKENS_PER_CHAR) / seconds) * 10) / 10
        : null;

    log(
      'page-bench',
      `${fixture.name} #${String(input.sample)} first ${String(
        recorded.firstVisibleTextMs,
      )}ms viewport ${String(recorded.viewportDoneMs)}ms full ${String(recorded.fullPageMs)}ms ${
        recorded.state ?? 'no-state'
      } ${recorded.progress ?? ''}`,
    );

    return {
      schema: 1,
      run: input.run,
      mode: input.mode,
      commit: input.tree.commit,
      dirty: input.tree.dirty,
      at: new Date(Date.now() - wallMs).toISOString(),
      page: fixture.name,
      sample: input.sample,
      samples: input.samples,
      headline: fixture.name === HEADLINE_PAGE,
      engine: harness.engine,
      machine: { ...harness.machine, viewport: VIEWPORT },
      metrics: {
        firstTextMs: recorded.firstTextMs,
        firstVisibleTextMs: recorded.firstVisibleTextMs,
        viewportDoneMs: recorded.viewportDoneMs,
        fullPageMs: recorded.fullPageMs,
        commitsPerSecond: commitRatePerSecond(recorded),
        outputChars,
        estimatedOutputTokensPerSecond,
        reportedRate: recorded.rate,
        engineWork: {
          batches: recorded.perf?.batches ?? null,
          pieces: recorded.perf?.pieces ?? null,
          engineMs: recorded.perf?.engineMs ?? null,
        },
        blocks: recorded.blocks,
        lateBlocks: recorded.lateBlocks,
        engines: recorded.engines,
        codeUntouched: recorded.codeUntouched,
        state: recorded.state,
        progress: recorded.progress,
        timedOut: recorded.timedOut,
        ...(recorded.unfinished.length > 0 ? { unfinished: recorded.unfinished } : {}),
      },
      ...(input.mode === 'mock'
        ? {
            notes:
              'Mock translator: measures scheduling, splitting, painting and harness overhead, not model speed.',
          }
        : {}),
    };
  } finally {
    await page.close();
  }
}

function table(records: readonly BenchRecord[]): string {
  const header = [
    '| Page | First visible text (ms) | Viewport done (ms) | Full page (ms) | Blocks/s | Output chars |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  const pages = [...new Set(records.map((record) => record.page))];
  const rows = pages.map((name) => {
    const samples = records.filter((record) => record.page === name);
    const cell = (metric: BenchMetricKey): string => {
      const value = medianMetric(samples, metric);
      return value === null ? '—' : String(value);
    };
    return `| ${name} | ${cell('firstVisibleTextMs')} | ${cell('viewportDoneMs')} | ${cell(
      'fullPageMs',
    )} | ${cell('commitsPerSecond')} | ${String(samples[0]?.metrics.outputChars ?? 0)} |`;
  });
  return [...header, ...rows].join('\n');
}

async function readHistory(path: string): Promise<BenchRecord[]> {
  try {
    const text = await readFile(path, 'utf8');
    const { records, problems } = parseHistory(text);
    if (problems.length > 0) {
      log(
        'page-bench',
        `history has ${String(problems.length)} unreadable line(s): ${problems[0]}`,
      );
    }
    return records;
  } catch {
    return [];
  }
}

export function defaultRunLabel(mode: BenchMode, at = new Date()): string {
  return `${mode}-${at.toISOString().replace(/[:.]/gu, '-').slice(0, 19)}`;
}

/**
 * Runs the fixture set against a real unpacked extension in Chromium and returns the
 * records. The CLI and the CI guard both go through this function so there is exactly
 * one code path for a measured page.
 */
export async function runPageBench(options: RunPageBenchOptions): Promise<RunPageBenchResult> {
  const mode = options.mode;
  const extension = resolve(options.extension ?? resolve(ROOT, '.output/chrome-mv3'));
  const samples = options.samples !== undefined && options.samples > 0 ? options.samples : 1;
  const run = options.run ?? defaultRunLabel(mode);
  const historyPath = options.historyPath ?? DEFAULT_HISTORY_PATH;
  const writeHistory = options.writeHistory ?? true;
  const writeSummary = options.writeSummary ?? true;
  const tree = workingTree();
  const modelPath = resolve(
    options.modelPath ?? resolve(ROOT, 'bench/.cache/plamo-3-translate-0.8b-Q4_K_M.gguf'),
  );

  const fixtures = options.only
    ? BENCH_PAGES.filter((page) => page.name === options.only)
    : [...BENCH_PAGES];
  if (fixtures.length === 0) {
    throw new Error(
      `Unknown page "${options.only ?? ''}". Known pages: ${BENCH_PAGES.map(
        (page) => page.name,
      ).join(', ')}.`,
    );
  }

  // Check the build before the 573 MB model download: a fake build in live mode is a
  // configuration mistake, and waiting for the download first only wastes the reader's
  // bandwidth before reporting it.
  const build = await builtEngine(extension);
  if (mode === 'mock' && build === 'real') {
    throw new Error(
      `The extension at ${extension} was built without the fake engine. Run "pnpm bench:build:mock" first, or use "pnpm bench:live".`,
    );
  }
  if (mode === 'live' && build === 'fake') {
    throw new Error(
      `The extension at ${extension} is a fake-engine build. Run "pnpm bench:build:live" first.`,
    );
  }

  if (mode === 'live') await ensureModel(modelPath);

  const server = await startStaticServer({ directory: resolve(ROOT, 'bench/pages') });
  let harness: ExtensionHarness;
  try {
    harness = await openHarness(mode, extension, modelPath);
  } catch (error) {
    // A rejected build must not leave the static server holding the process open.
    await server.close();
    throw error;
  }
  const records: BenchRecord[] = [];

  try {
    for (let index = 0; index < samples; index += 1) {
      for (const fixture of fixtures) {
        const record = await measurePage({
          harness,
          origin: server.origin,
          fixture,
          mode,
          run,
          sample: index + 1,
          samples,
          tree,
        });
        records.push(record);
        options.onRecord?.(record);
      }
    }
  } finally {
    await harness.close();
    await server.close();
  }

  const history = await readHistory(historyPath);
  // An automatic comparison needs a run of the same mode over the same fixtures: mock and
  // live durations are on different scales, and a `--only` run has no row for the others.
  // An explicit --compare still wins; the summary warns when that pair spans modes.
  const compareWith =
    options.compare ??
    comparableRun(
      history,
      run,
      mode,
      records.map((record) => record.page),
    );

  const summary = runSummary({
    run,
    mode,
    commit: tree.commit,
    dirty: tree.dirty,
    at: records[0]?.at ?? new Date().toISOString(),
    records,
    ...(compareWith
      ? { before: { run: compareWith, records: recordsOfRun(history, compareWith) } }
      : {}),
  });

  let summaryPath: string | null = null;
  if (writeSummary) {
    await mkdir(RUNS_DIR, { recursive: true });
    summaryPath = resolve(RUNS_DIR, `${run}.md`);
    await writeFile(summaryPath, summary);
  }
  if (writeHistory) {
    await mkdir(resolve(historyPath, '..'), { recursive: true });
    await appendHistory(historyPath, records);
  }

  const comparisons: { metric: BenchMetricKey; text: string }[] = [];
  if (compareWith) {
    for (const metric of TIMING_METRICS) {
      const rows = comparisonRows(recordsOfRun(history, compareWith), records, metric).filter(
        (row) => row.before !== null && row.after !== null,
      );
      if (rows.length === 0) continue;
      comparisons.push({
        metric,
        text: rows
          .map(
            (row) =>
              `${row.page} ${String(row.before)} -> ${String(row.after)} (${String(row.percent ?? '?')}%)`,
          )
          .join('  '),
      });
    }
  }

  return {
    run,
    mode,
    commit: tree.commit,
    dirty: tree.dirty,
    records,
    headline: headlineFor(records),
    summary,
    summaryPath,
    historyPath: writeHistory ? historyPath : null,
    table: table(records),
    comparisons,
  };
}
