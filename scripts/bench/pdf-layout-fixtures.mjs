/**
 * Layout metrics for local PDF fixtures (not committed). Writes PNG page grabs and JSON.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/bench/register-ts.mjs scripts/bench/pdf-layout-fixtures.mjs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '..', '..');
const OUT = resolve(homedir(), 'png-check');
const FIXTURES = [
  { label: 'paper-a', path: resolve(homedir(), 'pdf-fixtures/paper-a.pdf'), pages: [2, 3, 4] },
  { label: 'paper-b', path: resolve(homedir(), 'pdf-fixtures/paper-b.pdf'), pages: [2, 3, 4, 5] },
];

const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjs = await import(pathToFileURL(pdfjsPath).href);
const { extractPage } = await import(pathToFileURL(resolve(ROOT, 'src/pdf/extract.ts')).href);
const { layoutPage } = await import(pathToFileURL(resolve(ROOT, 'src/pdf/layout.ts')).href);
const { placePage } = await import(pathToFileURL(resolve(ROOT, 'src/pdf/place.ts')).href);
const { pageMetrics, metricsPass } = await import(
  pathToFileURL(resolve(ROOT, 'src/pdf/metrics.ts')).href
);
const { stubExpand } = await import(pathToFileURL(resolve(ROOT, 'src/pdf/stub.ts')).href);

function measure(text, size) {
  let cjk = 0;
  for (const character of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)) cjk += 1;
  }
  return cjk * size + (text.length - cjk) * size * 0.5;
}

const reports = [];
let failed = false;

for (const fixture of FIXTURES) {
  const bytes = new Uint8Array(await readFile(fixture.path));
  const doc = await pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise;
  for (const number of fixture.pages) {
    const page = await doc.getPage(number);
    const extracted = await extractPage(page, number - 1, pdfjs.OPS);
    const layout = layoutPage(extracted.lines, extracted.figures, {
      width: extracted.width,
      height: extracted.height,
      index: number - 1,
    });
    const placed = placePage({
      layout,
      translationOf: (block) => stubExpand(block.text),
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: extracted.height,
      pageWidth: extracted.width,
    });
    const metrics = pageMetrics(layout, placed, {
      x: 0,
      y: 0,
      width: extracted.width,
      height: extracted.height,
    });
    const pass = metricsPass(metrics);
    if (!pass) failed = true;
    const row = { fixture: fixture.label, page: number, pass, ...metrics };
    reports.push(row);
    console.log(
      `${fixture.label} p${String(number)} pass=${pass} uncov=${metrics.uncoveredSourceLines} ` +
        `cross=${metrics.crossColumnCovers} mismatch=${metrics.drawnPaintMismatches} ` +
        `overlap=${metrics.overlapPairs} proseOnly=${(metrics.prosePaintedOnly * 100).toFixed(0)}%`,
    );
  }
  await doc.destroy();
}

await mkdir(OUT, { recursive: true });
await writeFile(resolve(OUT, 'layout-metrics.json'), `${JSON.stringify(reports, null, 2)}\n`);

try {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
  const page = await context.newPage();
  for (const fixture of FIXTURES) {
    for (const number of fixture.pages) {
      const url = `file://${fixture.path}#page=${String(number)}&zoom=page-width`;
      await page.goto(url, { waitUntil: 'load', timeout: 15_000 });
      await page.waitForTimeout(500);
      await page.screenshot({
        path: resolve(OUT, `${fixture.label}-p${String(number)}.png`),
        fullPage: false,
      });
    }
  }
  await browser.close();
} catch (error) {
  console.warn('png screenshots skipped:', error instanceof Error ? error.message : error);
}

if (failed) process.exitCode = 1;
console.log(`wrote ${OUT}`);
