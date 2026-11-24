/**
 * Renders the fixed translated PDF for the image-only two-column fixture.
 *
 * Uses the shipped fonts and the cached OCR layout from pnpm bench:image-paper, with a
 * deterministic fake translation. Viewer lines are wrapped with a deliberately narrower
 * measurement to reproduce the browser-font mismatch that made the old export spill over the
 * gutter. The saved PNGs show the exported file itself, not the reader overlay.
 *
 *   node --experimental-transform-types --no-warnings --import ./scripts/bench/register-ts.mjs scripts/bench/pdf-export-shots.ts
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';
import { buildTranslatedPdf, type ExportBlock, type ExportPage } from '../../src/pdf/export.ts';
import { wrapBudget, wrapText } from '../../src/pdf/fit.ts';
import { startStaticServer } from './static.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, 'bench/results/image-paper');
const ARTIFACTS = '/opt/cursor/artifacts';

interface BenchBlock {
  text: string;
  role: string;
  box: { x: number; y: number; width: number; height: number };
  room: { x: number; y: number; width: number; height: number };
  fontSize: number;
}

interface BenchRecord {
  page: number;
  pageWidth: number;
  pageHeight: number;
  blocks: BenchBlock[];
}

/** Long enough that a viewer-narrow wrap spills into the next column in the old export. */
function fakeTranslation(block: BenchBlock): string {
  const heading = block.role === 'heading';
  const sentence = heading
    ? 'Local inference on the device'
    : 'By using WebAssembly within the browser models can be executed locally without sending the source text anywhere.';
  const wanted = Math.max(40, Math.min(240, Math.round(block.text.length * 1.5)));
  let text = '';
  while (text.length < wanted) text += (text.length > 0 ? ' ' : '') + sentence;
  return text.slice(0, wanted);
}

async function main(): Promise<void> {
  const fontBytes = await readFile(join(ROOT, 'vendor/fonts/MPLUS1p-Regular.ttf'));
  const measureDocument = await PDFDocument.create();
  measureDocument.registerFontkit(fontkit);
  const font = await measureDocument.embedFont(fontBytes, { subset: false });

  const specs = [
    { page: 1, json: 'run.json', raster: 'raster-p1.png' },
    { page: 2, json: 'after3.json', raster: 'raster-p2.png' },
  ];
  const pages: ExportPage[] = [];
  for (const spec of specs) {
    const records = JSON.parse(await readFile(join(OUT, spec.json), 'utf8')) as BenchRecord[];
    const record = records.find((item) => item.page === spec.page);
    if (!record) throw new Error('missing cached layout for page ' + String(spec.page));
    const image = new Uint8Array(await readFile(join(OUT, spec.raster)));
    const blocks: ExportBlock[] = record.blocks.map((block) => {
      const translation = fakeTranslation(block);
      const fontSize = Math.max(1, block.fontSize);
      // The viewer uses the browser font stack, which measures Latin narrower than M PLUS.
      const viewerMeasure = (text: string) => font.widthOfTextAtSize(text, fontSize) * 0.78;
      const lines = wrapText(translation, wrapBudget(Math.max(1, block.room.width)), viewerMeasure);
      return {
        source: block.box,
        drawn: block.box,
        translation,
        lines: lines.length > 0 ? lines : [translation],
        fontSize,
        lineHeight: fontSize * 1.25,
        align: block.role === 'heading' ? 'center' : 'left',
        traits: { family: 'sans-serif', bold: block.role === 'heading', italic: false },
        writing: 0,
        role: block.role as ExportBlock['role'],
      };
    });
    pages.push({
      index: spec.page - 1,
      width: record.pageWidth,
      height: record.pageHeight,
      image,
      blocks,
    });
  }

  const bytes = await buildTranslatedPdf({
    pages,
    font: fontBytes,
    targetLanguage: 'en',
    title: 'image-only-paper',
  });
  const pdfPath = join(OUT, 'translated-export.pdf');
  await writeFile(pdfPath, bytes);
  console.log('wrote ' + pdfPath);

  const server = await startStaticServer({ directory: ROOT, isolated: false });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 1800 } });
    await page.goto(server.origin + '/scripts/bench/pdf-quality-view.html');
    await page.waitForFunction(
      () => (globalThis as unknown as { __pdfReady?: boolean }).__pdfReady === true,
    );
    for (const spec of specs) {
      await page.evaluate(
        async (args) => {
          type RenderFn = (input: {
            url: string;
            page: number;
            scale: number;
            overlays: unknown[];
          }) => Promise<unknown>;
          const render = (globalThis as unknown as { __renderPdf: RenderFn }).__renderPdf;
          await render({ url: args.url, page: args.number, scale: 2, overlays: [] });
        },
        {
          url: server.origin + '/bench/results/image-paper/translated-export.pdf',
          number: spec.page,
        },
      );
      const name = 'pdf-export-after-p' + String(spec.page) + '.png';
      const local = join(OUT, name);
      await page.locator('#sheet canvas').screenshot({ path: local });
      try {
        await writeFile(join(ARTIFACTS, name), await readFile(local));
        console.log('wrote ' + join(ARTIFACTS, name));
      } catch {
        console.log('artifacts directory is read-only; kept ' + local);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

await main();
