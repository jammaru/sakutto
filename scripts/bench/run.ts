import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';

import { BATCH_SENTENCES, QUALITY_PARAGRAPH, SHORT_TEXT, enginePage } from './engine-page.ts';
import { PAGES } from './fixtures.ts';
import {
  JA_TOKENS_PER_CHAR,
  MODEL_ID,
  ROOT,
  arg,
  clearCache,
  ensureModel,
  has,
  log as benchLog,
  prepareModel,
  routeModel,
  type ChromeApi,
} from './host.ts';
import { startBenchServer } from './server.ts';

const PAGE_TIMEOUT_MS = 12 * 60 * 1000;

interface PageResult {
  page: string;
  firstVisibleParagraphMs: number | null;
  firstScreenMs: number | null;
  fullPageMs: number | null;
  proseDone: number;
  proseTotal: number;
  progress: string | null;
  outputChars: number;
  estimatedOutputTokensPerSec: number | null;
  codeUntouched: boolean | null;
  cacheReplayMs: number | null;
  rssMb: number;
  timedOut: boolean;
}

interface EngineCase {
  name: string;
  ms: number;
  ttftMs: number | null;
  chars: number;
  timings: {
    promptN: number | null;
    promptMs: number | null;
    promptPerSecond: number | null;
    predictedN: number | null;
    predictedMs: number | null;
    predictedPerSecond: number | null;
  } | null;
  lineCount?: number;
  expectedLines?: number;
  text: string;
}

async function waitForServiceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { timeout: 30_000 });
}

function rssMb(needle: string): number {
  const output = execFileSync('ps', ['-eo', 'rss=,cmd='], { encoding: 'utf8' });
  let kb = 0;
  for (const line of output.split('\n')) {
    if (!line.includes(needle)) continue;
    const rss = Number(line.trim().split(/\s+/, 1)[0]);
    if (Number.isFinite(rss)) kb += rss;
  }
  return Math.round(kb / 1024);
}

function extensionDir(): string {
  return resolve(arg('--extension') ?? resolve(ROOT, '.output/chrome-mv3'));
}

function vendorDir(): string {
  return resolve(arg('--vendor') ?? resolve(ROOT, 'public/vendor/wllama'));
}

async function command(worker: Worker, page: Page, name: 'toggle' | 'restore'): Promise<void> {
  const url = page.url();
  await worker.evaluate(
    async ({ url: target, command: action }) => {
      const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
      const matched = await chrome.tabs.query({ url: target });
      const tabId = matched[0]?.id;
      if (tabId === undefined) throw new Error('The fixture tab was not found.');
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['/content-scripts/content.js'],
      });
      await chrome.tabs.sendMessage(tabId, { type: 'page:command', command: action });
    },
    { url, command: name },
  );
}

interface LiveSnap {
  id: string;
  kind: string;
  text: string;
  engine: string | null;
  pending: boolean;
  progress: string | null;
  state: string | null;
}

async function readSnap(page: Page, ids: readonly string[]): Promise<LiveSnap[]> {
  return page.evaluate(
    (wanted) => {
      const root = document.documentElement;
      return wanted.map((id) => {
        const node = document.querySelector(`[data-bench-id="${id}"]`);
        return {
          id,
          kind: node?.getAttribute('data-bench') ?? '',
          text: node?.textContent?.trim() ?? '',
          engine: node?.getAttribute('data-sakutto-engine') ?? null,
          pending: node?.hasAttribute('data-sakutto-pending') ?? false,
          progress: root.dataset.sakuttoProgress ?? null,
          state: root.dataset.sakuttoState ?? null,
        };
      });
    },
    [...ids],
  );
}

async function measurePage(
  worker: Worker,
  page: Page,
  profileNeedle: string,
  replay: boolean,
): Promise<PageResult> {
  if (page.url().endsWith('/spa.html')) {
    await page.waitForFunction(() => document.documentElement.dataset.benchReady === '1');
  }
  await page.waitForTimeout(100);

  const initial = await page.evaluate(() => {
    const height = window.innerHeight;
    return [...document.querySelectorAll('[data-bench-id]')].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        id: node.getAttribute('data-bench-id') ?? '',
        kind: node.getAttribute('data-bench') ?? '',
        text: node.textContent?.trim() ?? '',
        visible: rect.width > 0 && rect.bottom > 0 && rect.top < height,
      };
    });
  });
  const originals = new Map(initial.map((item) => [item.id, item.text]));
  const visibleProse = initial
    .filter((item) => item.kind === 'prose' && item.visible)
    .map((item) => item.id);
  const proseIds = initial.filter((item) => item.kind === 'prose').map((item) => item.id);
  const codeIds = initial.filter((item) => item.kind === 'code').map((item) => item.id);
  const watched = initial.map((item) => item.id);

  const started = Date.now();
  await command(worker, page, 'toggle');

  let firstVisibleParagraphMs: number | null = null;
  let firstScreenMs: number | null = null;
  let fullPageMs: number | null = null;
  let progress: string | null = null;
  let lastLog = started;

  while (Date.now() - started < PAGE_TIMEOUT_MS) {
    const snap = await readSnap(page, watched);
    progress = snap[0]?.progress ?? progress;
    const byId = new Map(snap.map((item) => [item.id, item]));
    const changed = (id: string): boolean => {
      const item = byId.get(id);
      const original = originals.get(id) ?? '';
      return Boolean(item && item.text.length > 0 && item.text !== original);
    };
    const done = (id: string): boolean => {
      const item = byId.get(id);
      return Boolean(item && item.engine && !item.pending && changed(id));
    };

    const top = visibleProse[0];
    if (top && changed(top) && firstVisibleParagraphMs === null) {
      firstVisibleParagraphMs = Date.now() - started;
    }
    if (visibleProse.length > 0 && visibleProse.every(done) && firstScreenMs === null) {
      firstScreenMs = Date.now() - started;
    }
    if (snap.some((item) => item.state === 'translated') && proseIds.every(done)) {
      fullPageMs = Date.now() - started;
      break;
    }
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      const finished = proseIds.filter(done).length;
      benchLog(
        'bench',
        `  ${progress ?? 'starting'} prose ${String(finished)}/${String(proseIds.length)} first ${String(firstVisibleParagraphMs)} screen ${String(firstScreenMs)}`,
      );
    }
    await page.waitForTimeout(250);
  }

  const snap = await readSnap(page, watched);
  const byId = new Map(snap.map((item) => [item.id, item]));
  const proseDone = proseIds.filter((id) => {
    const item = byId.get(id);
    return Boolean(item && item.engine && item.text !== (originals.get(id) ?? ''));
  }).length;
  const outputChars = proseIds.reduce((sum, id) => sum + (byId.get(id)?.text.length ?? 0), 0);
  const seconds = (fullPageMs ?? Date.now() - started) / 1000;
  const codeUntouched =
    codeIds.length === 0
      ? null
      : codeIds.every((id) => (byId.get(id)?.text ?? '') === (originals.get(id) ?? ''));

  let cacheReplayMs: number | null = null;
  if (replay && fullPageMs !== null) {
    await command(worker, page, 'restore');
    await page.waitForFunction(
      () => document.documentElement.dataset.sakuttoState !== 'translating',
    );
    const replayStarted = Date.now();
    await command(worker, page, 'toggle');
    await page.waitForFunction(
      () => document.documentElement.dataset.sakuttoState === 'translated',
      { timeout: 60_000 },
    );
    cacheReplayMs = Date.now() - replayStarted;
  }

  return {
    page: page.url(),
    firstVisibleParagraphMs,
    firstScreenMs,
    fullPageMs,
    proseDone,
    proseTotal: proseIds.length,
    progress: snap[0]?.progress ?? progress,
    outputChars,
    estimatedOutputTokensPerSec:
      fullPageMs && fullPageMs > 0
        ? Math.round(((outputChars * JA_TOKENS_PER_CHAR) / seconds) * 10) / 10
        : null,
    codeUntouched,
    cacheReplayMs,
    rssMb: rssMb(profileNeedle),
    timedOut: fullPageMs === null,
  };
}

async function runPages(
  modelPath: string,
  onUpdate?: (value: { machine: Record<string, unknown>; pages: PageResult[] }) => Promise<void>,
): Promise<{
  machine: Record<string, unknown>;
  pages: PageResult[];
}> {
  const extension = extensionDir();
  await access(resolve(extension, 'manifest.json'));
  const profile = resolve(ROOT, 'bench/.chrome-profile');
  await mkdir(profile, { recursive: true });
  const server = await startBenchServer({
    vendorDir: vendorDir(),
    modelPath,
    engineHtml: enginePage(),
  });

  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--headless=new',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-first-run',
      '--disable-default-apps',
      '--disable-features=Translate,TranslateUI,DisableLoadExtensionCommandLineSwitch',
      '--enable-precise-memory-info',
    ],
  });
  context.setDefaultTimeout(180_000);
  context.setDefaultNavigationTimeout(60_000);

  try {
    await routeModel(context, modelPath);

    const worker = await waitForServiceWorker(context);
    const extensionId = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    const prepared = await prepareModel(options);
    benchLog(
      'bench',
      `download ${String(prepared.downloadMs)}ms warm ${String(prepared.warmMs)}ms ${prepared.status.backend ?? 'unknown'} chrome ${String(prepared.status.chromeSupported)} threads ${String(prepared.status.threads)}`,
    );

    const isolated = await options.evaluate(() => crossOriginIsolated);
    const cores = await options.evaluate(() => navigator.hardwareConcurrency);
    const userAgent = await options.evaluate(() => navigator.userAgent);
    const pages: PageResult[] = [];
    const machine = {
      cores,
      userAgent,
      crossOriginIsolated: isolated,
      backend: prepared.status.backend,
      tier: prepared.status.tier,
      threads: prepared.status.threads,
      chromeSupported: prepared.status.chromeSupported,
      downloadMs: prepared.downloadMs,
      warmMs: prepared.warmMs,
      rssMb: rssMb(profile),
    };

    const only = arg('--only');
    const fixtures = only ? PAGES.filter((fixture) => fixture.name === only) : PAGES;
    if (only && fixtures.length === 0) {
      throw new Error(`Unknown page "${only}".`);
    }

    for (const fixture of fixtures) {
      benchLog('bench', `page ${fixture.name}`);
      await clearCache(options);
      const page = await context.newPage();
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${server.origin}${fixture.path}`);
      const result = await measurePage(worker, page, profile, fixture.name === 'docs');
      result.page = fixture.name;
      pages.push(result);
      machine.rssMb = rssMb(profile);
      benchLog(
        'bench',
        `${fixture.name} first ${String(result.firstVisibleParagraphMs)} screen ${String(result.firstScreenMs)} full ${String(result.fullPageMs)} rss ${String(result.rssMb)}MB`,
      );
      await onUpdate?.({ machine, pages: [...pages] });
      await page.close();
    }

    return { machine, pages };
  } finally {
    await context.close();
    await server.close();
  }
}

interface ProbeLoad {
  nCtx: number;
  nThreads: number;
  nGpuLayers: number;
  nParallel: number;
  nBatch?: number;
  nUbatch?: number;
  flashAttn?: boolean;
  contBatching?: boolean;
  cacheType?: string;
}

async function probeCase(
  page: Page,
  name: string,
  spec: { mode: 'one' | 'lines' | 'sequence' | 'parallel'; texts: string[]; cachePrompt: boolean },
): Promise<EngineCase> {
  const result = await page.evaluate(async (input) => {
    const bench = (
      globalThis as unknown as {
        sakuttoBench: {
          runCase(spec: unknown): Promise<{
            ms: number;
            ttftMs: number | null;
            text: string;
            timings: EngineCase['timings'];
            lineCount?: number;
            expectedLines?: number;
          }>;
        };
      }
    ).sakuttoBench;
    return bench.runCase(input);
  }, spec);
  const lines =
    result.lineCount === undefined
      ? ''
      : ` lines ${String(result.lineCount)}/${String(result.expectedLines)}`;
  benchLog('bench', `  ${name} ${String(result.ms)}ms ttft ${String(result.ttftMs)}${lines}`);
  return {
    name,
    ms: result.ms,
    ttftMs: result.ttftMs,
    chars: result.text.length,
    timings: result.timings,
    ...(result.lineCount !== undefined ? { lineCount: result.lineCount } : {}),
    ...(result.expectedLines !== undefined ? { expectedLines: result.expectedLines } : {}),
    text: result.text,
  };
}

async function loadProbe(page: Page, params: ProbeLoad): Promise<Record<string, unknown>> {
  return page.evaluate(async (input) => {
    const bench = (
      globalThis as unknown as {
        sakuttoBench: { loadModel(params: unknown): Promise<Record<string, unknown>> };
      }
    ).sakuttoBench;
    return bench.loadModel(input);
  }, params);
}

async function runEngine(modelPath: string, sweep: boolean): Promise<Record<string, unknown>> {
  const profile = resolve(ROOT, 'bench/.engine-profile');
  await mkdir(profile, { recursive: true });
  const server = await startBenchServer({
    vendorDir: vendorDir(),
    modelPath,
    engineHtml: enginePage(),
  });
  const context: BrowserContext = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 800, height: 600 },
    args: [
      '--headless=new',
      '--disable-features=Translate,TranslateUI',
      '--enable-precise-memory-info',
    ],
  });
  context.setDefaultTimeout(180_000);

  try {
    const page = await context.newPage();
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('Multithread') || text.toLowerCase().includes('error')) {
        benchLog('bench', `engine console: ${text}`);
      }
    });
    await page.goto(`${server.origin}/engine.html`);
    await page.waitForFunction(
      () =>
        (globalThis as unknown as { sakuttoBench?: { ready?: boolean } }).sakuttoBench?.ready ===
        true,
    );
    const cores = await page.evaluate(() => navigator.hardwareConcurrency);
    const threads = Math.max(1, Math.min(4, cores));
    const loaded = await loadProbe(page, {
      nCtx: 2048,
      nThreads: threads,
      nGpuLayers: 0,
      nParallel: 1,
    });
    benchLog(
      'bench',
      `engine loaded in ${String(loaded.loadMs)}ms threads ${String(loaded.threads)} isolated ${String(loaded.isolated)}`,
    );

    const cases: EngineCase[] = [];
    cases.push(
      await probeCase(page, 'short-cache-off', {
        mode: 'one',
        texts: [SHORT_TEXT],
        cachePrompt: false,
      }),
    );
    cases.push(
      await probeCase(page, 'short-cache-on-1', {
        mode: 'one',
        texts: [SHORT_TEXT],
        cachePrompt: true,
      }),
    );
    cases.push(
      await probeCase(page, 'short-cache-on-2', {
        mode: 'one',
        texts: [SHORT_TEXT],
        cachePrompt: true,
      }),
    );
    cases.push(
      await probeCase(page, 'paragraph-cache-on-1', {
        mode: 'one',
        texts: [QUALITY_PARAGRAPH],
        cachePrompt: true,
      }),
    );
    cases.push(
      await probeCase(page, 'paragraph-cache-on-2', {
        mode: 'one',
        texts: [QUALITY_PARAGRAPH],
        cachePrompt: true,
      }),
    );
    cases.push(
      await probeCase(page, 'sentences-separate', {
        mode: 'sequence',
        texts: BATCH_SENTENCES,
        cachePrompt: true,
      }),
    );
    cases.push(
      await probeCase(page, 'sentences-batched', {
        mode: 'lines',
        texts: BATCH_SENTENCES,
        cachePrompt: true,
      }),
    );

    const quiet = await page.evaluate(async (text) => {
      const bench = (
        globalThis as unknown as {
          sakuttoBench: {
            completeQuiet(value: string, cachePrompt: boolean): Promise<Record<string, unknown>>;
          };
        }
      ).sakuttoBench;
      return bench.completeQuiet(text, true);
    }, QUALITY_PARAGRAPH);
    benchLog('bench', `quiet paragraph ${String(quiet.ms)}ms`);

    const sweeps: Array<Record<string, unknown>> = [];
    if (sweep) {
      const base: ProbeLoad = {
        nCtx: 2048,
        nThreads: threads,
        nGpuLayers: 0,
        nParallel: 1,
      };
      const configs: ProbeLoad[] = [
        { ...base, nThreads: Math.max(1, Math.floor(cores / 2)) },
        { ...base, nThreads: cores },
        { ...base, nCtx: 1024 },
        { ...base, nBatch: 128 },
        { ...base, nBatch: 512 },
        { ...base, nBatch: 1024 },
        { ...base, nBatch: 2048 },
        { ...base, nUbatch: 128 },
        { ...base, nUbatch: 256 },
        { ...base, nUbatch: 512 },
        { ...base, flashAttn: true },
        { ...base, cacheType: 'q8_0' },
        { ...base, nParallel: 2, nCtx: 4096, contBatching: true },
        {
          ...base,
          nParallel: 2,
          nCtx: 4096,
          contBatching: true,
          nThreads: Math.max(1, Math.floor(cores / 2)),
        },
      ];
      for (const config of configs) {
        try {
          const info = await loadProbe(page, config);
          const paragraph = await probeCase(page, 'sweep-paragraph', {
            mode: 'one',
            texts: [QUALITY_PARAGRAPH],
            cachePrompt: true,
          });
          const again = await probeCase(page, 'sweep-paragraph-2', {
            mode: 'one',
            texts: [QUALITY_PARAGRAPH],
            cachePrompt: true,
          });
          const parallel =
            config.nParallel > 1
              ? await probeCase(page, 'sweep-parallel', {
                  mode: 'parallel',
                  texts: [QUALITY_PARAGRAPH, QUALITY_PARAGRAPH],
                  cachePrompt: false,
                })
              : null;
          sweeps.push({ config, info, paragraph, again, ...(parallel ? { parallel } : {}) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          benchLog('bench', `sweep failed ${JSON.stringify(config)}: ${message}`);
          sweeps.push({ config, error: message });
          await page.goto(`${server.origin}/engine.html`);
          await page.waitForFunction(
            () =>
              (globalThis as unknown as { sakuttoBench?: { ready?: boolean } }).sakuttoBench
                ?.ready === true,
          );
        }
      }
    }

    return {
      loaded,
      cases,
      quiet,
      sweeps,
      rssMb: rssMb(profile),
    };
  } finally {
    await context.close();
    await server.close();
  }
}

function table(pages: readonly PageResult[]): string {
  const header = [
    '| Page | First paragraph (ms) | First screen (ms) | Full page (ms) | Output tok/s | RSS MiB |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  const rows = pages.map((page) => {
    const cell = (value: number | null): string => (value === null ? '—' : String(value));
    return `| ${page.page} | ${cell(page.firstVisibleParagraphMs)} | ${cell(page.firstScreenMs)} | ${cell(page.fullPageMs)} | ${cell(page.estimatedOutputTokensPerSec)} | ${String(page.rssMb)} |`;
  });
  return [...header, ...rows].join('\n');
}

async function main(): Promise<void> {
  const pagesOnly = has('--pages-only');
  const engineOnly = has('--engine-only');
  const runPageBench = !engineOnly;
  const runEngineBench = !pagesOnly;
  const label = arg('--label') ?? 'baseline';
  const modelPath = resolve(
    arg('--model') ?? resolve(ROOT, 'bench/.cache/plamo-3-translate-0.8b-Q4_K_M.gguf'),
  );
  await ensureModel(modelPath);

  const result: Record<string, unknown> = {
    label,
    at: new Date().toISOString(),
    model: MODEL_ID,
  };

  const outDir = resolve(ROOT, 'bench/results');
  await mkdir(outDir, { recursive: true });
  const out = resolve(outDir, `${label}.json`);
  const save = async (): Promise<void> => {
    await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  };

  try {
    if (runEngineBench) {
      benchLog('bench', 'engine probe');
      result.engine = await runEngine(modelPath, has('--sweep'));
      await save();
    }
    if (runPageBench) {
      benchLog('bench', 'page bench');
      const pages = await runPages(modelPath, async (partial) => {
        result.machine = partial.machine;
        result.pages = partial.pages;
        await save();
      });
      result.machine = pages.machine;
      result.pages = pages.pages;
      console.log(table(pages.pages));
      await save();
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    await save();
    throw error;
  }

  benchLog('bench', `wrote ${out}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
