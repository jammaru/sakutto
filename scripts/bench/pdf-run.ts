/**
 * The PDF bench.
 *
 * It answers one question: does a translated PDF still read like the page it came from? The
 * harness loads the built extension, opens the paper fixture through the same `pdf:open` path
 * the popup uses, waits for the document to finish, and reports — per page — how many blocks
 * were found, translated, shrunk or clipped, and what each block's fitted size was next to
 * the size its source was set in.
 *
 *   pnpm bench:pdf                 # 8 threads, reusing the model in the profile
 *   pnpm bench:pdf --threads 4
 *   pnpm bench:pdf --page scan     # the bitmap-only fixture, which must report no text
 *   pnpm bench:pdf --keep-cache    # keep the translation cache instead of clearing it
 *
 * The model is downloaded once, from the copy in `bench/.cache/`, and kept in the browser
 * profile at `bench/.cache/pdf-profile`. That profile is reused by every later run, so the
 * model is loaded from disk rather than fetched again; the extension is staged at the same
 * path every time for the same reason (`stageExtension` explains why the ID matters).
 * Delete the profile directory to start from nothing.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';

import {
  MODEL_FILE,
  ROOT,
  arg,
  ensureModel,
  has,
  log,
  routeModel,
  settings,
  type ChromeApi,
} from './host.ts';
import { startStaticServer } from './static.ts';
import { pdfBenchFinishedCount } from './pdf-complete.ts';
import { stageExtension } from './stable-extension.ts';

const MODEL_PATH = resolve(ROOT, 'bench/.cache', MODEL_FILE);
const PROFILE = resolve(ROOT, 'bench/.cache/pdf-profile');
const FIXTURES = resolve(ROOT, 'bench/pdf');
const OUT = resolve(ROOT, 'bench/results/pdf');

interface CoverageEntry {
  role: string;
  state: string;
  source: { x: number; y: number; width: number; height: number };
  sourceText: string;
  translation: string;
  fontSize: number;
  fittedSize: number | null;
  fits: boolean | null;
  lines: number;
  drawn: { left: number; top: number; width: number; height: number } | null;
}

interface ReaderApi {
  coverage(page: number): CoverageEntry[];
  parsedPages(): number[];
}

interface PageReport {
  page: number;
  blocks: number;
  translated: number;
  failed: number;
  /** Blocks whose type had to shrink below 75% of the source size. */
  shrunk: number;
  /** Blocks whose translation did not fit at all and had to be cut short. */
  clipped: number;
  /** Translated blocks with no box drawn over them. */
  uncovered: number;
  /** Pairs of drawn boxes that overlap: the defect a reader sees as text on text. */
  overlaps: number;
  /** The overlapping pairs, as `"WxH [source] x [source]"`, so a report names them. */
  overlapPairs: string[];
  /** Boxes whose text is taller than the box, so the last line is cut off. */
  cutOff: number;
  medianScale: number;
  samples: Array<{ role: string; scale: string; lines: number; en: string; ja: string }>;
}

interface RunReport {
  fixture: string;
  threads: number;
  pages: number;
  blocks: number;
  translated: number;
  failed: number;
  uncovered: number;
  modelDownloaded: boolean;
  /** Copies of the model the profile holds. One is the expected number. */
  modelCopies: number;
  warmMs: number;
  translateMs: number;
  reader: PageReport[];
}

/**
 * Forgets the code Chrome cached for the extension, keeping what it stored for the reader.
 *
 * A persistent profile keeps the extension's service worker and compiled script in
 * `Default/Service Worker` and `Default/Code Cache`. Loading a rebuilt extension from the same
 * path with the same ID then runs the *old* worker, which is what made an unchanged benchmark
 * report a stale failure. The model lives in the profile's private file system
 * (`Default/File System`), which is untouched, so this costs no download.
 */
async function clearCodeCache(): Promise<void> {
  for (const directory of ['Service Worker', 'Code Cache', 'ScriptCache']) {
    await rm(join(PROFILE, 'Default', directory), { recursive: true, force: true });
  }
}

/**
 * How many copies of the model the profile holds.
 *
 * Chrome keys an origin's private file system by the extension's ID, and an unpacked
 * extension's ID comes from the absolute path it is loaded from. Staging the build at one path
 * (`stageExtension`) is what keeps this at one; two copies means a build was loaded from
 * somewhere else and 546 MB is now stranded. The bench reports it rather than quietly letting
 * the profile grow a model per experiment.
 */
async function modelCopies(): Promise<number> {
  const root = join(PROFILE, 'Default', 'File System');
  let copies = 0;
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const stats = await stat(path).catch(() => null);
      if (stats && stats.size > 400 * 1024 * 1024) copies += 1;
    }
  };
  await walk(root);
  return copies;
}

async function launch(
  extension: string,
): Promise<{ context: BrowserContext; id: string; worker: Worker }> {
  await mkdir(PROFILE, { recursive: true });
  await clearCodeCache();
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-first-run',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
    ],
  });

  // The page's own console, and the service worker's, so a refusal to read the document is
  // visible rather than only its symptom.
  for (const worker of context.serviceWorkers()) {
    worker.on('console', (message) => log('worker', `${message.type()}: ${message.text()}`));
  }
  context.on('serviceworker', (worker) => {
    worker.on('console', (message) => log('worker', `${message.type()}: ${message.text()}`));
  });
  context.on('page', (page) => {
    page.on('console', (message) => log('page', `${message.type()}: ${message.text()}`));
  });

  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  worker.on('console', (message) => log('worker', `${message.type()}: ${message.text()}`));
  return { context, id: new URL(worker.url()).host, worker };
}

/**
 * The popup page, used as the extension's own context to send messages from.
 *
 * The bench needs one page that is an extension page, because only an extension page has the
 * `chrome` API the bench calls. The PDF tab is not one — Chrome hands a PDF to its own viewer
 * — so everything the bench asks the extension goes through here.
 */
async function controlPage(context: BrowserContext, id: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.waitForTimeout(300);
  return page;
}

/**
 * Grants the extension the bench server's origin, the way a reader would.
 *
 * `chrome.permissions.request` only succeeds inside a user gesture, and `activeTab` — the
 * grant a toolbar click produces — cannot be simulated by a script. So the bench asks for the
 * same optional host permission the "always translate this site" switch asks for, from a real
 * click on a button in an extension page. Everything after that is the product's own path.
 */
async function grantOrigin(control: Page, origin: string): Promise<void> {
  await control.evaluate((pattern) => {
    const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
    const button = document.createElement('button');
    button.id = 'grant';
    button.textContent = 'grant';
    button.style.position = 'fixed';
    button.style.inset = '0 auto auto 0';
    button.addEventListener('click', () => {
      void chrome.permissions.request({ origins: [pattern] });
    });
    document.body.append(button);
  }, `${origin}/*`);
  await control.click('#grant');
  await control.waitForTimeout(500);
  const granted = await control.evaluate(async (pattern) => {
    const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
    return { contains: await chrome.permissions.contains({ origins: [pattern] }) };
  }, `${origin}/*`);
  log('pdf', `origin grant: ${JSON.stringify(granted)}`);
}

async function call<T>(page: Page, message: unknown): Promise<T> {
  return page.evaluate(async (payload) => {
    const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
    return (await chrome.runtime.sendMessage(payload)) as unknown;
  }, message) as Promise<T>;
}

/**
 * Makes the model present, and returns whether that took a download.
 *
 * The check is the engine's own status: a profile that already has the model reports `ready`
 * or `loaded`, and nothing is requested. That is the point of the persistent profile — the
 * 546 MB file is fetched once on this machine and loaded from disk afterwards.
 */
async function prepareModel(
  control: Page,
  threads: string,
  tier: 'auto' | 'g' | 'c8' | 'c4' = 'g',
): Promise<boolean> {
  const resolvedTier = tier === 'auto' ? (threads === '4' ? 'c4' : 'c8') : tier;
  await control.evaluate(async (stored) => {
    const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
    await chrome.storage.local.set({ settings: stored, siteRules: {} });
  }, settings(resolvedTier));
  // Apply the tier before any load: `engine:status` may start the model, and a profile that
  // last ran on CPU would otherwise stay on CPU for the whole first warm.
  await call(control, { type: 'engine:tier', tier: resolvedTier });

  const status = await call<{ model?: { state?: string; progress?: number } }>(control, {
    type: 'engine:status',
  });
  const state = status?.model?.state ?? 'absent';
  log('pdf', `model in this profile: ${state}`);
  const present = state === 'ready' || state === 'loaded' || state === 'loading';
  if (present) return false;

  const started = Date.now();
  const accepted = await call<boolean>(control, {
    type: 'model:download',
    modelId: 'plamo-3-translate-0.8b-q4_k_m',
  });
  if (accepted !== true) throw new Error('The model download was refused.');

  for (;;) {
    const next = await call<{ model?: { state?: string; progress?: number; error?: string } }>(
      control,
      { type: 'engine:status' },
    );
    const current = next?.model?.state ?? 'unknown';
    process.stdout.write(
      `\rmodel ${current} ${String(Math.round((next?.model?.progress ?? 0) * 100))}%   `,
    );
    if (current === 'ready' || current === 'loaded') break;
    if (current === 'error') throw new Error(next?.model?.error ?? 'The model download failed.');
    if (Date.now() - started > 10 * 60_000) throw new Error('The model download timed out.');
    await new Promise((done) => setTimeout(done, 1500));
  }
  process.stdout.write('\n');
  return true;
}

function reportOf(page: PageReport[]): string {
  const header = [
    '| page | blocks | translated | failed | shrunk | clipped | uncovered | overlap | cut off | median size |',
    '| ---- | ------ | ---------- | ------ | ------ | ------- | --------- | ------- | ------- | ----------- |',
  ];
  const rows = page.map(
    (entry) =>
      `| ${String(entry.page + 1)} | ${String(entry.blocks)} | ${String(entry.translated)} | ${String(entry.failed)} | ${String(entry.shrunk)} | ${String(entry.clipped)} | ${String(entry.uncovered)} | ${String(entry.overlaps)} | ${String(entry.cutOff)} | ${(entry.medianScale * 100).toFixed(0)}% |`,
  );
  return [...header, ...rows].join('\n');
}

async function main(): Promise<void> {
  const threads = arg('--threads') ?? '8';
  const fixture = arg('--page') ?? 'paper';
  const external = arg('--file');
  /**
   * The engine tier to measure. GPU is the default because it is what the extension actually
   * uses on a machine that supports it, and a CPU run measures a path most readers never take.
   * `--tier c8` forces the CPU for a comparison against a machine without WebGPU.
   */
  const tier = arg('--tier') ?? 'g';
  const fileName =
    external !== undefined ? basename(external) : fixture === 'scan' ? 'scan.pdf' : 'paper.pdf';

  await ensureModel(MODEL_PATH);
  const extension = await stageExtension('.output/chrome-mv3');
  if (!existsSync(join(extension, 'manifest.json'))) {
    throw new Error('No built extension. Run "pnpm bench:build:live" first.');
  }

  // A PDF given as `--file` is served from its own directory, so a local file outside the
  // tree can be measured with the same harness. Everything else is served from the committed
  // fixtures.
  const directory = external !== undefined ? resolve(external, '..') : FIXTURES;
  const server = await startStaticServer({ directory, isolated: false });
  const { context, id } = await launch(extension);
  await routeModel(context, MODEL_PATH);

  try {
    const control = await controlPage(context, id);
    const downloaded = await prepareModel(control, threads, tier as 'auto' | 'g' | 'c8' | 'c4');
    const copies = await modelCopies();
    if (copies > 1) {
      log(
        'pdf',
        `warning: the profile holds ${String(copies)} copies of the model; a build was loaded from another path`,
      );
    }
    await grantOrigin(control, server.origin);

    // The model is warmed before the reader opens, so the run measures translation rather than
    // the load, and the translation cache is cleared unless the run is about a warm cache —
    // a cached page translates instantly and would hide the cost of the model.
    const warmStarted = Date.now();
    await call(control, { type: 'engine:warm' });
    const warmMs = Date.now() - warmStarted;
    if (!has('--keep-cache')) await call(control, { type: 'cache:clear' });

    // Which backend actually ran. A machine without WebGPU silently falls back to the CPU, and
    // a run labelled "g" would then report CPU timings as GPU ones — the number is only worth
    // reading if it says what produced it.
    const engineStatus = await call<{
      backend?: string | null;
      engineSource?: string | null;
      threads?: number | null;
      plamoReady?: boolean;
    }>(control, { type: 'engine:status' });
    log(
      'pdf',
      `backend: ${engineStatus?.backend ?? 'unknown'} (${engineStatus?.engineSource ?? '?'}), threads: ${String(engineStatus?.threads ?? '?')}`,
    );
    if (engineStatus?.backend !== 'webgpu') {
      log(
        'pdf',
        `warning: the run asked for tier ${tier} but the engine is on ${engineStatus?.backend ?? 'unknown'}; these timings are not GPU timings`,
      );
    }

    // The harness cannot produce the `activeTab` grant a toolbar click makes, so it names the
    // document and grants the bench server's origin through the permissions prompt. The
    // product's own path — the popup's message with no URL — is what a reader exercises.
    const opened = await control.evaluate(
      async ({ url, pages }) => {
        const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
        const tabs = await chrome.tabs.query({});
        const tabId = tabs[0]?.id ?? 0;
        const response: unknown = await chrome.runtime.sendMessage({
          type: 'pdf:open',
          tabId,
          url,
          pages,
        });
        return JSON.stringify(response);
      },
      { url: `${server.origin}/${fileName}`, pages: Number(arg('--pages') ?? '0') },
    );
    log('pdf', `open: ${String(opened)}`);
    if (!String(opened).includes('"opened":true')) {
      throw new Error(`The reader did not open: ${String(opened)}`);
    }

    await new Promise((done) => setTimeout(done, 1500));
    const reader = context.pages().find((entry) => entry.url().includes('reader.html'));
    if (!reader) throw new Error('The reader tab did not open.');
    // The reader stops parsing while its tab is hidden, because a reader who switched away is
    // not waiting for pages. The bench has no reader, so it brings the tab to the front; a
    // background tab would leave the run waiting on a document that never advances.
    await reader.bringToFront();
    reader.on('console', (message) => {
      if (message.type() === 'error') log('reader', message.text());
    });

    const translateStarted = Date.now();
    const deadline = translateStarted + 15 * 60_000;
    // `--pages` bounds the run: a long survey is 40+ pages and a reader checks the first few.
    // The reader was told the same limit, so `wanted` is the number of pages it will parse.
    const translateLimit = Number(arg('--pages') ?? '0');
    let summary: { blocks: number; done: number; pages: number; total: number } | null = null;
    for (;;) {
      // Playwright runs this callback in the page. Node helpers are not in that scope, so
      // coverage states come back as data and `pdfBenchFinishedCount` runs here.
      const snapshot = await reader.evaluate((limit) => {
        const api = (globalThis as { __sakuttoPdf?: ReaderApi }).__sakuttoPdf;
        if (!api) return null;
        const parsed = api.parsedPages().slice(0, limit > 0 ? limit : undefined);
        const all = parsed.flatMap((index) => api.coverage(index));
        return {
          pages: parsed.length,
          total: document.querySelectorAll('.sakutto-page').length,
          entries: all.map((entry) => ({ state: entry.state, translation: entry.translation })),
        };
      }, translateLimit);
      if (snapshot) {
        summary = {
          pages: snapshot.pages,
          total: snapshot.total,
          blocks: snapshot.entries.length,
          done: pdfBenchFinishedCount(snapshot.entries),
        };
        const wanted = translateLimit > 0 ? Math.min(translateLimit, summary.total) : summary.total;
        if (summary.pages >= wanted && summary.done >= summary.blocks) break;
      }
      if (Date.now() > deadline) break;
      await new Promise((done) => setTimeout(done, 3000));
    }
    const translateMs = Date.now() - translateStarted;

    const report = await reader.evaluate((limit) => {
      const api = (globalThis as { __sakuttoPdf?: ReaderApi }).__sakuttoPdf;
      if (!api) return [];
      const parsed = api.parsedPages();
      const hosts = [...document.querySelectorAll('.sakutto-page')];
      return (limit > 0 ? parsed.slice(0, limit) : parsed).map((index) => {
        const entries = api.coverage(index);
        const drawn = entries.filter((entry) => entry.drawn !== null);
        const ratios = drawn
          .map((entry) => (entry.fittedSize === null ? 1 : entry.fittedSize / entry.fontSize))
          .sort((left, right) => left - right);
        const middle = ratios[Math.floor(ratios.length / 2)] ?? 1;

        // What a reader actually sees: two boxes on top of each other, or a box whose text is
        // taller than the box. Both are measured from the rendered DOM rather than from the
        // fit, because a layout bug shows up as a box that was placed where the fit said it
        // could not be.
        const host = hosts[index];
        const boxes = host ? [...host.querySelectorAll<HTMLElement>('.sakutto-cover')] : [];
        const rects = boxes.map((node) => node.getBoundingClientRect());
        let overlaps = 0;
        const pairs: string[] = [];
        for (let a = 0; a < rects.length; a += 1) {
          const left = rects[a];
          if (!left) continue;
          for (let b = a + 1; b < rects.length; b += 1) {
            const right = rects[b];
            if (!right) continue;
            const overlapX = Math.min(left.right, right.right) - Math.max(left.left, right.left);
            const overlapY = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
            if (overlapX <= 2 || overlapY <= 2) continue;
            overlaps += 1;
            // The two boxes and their source boxes, so a report says which blocks collided and
            // by how much rather than only how many did.
            const leftNode = boxes[a];
            const rightNode = boxes[b];
            pairs.push(
              `${String(Math.round(overlapX))}x${String(Math.round(overlapY))} ` +
                `[${leftNode?.dataset.source ?? '?'} ${JSON.stringify(leftNode?.textContent?.slice(0, 24) ?? '')}] ` +
                `x [${rightNode?.dataset.source ?? '?'} ${JSON.stringify(rightNode?.textContent?.slice(0, 24) ?? '')}]`,
            );
          }
        }
        const cutOff = boxes.filter(
          (node) =>
            node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2,
        ).length;

        return {
          page: index,
          blocks: entries.length,
          translated: entries.filter((entry) => entry.translation.trim().length > 0).length,
          failed: entries.filter((entry) => entry.state === 'failed').length,
          shrunk: entries.filter(
            (entry) => entry.fittedSize !== null && entry.fittedSize < entry.fontSize * 0.75,
          ).length,
          clipped: entries.filter((entry) => entry.fits === false).length,
          uncovered: entries.filter(
            (entry) => entry.translation.trim().length > 0 && entry.drawn === null,
          ).length,
          overlaps,
          /** The overlapping pairs, so a report names them rather than only counting them. */
          overlapPairs: pairs.slice(0, 8),
          cutOff,
          medianScale: middle,
          samples: entries.slice(0, 4).map((entry) => ({
            role: entry.role,
            scale:
              entry.fittedSize === null
                ? '-'
                : `${(entry.fittedSize / entry.fontSize).toFixed(2)}×`,
            lines: entry.lines,
            en: entry.sourceText.slice(0, 48),
            ja: entry.translation.replace(/\s+/gu, ' ').slice(0, 48),
          })),
        };
      });
    }, translateLimit);

    const total = report.reduce((sum, entry) => sum + entry.blocks, 0);
    const translated = report.reduce((sum, entry) => sum + entry.translated, 0);
    const failed = report.reduce((sum, entry) => sum + entry.failed, 0);
    const uncovered = report.reduce((sum, entry) => sum + entry.uncovered, 0);
    const overlaps = report.reduce((sum, entry) => sum + entry.overlaps, 0);
    const cutOff = report.reduce((sum, entry) => sum + entry.cutOff, 0);

    const run: RunReport = {
      fixture: fileName,
      threads: Number(threads),
      pages: report.length,
      blocks: total,
      translated,
      failed,
      uncovered,
      modelDownloaded: downloaded,
      modelCopies: copies,
      warmMs,
      translateMs,
      reader: report,
    };

    console.log('');
    console.log(`PDF bench — ${fileName}, ${threads} threads`);
    console.log(
      `${String(run.pages)} pages, ${String(total)} blocks, ${String(translated)} translated, ` +
        `${String(failed)} failed, ${String(uncovered)} uncovered, ` +
        `${String(overlaps)} overlapping, ${String(cutOff)} cut off`,
    );

    // The overlapping pairs, printed rather than only counted: a number says the layout is
    // wrong, and these say which two blocks and where.
    if (overlaps > 0) {
      console.log('');
      console.log('overlapping pairs:');
      for (const entry of report) {
        for (const pair of entry.overlapPairs) {
          console.log(`  page ${String(entry.page + 1)}: ${pair}`);
        }
      }
    }
    console.log(
      `model ${downloaded ? 'downloaded' : 'loaded from the profile'} in ${(warmMs / 1000).toFixed(1)}s; ` +
        `translation ${(translateMs / 1000).toFixed(1)}s; ` +
        `${String(copies)} ${copies === 1 ? 'copy' : 'copies'} of the model on disk`,
    );
    console.log('');
    console.log(reportOf(report));

    await mkdir(OUT, { recursive: true });
    const label = external !== undefined ? basename(external, '.pdf') : fixture;
    await writeFile(join(OUT, `${label}-${threads}t.json`), `${JSON.stringify(run, null, 2)}\n`);

    // Screenshot the page the caller asked about, so a page of equations can be looked at
    // rather than only counted. `--shot-page` defaults to the first page.
    const shotPage = Number(arg('--shot-page') ?? '1');
    const shotHost = await reader.evaluate((page) => {
      const host = document.querySelector<HTMLElement>(
        `.sakutto-page[data-page="${String(page - 1)}"]`,
      );
      if (!host) return null;
      host.scrollIntoView({ block: 'start' });
      const rect = host.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }, shotPage);
    await new Promise((done) => setTimeout(done, 600));
    await reader.screenshot({
      path: join(ROOT, 'bench/.cache', `pdf-${label}-page${String(shotPage)}.png`),
      ...(shotHost && shotHost.width > 0 && shotHost.height > 0
        ? {
            clip: {
              x: Math.max(0, shotHost.left),
              y: Math.max(0, shotHost.top),
              width: shotHost.width,
              height: Math.min(shotHost.height, 1600),
            },
          }
        : {}),
    });
  } finally {
    await context.close();
    await server.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
