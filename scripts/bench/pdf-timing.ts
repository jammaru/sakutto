/**
 * Times the reader's own extraction per page, to see whether a change made a document slow.
 *
 *   node --experimental-strip-types --import ./scripts/bench/register-ts.mjs \
 *     scripts/bench/pdf-timing.ts <file.pdf> --pages 12
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const file = args[0];
if (file === undefined) throw new Error('usage: pdf-timing.ts <file.pdf> [--pages N]');
const limit = Number(args[args.indexOf('--pages') + 1] ?? '12');

const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjs = await import(pathToFileURL(pdfjsPath).href);

const { extractPage } = (await import(pathToFileURL(resolve('src/pdf/extract.ts')).href)) as {
  extractPage: (
    page: unknown,
    index: number,
    ops: Record<string, number> | null,
  ) => Promise<{ lines: Array<{ text: string }>; figures: { images: unknown[] } }>;
};
const { layoutPage } = (await import(pathToFileURL(resolve('src/pdf/layout.ts')).href)) as {
  layoutPage: (
    lines: readonly unknown[],
    figures: unknown,
  ) => { blocks: unknown[]; skipped: unknown[] };
};

const bytes = new Uint8Array(await readFile(resolve(file)));
const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: false }).promise;
const total = Math.min(limit, doc.numPages);
console.log('page  ms    lines blocks skip  images');

let sum = 0;
for (let index = 1; index <= total; index += 1) {
  const page = await doc.getPage(index);
  const started = performance.now();
  const extracted = await extractPage(page, index - 1, pdfjs.OPS);
  const layout = layoutPage(extracted.lines, extracted.figures);
  const ms = performance.now() - started;
  sum += ms;
  console.log(
    `${String(index).padStart(4)}  ${ms.toFixed(0).padStart(4)}  ${String(extracted.lines.length).padStart(5)} ${String(layout.blocks.length).padStart(6)} ${String(layout.skipped.length).padStart(5)} ${String(extracted.figures.images.length).padStart(7)}`,
  );
}
console.log(`\nmean ${(sum / total).toFixed(0)} ms/page over ${String(total)} pages`);
await doc.destroy();
