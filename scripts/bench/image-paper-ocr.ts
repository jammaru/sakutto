/**
 * Real-OCR diagnostics for the image-only two-column paper fixture.
 *
 * Renders each page in headless Chromium, runs the shipped OCR pipeline, maps detector quads
 * back to rendered raster coordinates and reports the reader's line grouping, layout columns,
 * placement metrics and per-page timings. With --shots it also writes overlay screenshots.
 *
 *   pnpm bench:image-paper -- --label before --shots
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

import { decodePngImage, loadPairing, type Pairing } from './ocr-engine.ts';
import type { OcrPoint } from '../../src/engine/ocr/types.ts';
import { PdfSession } from '../../src/pdf/session.ts';
import type { PageLayout } from '../../src/pdf/layout.ts';
import { applyOcrPreprocess } from '../../src/engine/ocr/preprocess.ts';
import { OcrPipeline } from '../../src/engine/ocr/pipeline.ts';
import type { OcrQuad, OcrRegion, OcrResult } from '../../src/engine/ocr/types.ts';
import { startStaticServer } from './static.ts';

// The translation half of this bench uses a deterministic fake engine; some shipped modules
// branch on this compile-time flag at call time, so define it for the Node bench too.
(globalThis as unknown as { __SAKUTTO_FAKE_ENGINE__: boolean }).__SAKUTTO_FAKE_ENGINE__ = true;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PDF = 'bench/pdf/image-only-paper.pdf';
const OUT = join(ROOT, 'bench/results/image-paper');
const VIEWER = '/scripts/bench/pdf-quality-view.html';
const requireModule = createRequire(import.meta.url).resolve;
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? (args[index + 1] ?? fallback) : fallback;
};
const label = option('--label', 'run').replace(/[^A-Za-z0-9._-]/gu, '_');
const shots = args.includes('--shots');
const scale = Number(option('--scale', '2'));
const maxSide = Number(option('--max-side', '1600'));
const pairing = option('--pairing', 'tiny_det+small_rec') as Pairing;
const pages = option('--pages', '1,2')
  .split(',')
  .map(Number)
  .filter((n) => n > 0);

function mapResultBack(result: OcrResult, mapBack: (point: OcrPoint) => OcrPoint): OcrResult {
  const mapped = new Map<OcrRegion, OcrRegion>();
  const regions = result.regions.map((region) => {
    const copy: OcrRegion = { ...region, quad: region.quad.map(mapBack) as unknown as OcrQuad };
    mapped.set(region, copy);
    return copy;
  });
  return {
    regions,
    lines: result.lines.map((line) => ({
      orientation: line.orientation,
      indices: line.indices,
      items: line.items.map(
        (item) =>
          mapped.get(item) ??
          ({ ...item, quad: item.quad.map(mapBack) as unknown as OcrQuad } as OcrRegion),
      ),
    })),
    text: result.text,
  };
}

async function loadPdf<T>(name: string): Promise<T> {
  return (await import(fileURLToPath(new URL('../../src/pdf/' + name, import.meta.url)))) as T;
}

interface LayoutLike {
  bodySize: number;
  lineHeight: number;
  pageWidth: number;
  pageHeight: number;
  pageIndex: number;
  blocks: Array<{
    text: string;
    role: string;
    column: number;
    fontSize: number;
    box: { x: number; y: number; width: number; height: number };
    room: { x: number; y: number; width: number; height: number };
  }>;
  skipped: Array<{ text: string; role: string; box: object }>;
  obstacles: object[];
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await startStaticServer({ directory: ROOT, isolated: false });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const loaded = await loadPairing(pairing);
  const pdfjsPath = requireModule('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await import(pdfjsPath);
  const bytes = await readFile(resolve(ROOT, PDF));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false })
    .promise;
  const { ocrResultToTextLines, ocrResultToPageLayout } = await loadPdf<{
    ocrResultToTextLines: (
      r: unknown,
      o: object,
    ) => Array<{
      text: string;
      columnHint?: number;
      titleRow?: boolean;
      box: { x: number; y: number; width: number; height: number };
    }>;
    ocrResultToPageLayout: (r: unknown, o: object) => LayoutLike;
  }>('ocr.ts');
  const { placePage, paintedCoverOverlaps } = await loadPdf<{
    placePage: (r: object) => Array<{
      paint: boolean;
      overflow: boolean;
      translation: string;
      fit: { fontSize: number } | null;
      block: { text: string; role: string; column: number; box: object };
      drawn: object | null;
    }>;
    paintedCoverOverlaps: (placed: unknown[], pageWidth: number) => number;
  }>('place.ts');
  const { pageMetrics } = await loadPdf<{
    pageMetrics: (
      l: unknown,
      p: unknown,
      page: object,
    ) => {
      crossColumnCovers: number;
      overlapPairs: number;
      overflow: number;
      proseCovered: number;
    };
  }>('metrics.ts');

  const report: object[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1700 } });
    await page.goto(server.origin + VIEWER);
    await page.waitForFunction('window.__pdfReady === true', null, { timeout: 20_000 });
    for (const pageNumber of pages) {
      const pdfPage = await doc.getPage(pageNumber);
      const viewport = pdfPage.getViewport({ scale });
      const pageWidth = viewport.width / scale;
      const pageHeight = viewport.height / scale;
      const png = await page.evaluate(
        async (data) => {
          await (
            globalThis as unknown as {
              __renderPdf: (v: {
                url: string;
                page: number;
                scale: number;
                overlays: unknown[];
              }) => Promise<unknown>;
            }
          ).__renderPdf({ url: data.url, page: data.page, scale: data.scale, overlays: [] });
          return null;
        },
        { url: server.origin + '/' + PDF, page: pageNumber, scale },
      );
      void png;
      const rasterPath = join(OUT, 'raster-p' + String(pageNumber) + '.png');
      await writeFile(rasterPath, await page.locator('#sheet canvas').screenshot());
      const image = await decodePngImage(rasterPath);
      const preprocessed = applyOcrPreprocess(image, [], 1);
      const pipeline = new OcrPipeline({
        runner: loaded.runner,
        dictionary: loaded.dictionary,
        useSpaceChar: true,
        detection: loaded.detection,
        detectionPreprocess: { maxSide, multiple: 32 },
        recognitionPreprocess: { height: 48, maxWidth: 4096 },
      });
      await pipeline.run(preprocessed.image);
      const t0 = performance.now();
      const result = await pipeline.run(preprocessed.image);
      const ocrMs = performance.now() - t0;
      const mapped = mapResultBack(result, preprocessed.mapBack);
      const options = {
        pageIndex: pageNumber - 1,
        pageWidth,
        pageHeight,
        imageWidth: image.width,
        imageHeight: image.height,
      };
      const t1 = performance.now();
      const lines = ocrResultToTextLines(mapped, options);
      const layout = ocrResultToPageLayout(mapped, options);
      const layoutMs = performance.now() - t1;
      const placed = placePage({
        layout,
        translationOf: (block: { text: string }) => block.text.replace(/[A-Za-z]+/gu, () => '語'),
        target: 'ja',
        measure: (_b: unknown, text: string, size: number) => text.length * size * 0.7,
        pageWidth,
        pageHeight,
      });
      const metrics = pageMetrics(layout, placed, {
        x: 0,
        y: 0,
        width: pageWidth,
        height: pageHeight,
      });
      // Deterministic fake translation with a macrotask per delta: measures the reader's
      // first-paint/finish plumbing, not model quality or real decoding speed.
      let firstVisibleMs: number | null = null;
      const translateStarted = performance.now();
      let session: PdfSession | null = null;
      session = new PdfSession({
        engine: {
          translate: async function* (segments: readonly { id: string; text: string }[]) {
            for (const segment of segments) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              yield { id: segment.id, textDelta: '訳' };
              await new Promise((resolve) => setTimeout(resolve, 0));
              yield { id: segment.id, final: '翻訳済みの本文です。' };
            }
          },
        },
        targetLanguage: 'ja',
        form: 'polite',
        onChange: () => {
          if (
            firstVisibleMs === null &&
            session?.pageBlocks(pageNumber - 1).some((entry) => entry.paint) === true
          ) {
            firstVisibleMs = performance.now() - translateStarted;
          }
        },
        measure: (text, size) => text.length * size * 0.7,
        concurrency: 8,
      });
      session.addPage(pageNumber - 1, layout as unknown as PageLayout, pageHeight);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && session.progress().pending > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const translateMs = performance.now() - translateStarted;
      session.dispose();
      const record = {
        page: pageNumber,
        ocrMs,
        layoutMs,
        firstVisibleMs,
        translateMs,
        ocrPlusTranslateMs: ocrMs + translateMs,
        pageWidth,
        pageHeight,
        raster: { width: image.width, height: image.height },
        regions: mapped.regions.length,
        lines: lines.map((line) => ({
          text: line.text,
          column: line.columnHint ?? null,
          titleRow: line.titleRow ?? false,
          box: line.box,
        })),
        blocks: layout.blocks.map((block) => ({
          text: block.text,
          role: block.role,
          column: block.column,
          box: block.box,
          room: block.room,
          fontSize: block.fontSize,
        })),
        skipped: layout.skipped.map((block) => ({ text: block.text, role: block.role })),
        metrics,
        overlaps: paintedCoverOverlaps(placed, pageWidth),
        unpainted: placed.filter((p) => !p.paint).length,
        overflow: placed.filter((p) => p.overflow).length,
      };
      report.push(record);
      console.log(
        JSON.stringify({
          page: pageNumber,
          ocrMs: Math.round(ocrMs),
          layoutMs: Math.round(layoutMs),
          firstVisibleMs: firstVisibleMs === null ? null : Math.round(firstVisibleMs),
          translateMs: Math.round(translateMs),
          regions: record.regions,
          lines: record.lines.length,
          blocks: record.blocks.length,
          metrics,
        }),
      );
      if (shots) {
        const overlays = placed.map((entry) => ({
          source: entry.block.text.replace(/\s+/gu, ' ').slice(0, 80),
          role: entry.block.role,
          paint: entry.paint,
          translation: entry.translation.replace(/\s+/gu, ' ').slice(0, 400),
          fontSize: entry.fit?.fontSize ?? 12,
          box: entry.drawn ?? entry.block.box,
        }));
        await page.evaluate(
          async (data) => {
            await (
              globalThis as unknown as {
                __renderPdf: (v: object) => Promise<unknown>;
              }
            ).__renderPdf(data);
          },
          { url: server.origin + '/' + PDF, page: pageNumber, scale: 1.25, overlays },
        );
        await page
          .locator('#sheet')
          .screenshot({ path: join(OUT, label + '-p' + String(pageNumber) + '.png') });
      }
    }
    await page.close();
  } finally {
    await doc.destroy();
    await loaded.release();
    await browser.close();
    await server.close();
  }
  await writeFile(join(OUT, label + '.json'), JSON.stringify(report, null, 2) + '\n');
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
