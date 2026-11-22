/**
 * Real-OCR overlay check for bench/pdf/scan.pdf page 1.
 *
 * Renders the scan at several DPIs in Chromium, runs the shipped PP-OCRv6 pipeline with a chosen
 * preprocessing variant, feeds the result through the reader's OCR layout and placement, and
 * measures what a reader would see. No model download beyond the pinned bench models.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

import { decodePngImage, loadPairing } from './ocr-engine.ts';
import { applyOcrPreprocess, type OcrPreprocessStep } from '../../src/engine/ocr/preprocess.ts';
import { OcrPipeline } from '../../src/engine/ocr/pipeline.ts';
import { startStaticServer } from './static.ts';
import { characterErrorRate, wordErrorRate } from './ocr-metrics.ts';
import { extractPage } from '../../src/pdf/extract.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, 'bench/results/scan-ocr');
const requireModule = createRequire(import.meta.url).resolve;
const VIEWER = '/scripts/bench/pdf-quality-view.html';
const PDF = 'bench/pdf/scan.pdf';

async function loadPdf<T>(name: string): Promise<T> {
  return (await import(fileURLToPath(new URL('../../src/pdf/' + name, import.meta.url)))) as T;
}

interface Layout {
  blocks: Array<{ text: string; role: string; box: object; room: object; fontSize: number; lineHeight: number; column: number; advance: number; writing: number; lines: unknown[] }>;
  skipped: Array<{ text: string; role: string; box: object }>;
  obstacles: object[];
  bodySize: number;
}

async function renderPage(
  page: import('@playwright/test').Page,
  origin: string,
  scale: number,
): Promise<{ png: Buffer; width: number; height: number }> {
  const info = (await page.evaluate(async (data) => {
    await (globalThis as unknown as {
      __renderPdf: (value: { url: string; page: number; scale: number; overlays: unknown[] }) => Promise<unknown>;
    }).__renderPdf({ url: data.url, page: 1, scale: data.scale, overlays: [] });
    const canvas = document.querySelector<HTMLCanvasElement>('#sheet canvas');
    return { width: canvas?.width ?? 0, height: canvas?.height ?? 0 };
  }, { url: origin + '/' + PDF, scale })) as { width: number; height: number };
  const png = await page.locator('#sheet canvas').screenshot();
  return { png, width: info.width, height: info.height };
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await startStaticServer({ directory: ROOT, isolated: false });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const loaded = await loadPairing('tiny_det+small_rec');
  const pdfjsPath = requireModule('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await import(pdfjsPath);
  const paperBytes = await readFile(resolve(ROOT, 'bench/pdf/paper.pdf'));
  const paperDoc = await pdfjs.getDocument({ data: new Uint8Array(paperBytes), useSystemFonts: false }).promise;
  const paperPage = await paperDoc.getPage(1);
  const reference = (await extractPage(paperPage, 0, pdfjs.OPS)).lines.map((line) => line.text).join('\n');
  await paperDoc.destroy();
  const { ocrResultToPageLayout } = await loadPdf<{
    ocrResultToPageLayout: (
      result: unknown,
      options: { pageIndex: number; pageWidth: number; pageHeight: number; imageWidth: number; imageHeight: number },
    ) => Layout;
  }>('ocr.ts');
  const { placePage, paintedCoverOverlaps } = await loadPdf<{
    placePage: (request: object) => Array<{ paint: boolean; drawn: object | null; translation: string; fit: { fontSize: number } | null; block: { text: string; role: string; box: { x: number; y: number; width: number; height: number }; fontSize: number } }>;
    paintedCoverOverlaps: (placed: unknown[], pageWidth: number) => number;
  }>('place.ts');
  const { pageMetrics } = await loadPdf<{
    pageMetrics: (layout: Layout, placed: unknown[], page: object) => { crossColumnCovers: number; proseCovered: number; overlapPairs: number; overflow: number };
  }>('metrics.ts');
  const report: object[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1500 } });
    await page.goto(server.origin + VIEWER);
    await page.waitForFunction('window.__pdfReady === true', null, { timeout: 20_000 });
    const variants: Array<{ id: string; scale: number; steps: readonly OcrPreprocessStep[]; maxSide: number }> = [
      { id: 'baseline-1x', scale: 1, steps: [], maxSide: 960 },
      { id: 'dpi200', scale: 4 / 3, steps: [], maxSide: 1280 },
      // The actual pre-change shipped path: reader renders at 2x, detector capped at 960.
      { id: 'shipped-baseline', scale: 2, steps: [], maxSide: 960 },
      // Current shipped default: the reader renders at 2x and detects at maxSide 1600.
      { id: 'default-1600', scale: 2, steps: [], maxSide: 1600 },
      { id: 'dpi300', scale: 2, steps: [], maxSide: 1920 },
      { id: 'sauvola', scale: 1, steps: ['sauvola'], maxSide: 960 },
      { id: 'dpi200+sauvola', scale: 4 / 3, steps: ['sauvola'], maxSide: 1280 },
      { id: 'dpi200+gray', scale: 4 / 3, steps: ['grayscale'], maxSide: 1280 },
    ];
    for (const variant of variants) {
      const rendered = await renderPage(page, server.origin, variant.scale);
      const path = join(OUT, 'raster-' + variant.id + '.png');
      await writeFile(path, rendered.png);
      const image = await decodePngImage(path);
      const preprocessed = applyOcrPreprocess(image, variant.steps, 1);
      const pipeline = new OcrPipeline({
        runner: loaded.runner,
        dictionary: loaded.dictionary,
        useSpaceChar: true,
        detection: loaded.detection,
        detectionPreprocess: { maxSide: variant.maxSide, multiple: 32 },
        recognitionPreprocess: { height: 48, maxWidth: 4096 },
      });
      const started = performance.now();
      const result = await pipeline.run(preprocessed.image);
      const ms = performance.now() - started;
      const mappedQuads = result.regions.map((region) => ({
        ...region,
        quad: region.quad.map((point) => preprocessed.mapBack(point)),
      }));
      const layout = ocrResultToPageLayout(
        { ...result, regions: mappedQuads, lines: [] },
        { pageIndex: 0, pageWidth: 612, pageHeight: 792, imageWidth: image.width, imageHeight: image.height },
      );
      const placed = placePage({
        layout,
        translationOf: (block: { text: string }) => block.text.replace(/[A-Za-z]+/gu, () => '語'),
        target: 'ja',
        measure: (_block: unknown, text: string, size: number) => text.length * size * 0.7,
        pageHeight: 792,
        pageWidth: 612,
      });
      const metrics = pageMetrics(layout, placed, { x: 0, y: 0, width: 612, height: 792 });
      const overlaps = paintedCoverOverlaps(placed, 612);
      const record = {
        variant: variant.id,
        ms,
        cer: characterErrorRate(reference, result.text).rate,
        wer: wordErrorRate(reference, result.text).rate,
        lines: result.lines.length,
        blocks: layout.blocks.length,
        skipped: layout.skipped.length,
        crossColumnCovers: metrics.crossColumnCovers,
        overlapPairs: Math.max(metrics.overlapPairs, overlaps),
        overflow: metrics.overflow,
        proseCovered: metrics.proseCovered,
        text: result.text.slice(0, 200),
      };
      report.push(record);
      console.log(JSON.stringify(record));
      // Overlay screenshots are produced by pnpm bench:pdf:quality --shots.
    }
    await page.close();
  } finally {
    await loaded.release();
    await browser.close();
    await server.close();
  }
  const header = '| variant | CER | WER | ms | lines | blocks | skipped | cross-column | overlaps | overflow | covered |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |';
  const markdown = ['# scan.pdf page 1 real-OCR overlay', '', header, ...report.map((entry) => {
    const r = entry as Record<string, number | string>;
    return '| ' + r.variant + ' | ' + Number(r.cer).toFixed(3) + ' | ' + Number(r.wer).toFixed(3) + ' | ' + Number(r.ms).toFixed(0) + ' | ' + r.lines + ' | ' + r.blocks + ' | ' + r.skipped + ' | ' + r.crossColumnCovers + ' | ' + r.overlapPairs + ' | ' + r.overflow + ' | ' + Number(r.proseCovered).toFixed(2) + ' |';
  })].join('\n') + '\n';
  await writeFile(join(OUT, 'report.md'), markdown);
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(markdown);
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
