/**
 * Fast layout-only check for the PDF reader.
 *
 *   pnpm bench:pdf:layout
 *   pnpm bench:pdf:layout --file path/to/local.pdf
 *
 * No model is loaded. Each translatable block is replaced with a deterministic Japanese-shaped
 * expansion (`stubExpand`) and fitted with the same grow, shrink and overlap rules the reader
 * uses. The run prints per-page overlap, minimum type size, withheld boxes, and the share of
 * prose that received a box — the numbers CI asserts on synthetic pages in unit tests.
 *
 * Timing: this path is the one that should stay under a few seconds for the committed
 * fixtures. The real-model bench (`pnpm bench:pdf`) is the slow path; it samples pages and
 * reuses the translation cache in the browser profile (`--keep-cache`).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { rotatedBodyPdf } from './rotated-body-pdf.ts';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const fileArg = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1]
  : undefined;
const files = fileArg
  ? [resolve(fileArg)]
  : [resolve(ROOT, 'bench/pdf/paper.pdf'), resolve(ROOT, 'bench/pdf/scan.pdf')];

const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjs = await import(pathToFileURL(pdfjsPath).href);
const standardFontDataUrl = pathToFileURL(
  resolve(dirname(pdfjsPath), '..', '..', 'standard_fonts') + '/',
).href;

const { extractPage } = (await import(pathToFileURL(resolve(ROOT, 'src/pdf/extract.ts')).href)) as {
  extractPage: (
    page: unknown,
    index: number,
    ops: Record<string, number> | null,
  ) => Promise<{
    width: number;
    height: number;
    lines: unknown[];
    figures: { images?: unknown[] };
    empty: boolean;
  }>;
};
const { layoutPage, orphanLineCount } = (await import(
  pathToFileURL(resolve(ROOT, 'src/pdf/layout.ts')).href
)) as {
  layoutPage: (
    lines: unknown[],
    figures: unknown,
    page?: { width: number; height: number; index?: number },
  ) => {
    blocks: Array<{
      text: string;
      role: string;
      fontSize: number;
      box: object;
      room: object;
      lineHeight: number;
      lines?: unknown[];
    }>;
    skipped: Array<{ lines?: unknown[] }>;
    bodySize: number;
    pageHeight: number;
    pageWidth?: number;
    pageIndex?: number;
    obstacles?: unknown[];
  };
  orphanLineCount: (extracted: unknown[], layout: unknown) => number;
};
const { placePage, clippedPaintWidth, verticalCut } = (await import(
  pathToFileURL(resolve(ROOT, 'src/pdf/place.ts')).href
)) as {
  placePage: (request: {
    layout: unknown;
    translationOf: (block: { text: string }) => string;
    target: 'ja';
    measure: (block: unknown, text: string, fontSize: number) => number;
    pageHeight: number;
    pageWidth?: number;
  }) => Array<{
    paint: boolean;
    overflow: boolean;
    translation: string;
    fit: { lines: string[]; fontSize: number; width: number; height: number } | null;
    drawn: { width: number; height: number } | null;
    block: { writing?: number; box: { width: number; height: number }; fontSize: number };
  }>;
  clippedPaintWidth: (
    entry: {
      paint: boolean;
      fit: { lines: string[]; fontSize: number; width: number } | null;
      drawn: { width: number } | null;
      block: { writing?: number };
    },
    measure: (text: string, fontSize: number) => number,
  ) => number;
  verticalCut: (entry: {
    paint: boolean;
    fit: { height: number } | null;
    drawn: { width: number; height: number } | null;
    block: { writing?: number; box: { width: number; height: number }; fontSize: number };
  }) => number;
};
const { pageMetrics, metricsPass } = (await import(
  pathToFileURL(resolve(ROOT, 'src/pdf/metrics.ts')).href
)) as {
  pageMetrics: (
    layout: unknown,
    placed: unknown[],
    pageBox: object,
  ) => {
    blocks: number;
    skipped: number;
    painted: number;
    withheld: number;
    overflowed: number;
    overlapPairs: number;
    overlapArea: number;
    minFontSize: number | null;
    prosePainted: number;
    proseCovered: number;
    nonProsePainted: number;
    overflow: number;
  };
  metricsPass: (metrics: {
    overlapPairs: number;
    proseCovered: number;
    nonProsePainted: number;
    overflow: number;
    minFontSize: number | null;
  }) => boolean;
};
const { stubExpand } = (await import(pathToFileURL(resolve(ROOT, 'src/pdf/stub.ts')).href)) as {
  stubExpand: (text: string) => string;
};

function measure(text: string, size: number): number {
  let cjk = 0;
  for (const character of text) {
    if (
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)
    ) {
      cjk += 1;
    }
  }
  return cjk * size + (text.length - cjk) * size * 0.5;
}

const started = Date.now();
const reports: object[] = [];
let failed = false;
const pagesFlag = process.argv.indexOf('--pages');
const pageLimit = pagesFlag >= 0 ? Number(process.argv[pagesFlag + 1] ?? '0') : 0;

async function checkBytes(name: string, bytes: Uint8Array): Promise<void> {
  const doc = await pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    isEvalSupported: false,
    standardFontDataUrl,
  }).promise;
  const last = pageLimit > 0 ? Math.min(pageLimit, doc.numPages) : doc.numPages;
  console.log(`${name}: ${String(doc.numPages)} pages, checking ${String(last)}`);

  for (let number = 1; number <= last; number += 1) {
    const page = await doc.getPage(number);
    const extracted = await extractPage(page, number - 1, pdfjs.OPS);
    const layout = extracted.empty
      ? {
          blocks: [],
          skipped: [],
          bodySize: 0,
          pageHeight: extracted.height,
          pageWidth: extracted.width,
          pageIndex: number - 1,
          obstacles: extracted.figures.images ?? [],
        }
      : layoutPage(extracted.lines, extracted.figures, {
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
    let clipped = 0;
    let vCut = 0;
    for (const entry of placed) {
      clipped += clippedPaintWidth(entry, (text, size) => measure(text, size));
      vCut += verticalCut(entry);
    }
    const orphans = extracted.empty ? 0 : orphanLineCount(extracted.lines, layout);
    const pass =
      (extracted.empty ? metrics.painted === 0 : metricsPass(metrics)) &&
      clipped <= 0.01 &&
      vCut <= 0.5 &&
      orphans === 0;
    if (!pass) failed = true;
    console.log(
      `  page ${String(number)}: ${extracted.empty ? 'image-only' : 'text'}  ` +
        `lines=${String(extracted.lines.length)} body=${String(layout.bodySize)} ` +
        `blocks=${String(metrics.blocks)} painted=${String(metrics.painted)} ` +
        `skipped=${String(metrics.skipped)} withheld=${String(metrics.withheld)} ` +
        `overlap=${String(metrics.overlapPairs)} minpt=${metrics.minFontSize === null ? '-' : metrics.minFontSize.toFixed(1)} ` +
        `prose=${(metrics.prosePainted * 100).toFixed(0)}% cover=${(metrics.proseCovered * 100).toFixed(0)}% ` +
        `overflowed=${String(metrics.overflowed)} clipped=${clipped.toFixed(1)} vCut=${vCut.toFixed(1)} ` +
        `orphans=${String(orphans)} ${pass ? 'ok' : 'FAIL'}`,
    );
    reports.push({
      file: name,
      page: number,
      empty: extracted.empty,
      lines: extracted.lines.length,
      bodySize: layout.bodySize,
      ...metrics,
      orphans,
      pass,
    });
  }
  await doc.destroy();
}

for (const file of files) {
  await checkBytes(basename(file), new Uint8Array(await readFile(file)));
}
if (!fileArg) {
  await checkBytes('rotated.pdf', rotatedBodyPdf([90, 270]));
}

const elapsed = Date.now() - started;
console.log(`layout-only ${String(elapsed)}ms`);
const outDir = resolve(ROOT, 'bench/results/pdf');
await mkdir(outDir, { recursive: true });
await writeFile(
  resolve(outDir, 'layout-only.json'),
  `${JSON.stringify({ elapsedMs: elapsed, reports }, null, 2)}\n`,
);
if (failed) process.exitCode = 1;
