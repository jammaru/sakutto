import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';

import { DEFAULT_MODEL_ID, getModel } from '../../src/engine/model/catalog.ts';
import { BATCH_SENTENCES, QUALITY_PARAGRAPH, SHORT_TEXT, enginePage } from './engine-page.ts';
import { PAGES } from './fixtures.ts';
import { startBenchServer } from './server.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PINNED_MODEL = getModel(DEFAULT_MODEL_ID);
const MODEL_SHA = PINNED_MODEL.sha256;
const MODEL_URL = PINNED_MODEL.url;
const MODEL_ID = 'plamo-3-translate-0.8b-q4_k_m';
const JA_TOKENS_PER_CHAR = 447 / 1000;
const PAGE_TIMEOUT_MS = 12 * 60 * 1000;

interface ChromeApi {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
  storage: {
    local: {
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  tabs: {
    query(query: Record<string, unknown>): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  scripting: {
    executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  };
}

interface ModelStatus {
  state: string;
  progress: number;
  error?: string;
  received: number;
  total: number;
}

interface EngineStatus {
  model: ModelStatus;
  backend: string | null;
  tier: string | null;
  threads: number | null;
  plamoReady: boolean;
  chromeSupported: boolean;
}

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

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function log(message: string): void {
  console.log(`[bench] ${new Date().toISOString()} ${message}`);
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

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash());
  });
  return hash.digest('hex');
}

async function ensureModel(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    log(`downloading the model to ${path}`);
    await mkdir(dirname(path), { recursive: true });
    const response = await fetch(MODEL_URL);
    if (!response.ok || !response.body) {
      throw new Error(`The model download failed with HTTP ${String(response.status)}.`);
    }
    const { createWriteStream } = await import('node:fs');
    const sink = createWriteStream(path);
    const reader = response.body.getReader();
    await new Promise<void>((resolveWrite, reject) => {
      sink.on('error', reject);
      sink.on('finish', () => resolveWrite());
      const pump = (): void => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              sink.end();
              return;
            }
            if (value) sink.write(Buffer.from(value));
            pump();
          })
          .catch(reject);
      };
      pump();
    });
  }

  const digest = await sha256File(path);
  if (digest !== MODEL_SHA) {
    throw new Error(`Model SHA-256 is ${digest}, expected ${MODEL_SHA}.`);
  }
}

function extensionDir(): string {
  return resolve(arg('--extension') ?? resolve(ROOT, '.output/chrome-mv3'));
}

function vendorDir(): string {
  return resolve(arg('--vendor') ?? resolve(ROOT, 'public/vendor/wllama'));
}

function settings(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    targetLanguage: 'ja',
    form: 'polite',
    display: 'replace',
    consent: {
      license: 'plamo-community',
      version: '2026-11-05',
      acceptedAt: '2026-11-05T00:00:00.000Z',
      guardian: true,
    },
    highQualityDismissed: true,
    glossary: [],
    idleMinutes: 15,
    tier: 'auto',
    pace: 'quality',
  };
}

async function extensionCall(page: Page, message: unknown): Promise<unknown> {
  return page.evaluate(async (payload) => {
    const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
    return chrome.runtime.sendMessage(payload);
  }, message);
}

async function readStatus(page: Page): Promise<EngineStatus | null> {
  const value = await extensionCall(page, { type: 'engine:status' });
  if (!value || typeof value !== 'object') return null;
  return value as EngineStatus;
}

async function prepareModel(
  page: Page,
): Promise<{ downloadMs: number; warmMs: number; status: EngineStatus }> {
  await page.evaluate(async (stored) => {
    const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
    await chrome.storage.local.set({ settings: stored, siteRules: {} });
  }, settings());

  const downloadStarted = Date.now();
  const accepted = await extensionCall(page, { type: 'model:download', modelId: MODEL_ID });
  if (accepted !== true) {
    throw new Error(`The model download was refused: ${JSON.stringify(accepted)}`);
  }

  let status = await readStatus(page);
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    status = await readStatus(page);
    const state = status?.model.state ?? 'unknown';
    if (state === 'error') {
      throw new Error(status?.model.error ?? 'The model download failed.');
    }
    if (state === 'ready' || state === 'loaded') break;
    log(`model ${state} ${Math.round((status?.model.progress ?? 0) * 100)}%`);
    await page.waitForTimeout(2000);
  }
  if (!status || (status.model.state !== 'ready' && status.model.state !== 'loaded')) {
    throw new Error(`The model was not ready: ${status?.model.state ?? 'missing'}.`);
  }
  const downloadMs = Date.now() - downloadStarted;

  const warmStarted = Date.now();
  log('loading the model');
  const warmed = await extensionCall(page, { type: 'engine:warm' });
  if (warmed !== true) throw new Error('The model warm-up failed.');
  status = await readStatus(page);
  if (!status?.plamoReady) throw new Error('PLaMo did not become ready after warm-up.');
  return { downloadMs, warmMs: Date.now() - warmStarted, status };
}

async function clearCache(page: Page): Promise<void> {
  await extensionCall(page, { type: 'cache:clear' });
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
      log(
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
    await context.route('**/*plamo-3-translate-0.8b-Q4_K_M.gguf*', async (route) => {
      await route.fulfill({
        path: modelPath,
        status: 200,
        headers: {
          'access-control-allow-origin': '*',
          'cross-origin-resource-policy': 'cross-origin',
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
        },
      });
    });

    const worker = await waitForServiceWorker(context);
    const extensionId = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    const prepared = await prepareModel(options);
    log(
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
      log(`page ${fixture.name}`);
      await clearCache(options);
      const page = await context.newPage();
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${server.origin}${fixture.path}`);
      const result = await measurePage(worker, page, profile, fixture.name === 'docs');
      result.page = fixture.name;
      pages.push(result);
      machine.rssMb = rssMb(profile);
      log(
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
  log(`  ${name} ${String(result.ms)}ms ttft ${String(result.ttftMs)}${lines}`);
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
        log(`engine console: ${text}`);
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
    log(
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
    log(`quiet paragraph ${String(quiet.ms)}ms`);

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
          log(`sweep failed ${JSON.stringify(config)}: ${message}`);
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
      log('engine probe');
      result.engine = await runEngine(modelPath, has('--sweep'));
      await save();
    }
    if (runPageBench) {
      log('page bench');
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

  log(`wrote ${out}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
