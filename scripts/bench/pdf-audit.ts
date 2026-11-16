/**
 * Audits what the reader's own layout makes of one page of a PDF.
 *
 *   node scripts/bench/pdf-audit.ts <file.pdf> --page 3
 *   node scripts/bench/pdf-audit.ts <file.pdf> --page 3 --drops
 *
 * Two things are invisible from a rendered page: a line the layout dropped, and a line it kept
 * but mis-roled. A page whose equations read as noise is usually showing both, so this prints
 * every line the extractor found, the block it landed in, and the reason a line was filtered
 * out of the layout.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const file = args[0];
if (file === undefined)
  throw new Error('usage: pdf-audit.ts <file.pdf> [--page N] [--drops] [--json]');
const pageArg = args[args.indexOf('--page') + 1];
const pageNumber = pageArg === undefined ? 1 : Number(pageArg);
const onlyDrops = args.includes('--drops');
const asJson = args.includes('--json');

const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjs = await import(pathToFileURL(pdfjsPath).href);

// The reader's own code, so this measures the shipped rules rather than an approximation.
// Cast: these modules are TypeScript, and the dynamic import resolves to `any` here because
// the audit runs through Node's type stripper rather than the project's own type check.
const { extractPage } = (await import(pathToFileURL(resolve('src/pdf/extract.ts')).href)) as {
  extractPage: (
    page: unknown,
    index: number,
    ops: Record<string, number> | null,
  ) => Promise<{
    width: number;
    height: number;
    lines: Array<{
      text: string;
      height: number;
      mathRatio: number;
      proseChars: number;
      box: { x: number; y: number; width: number; height: number };
      pieces: Array<{ orientation: number }>;
    }>;
    figures: unknown;
  }>;
};
const { layoutPage } = (await import(pathToFileURL(resolve('src/pdf/layout.ts')).href)) as {
  layoutPage: (
    lines: readonly { text: string; height: number; mathRatio: number }[],
    figures: unknown,
  ) => {
    bodySize: number;
    lineHeight: number;
    blocks: Array<{
      role: string;
      fontSize: number;
      box: { x: number; y: number; width: number; height: number };
      text: string;
      lines: Array<{ mathRatio: number; text: string }>;
    }>;
    skipped: Array<{
      role: string;
      fontSize: number;
      box: { x: number; y: number; width: number; height: number };
      text: string;
      lines: Array<{ mathRatio: number }>;
    }>;
  };
};

const bytes = new Uint8Array(await readFile(resolve(file)));
const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: false }).promise;
const page = await doc.getPage(pageNumber);

const extracted = await extractPage(page, pageNumber - 1, pdfjs.OPS);
const layout = layoutPage(extracted.lines, extracted.figures);

/** A line that landed in a block the reader will translate. */
const kept = new Set<unknown>();
for (const block of layout.blocks) {
  for (const line of block.lines) kept.add(line);
}

const rows = extracted.lines.map((line) => {
  const block = layout.blocks.find((candidate) => candidate.lines.includes(line));
  return {
    text: line.text,
    size: Number(line.height.toFixed(1)),
    x: Number(line.box.x.toFixed(1)),
    y: Number(line.box.y.toFixed(1)),
    width: Number(line.box.width.toFixed(1)),
    kept: kept.has(line),
    role: block?.role ?? null,
    blockSize: block ? Number(block.fontSize.toFixed(1)) : null,
    rotated: line.pieces.every((piece: { orientation: number }) => piece.orientation !== 0),
  };
});

if (asJson) {
  console.log(
    JSON.stringify({ bodySize: layout.bodySize, lineHeight: layout.lineHeight, rows }, null, 2),
  );
  await doc.destroy();
  process.exit(0);
}

const dropped = rows.filter((row) => !row.kept);
const equationish = rows.filter(
  (row) => !row.kept && row.size < layout.bodySize * 0.9 && /\p{L}|\d|[=+\-×]/u.test(row.text),
);

console.log(`file: ${file}`);
console.log(
  `page ${String(pageNumber)}: ${extracted.width.toFixed(0)} x ${extracted.height.toFixed(0)}`,
);
console.log(`body size: ${layout.bodySize}pt, line height: ${layout.lineHeight.toFixed(2)}pt`);
console.log(
  `lines: ${String(rows.length)}   kept: ${String(rows.length - dropped.length)}   dropped: ${String(dropped.length)}`,
);
console.log(`dropped lines that look like math or labels: ${String(equationish.length)}`);

console.log('\nblocks:');
for (const block of layout.blocks) {
  const head = block.text.slice(0, 74).replace(/\s+/gu, ' ');
  console.log(
    `  ${block.role.padEnd(7)} ${block.fontSize.toFixed(1).padStart(5)}pt  x=${block.box.x.toFixed(0).padStart(4)} y=${block.box.y.toFixed(0).padStart(4)} w=${block.box.width.toFixed(0).padStart(4)}  ${JSON.stringify(head)}`,
  );
}

// What the reader leaves alone, and why. A skipped block is either an equation or text the
// page drew inside a picture; both are decisions that are invisible on screen.
console.log(`\nskipped (left in the page's own typesetting): ${String(layout.skipped.length)}`);
for (const block of layout.skipped) {
  const head = block.text.slice(0, 74).replace(/\s+/gu, ' ');
  const share =
    block.lines.reduce((sum: number, line: { mathRatio: number }) => sum + line.mathRatio, 0) /
    Math.max(1, block.lines.length);
  console.log(
    `  ${block.role.padEnd(12)} ${block.fontSize.toFixed(1).padStart(5)}pt  math=${(share * 100).toFixed(0).padStart(3)}%  x=${block.box.x.toFixed(0).padStart(4)} y=${block.box.y.toFixed(0).padStart(4)}  ${JSON.stringify(head)}`,
  );
}

if (dropped.length > 0) {
  console.log('\ndropped lines:');
  for (const row of onlyDrops ? dropped : dropped.slice(0, 40)) {
    const why =
      layout.bodySize > 0 && row.size < layout.bodySize * 0.62
        ? 'below figure-label ratio'
        : !/\p{L}{3,}.*\p{L}{3,}/u.test(row.text)
          ? 'no two words'
          : 'other';
    console.log(
      `  ${row.size.toFixed(1).padStart(4)}pt ${row.x.toFixed(0).padStart(4)},${row.y.toFixed(0).padStart(4)}  ${why.padEnd(24)} ${JSON.stringify(row.text.slice(0, 60))}`,
    );
  }
}

await doc.destroy();
