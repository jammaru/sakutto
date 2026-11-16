/**
 * A smoke test of the shipped build: load it as a user would, translate a page with the real
 * model, and open a PDF. The build under test is `.output/chrome-mv3` with no test flags.
 *
 *   node scripts/bench/smoke-build.mjs [--pdf path]
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const EXTENSION = resolve(ROOT, '.output/chrome-mv3');
const PROFILE = resolve(ROOT, 'bench/.cache/smoke-profile');
const MODEL = resolve(ROOT, 'bench/.cache/plamo-3-translate-0.8b-Q4_K_M.gguf');
const PAGES = resolve(ROOT, 'bench/pages');
const PDF_DIR = resolve(ROOT, 'bench/.cache/papers');
const PORT = 4185;

const pdfIndex = process.argv.indexOf('--pdf');
const pdfName = pdfIndex === -1 ? null : process.argv[pdfIndex + 1];

if (!existsSync(join(EXTENSION, 'manifest.json'))) {
  throw new Error('No build. Run "pnpm build" first.');
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const name = url.pathname.replace(/^\//, '');
  const base = name.toLowerCase().endsWith('.pdf') ? PDF_DIR : PAGES;
  try {
    const body = await readFile(join(base, name));
    const type = name.toLowerCase().endsWith('.pdf')
      ? 'application/pdf'
      : 'text/html; charset=utf-8';
    response.writeHead(200, { 'content-type': type, 'content-length': body.length });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(PORT, '127.0.0.1', done));

await mkdir(PROFILE, { recursive: true });
const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    '--no-first-run',
    '--disable-component-update',
  ],
});

// The model is served from the copy on disk so the smoke test does not download 546 MB. The
// extension still verifies the file against its pinned SHA-256, exactly as it does online.
if (existsSync(MODEL)) {
  await context.route('**/plamo-3-translate-0.8b-Q4_K_M.gguf*', async (route) => {
    await route.fulfill({
      path: MODEL,
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
        'content-type': 'application/octet-stream',
      },
    });
  });
} else {
  console.log('note: no cached model, the download will use the network');
}

const worker =
  context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
const id = new URL(worker.url()).host;
console.log(`extension loaded: ${id}`);

const control = await context.newPage();
await control.goto(`chrome-extension://${id}/onboarding.html`);

// Accept the licence, which is the one thing a reader must do before the model will load.
await control.evaluate(async () => {
  await chrome.storage.local.set({
    siteRules: {},
    settings: {
      schemaVersion: 1,
      targetLanguage: 'ja',
      form: 'polite',
      display: 'replace',
      consent: {
        license: 'plamo-community',
        version: '2026-11-05',
        notice: '2026-11-06',
        acceptedAt: new Date().toISOString(),
        ageNoticeShown: true,
      },
      highQualityDismissed: true,
      glossary: [],
      idleMinutes: 15,
      tier: 'c8',
      pace: 'quality',
    },
  });
});

const call = async (message) => {
  const reply = await control.evaluate(
    async (payload) => await chrome.runtime.sendMessage(payload),
    message,
  );
  return reply;
};

// Grant the fixture origin, the way "always translate this site" does.
await control.evaluate((pattern) => {
  const button = document.createElement('button');
  button.id = 'grant';
  button.addEventListener('click', () => void chrome.permissions.request({ origins: [pattern] }));
  document.body.append(button);
}, `http://127.0.0.1:${PORT}/*`);
await control.click('#grant');

console.log('preparing the model (first run downloads it)…');
const accepted = await call({ type: 'model:download', modelId: 'plamo-3-translate-0.8b-q4_k_m' });
if (accepted !== true) throw new Error('the model download was refused');
for (;;) {
  const status = await call({ type: 'engine:status' });
  const state = status?.model?.state ?? 'unknown';
  process.stdout.write(
    `\rmodel ${state} ${String(Math.round((status?.model?.progress ?? 0) * 100))}%   `,
  );
  if (state === 'ready' || state === 'loaded') break;
  if (state === 'error') throw new Error(status?.model?.error ?? 'the model failed');
  await new Promise((done) => setTimeout(done, 1500));
}
process.stdout.write('\n');
await call({ type: 'engine:warm' });

// 1. A page, translated the way the popup and the shortcut do it.
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${PORT}/long-article.html`);
await page.waitForTimeout(500);
const pageTabId = await control.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
  return tabs[0]?.id ?? null;
});
await control.evaluate(async (tabId) => {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['/content-scripts/content.js'],
  });
  await chrome.tabs.sendMessage(tabId, { type: 'page:command', command: 'toggle' });
}, pageTabId);
await page.waitForFunction(
  () => document.documentElement.dataset.sakuttoState === 'translated',
  null,
  {
    timeout: 180_000,
  },
);
const state = await page.evaluate(() => ({
  state: document.documentElement.dataset.sakuttoState,
  progress: document.documentElement.dataset.sakuttoProgress,
  sample: document.querySelector('[data-sakutto-id]')?.textContent?.slice(0, 40) ?? null,
}));
console.log(`page: ${state.state} ${state.progress ?? ''} :: ${state.sample ?? ''}`);

// 2. A PDF, through the popup's own message.
if (pdfName !== null) {
  const before = new Set(context.pages().map((entry) => entry.url()));
  const opened = await control.evaluate(
    async ({ url, pages }) => {
      const tabs = await chrome.tabs.query({});
      return await chrome.runtime.sendMessage({
        type: 'pdf:open',
        tabId: tabs[0]?.id ?? 0,
        url,
        pages,
      });
    },
    { url: `http://127.0.0.1:${PORT}/${pdfName}`, pages: 2 },
  );
  console.log(`pdf open: ${JSON.stringify(opened)}`);
  await new Promise((done) => setTimeout(done, 2500));
  const reader = context
    .pages()
    .find((entry) => !before.has(entry.url()) && entry.url().includes('reader'));
  if (reader) {
    for (;;) {
      const done = await reader.evaluate(() => {
        const api = globalThis.__sakuttoPdf;
        if (!api) return false;
        const pages = api.parsedPages().slice(0, 2);
        if (pages.length < 2) return false;
        return pages
          .flatMap((index) => api.coverage(index))
          .every((entry) => entry.translation.trim() || entry.state === 'failed');
      });
      if (done) break;
      await new Promise((done2) => setTimeout(done2, 2500));
    }
    const report = await reader.evaluate(() => {
      const api = globalThis.__sakuttoPdf;
      const entries = api
        .parsedPages()
        .slice(0, 2)
        .flatMap((index) => api.coverage(index));
      return {
        blocks: entries.length,
        translated: entries.filter((entry) => entry.translation.trim()).length,
        failed: entries.filter((entry) => entry.state === 'failed').length,
        first: entries[0]?.translation.replace(/\s+/gu, ' ').slice(0, 60) ?? null,
      };
    });
    console.log(
      `pdf: ${String(report.translated)}/${String(report.blocks)} translated, ${String(report.failed)} failed :: ${report.first ?? ''}`,
    );
    await reader.screenshot({ path: resolve(ROOT, 'bench/.cache/smoke-pdf.png') });
  }
}

console.log('smoke test passed');
await context.close();
server.close();
