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
/** Local diagnosis only: print why each prose block was or was not painted. */
const diagnose = process.argv.includes('--diag') || process.env['SAKUTTO_LAYOUT_DIAG'] === '1';
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
    skipped: Array<{ role?: string; text?: string; lines?: unknown[] }>;
    bodySize: number;
    pageHeight: number;
    pageWidth?: number;
    pageIndex?: number;
    obstacles?: unknown[];
  };
  orphanLineCount: (extracted: unknown[], layout: unknown) => number;
};
const {
  placePage,
  clippedPaintWidth,
  verticalCut,
  paintedCoverOverlaps,
  drawnBox,
  exceedsPage,
  lineOverflows,
  wrapWidth,
} = (await import(pathToFileURL(resolve(ROOT, 'src/pdf/place.ts')).href)) as {
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
    fit: {
      fits: boolean;
      lines: string[];
      fontSize: number;
      width: number;
      height: number;
    } | null;
    drawn: { width: number; height: number; x: number; y: number } | null;
    block: {
      text: string;
      role: string;
      writing?: number;
      column?: number;
      lineHeight?: number;
      box: { x: number; y: number; width: number; height: number };
      room?: { x: number; y: number; width: number; height: number };
      advance?: number;
    };
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
  paintedCoverOverlaps: (placed: unknown[], pageWidth?: number) => number;
  drawnBox: (
    block: unknown,
    fit: { fits: boolean; lines: string[]; fontSize: number; width: number; height: number },
    wrap?: number,
    pageWidth?: number,
  ) => { x: number; y: number; width: number; height: number };
  exceedsPage: (
    box: { x: number; y: number; width: number; height: number },
    pageWidth: number,
    pageHeight: number,
  ) => boolean;
  lineOverflows: (
    fit: { fits: boolean; lines: string[]; fontSize: number },
    width: number,
    measure: (text: string) => number,
  ) => boolean;
  wrapWidth: (block: unknown, obstacles?: unknown[], pageWidth?: number) => number;
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
    prosePaintedOnly: number;
    proseCovered: number;
    nonProsePainted: number;
    overflow: number;
    codeShare: number;
    equationShare: number;
    cjkShare: number;
  };
  metricsPass: (metrics: {
    overlapPairs: number;
    proseCovered: number;
    nonProsePainted: number;
    overflow: number;
    minFontSize: number | null;
    figureAreaShare?: number;
    labelShare?: number;
    codeShare: number;
    equationShare: number;
    cjkShare: number;
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

interface DiagBlock {
  text: string;
  role: string;
  fontSize: number;
  column?: number;
  writing?: number;
  box: { x: number; y: number; width: number; height: number };
}

interface DiagPlaced {
  paint: boolean;
  overflow: boolean;
  translation: string;
  fit: {
    fits: boolean;
    lines: string[];
    fontSize: number;
    width: number;
    height: number;
  } | null;
  drawn: { x: number; y: number; width: number; height: number } | null;
  block: DiagBlock;
}

const PROSE_ROLES = new Set(['prose', 'heading', 'caption', 'cell']);

/** Cheap copy of the metrics rule: a skipped block whose text reads as a sentence. */
function readsAsProse(text: string): boolean {
  const words = text.match(/\p{L}{3,}/gu)?.length ?? 0;
  return words >= 3 || (text.match(/\b[A-Za-z]{3,}\b/gu)?.length ?? 0) >= 8;
}

/**
 * Local-only table of why a page's prose is painted or withheld.
 *
 * `overlap` means the fit succeeded but resolveOverlaps dropped the cover; `overflow` means
 * no font size in the readable range fitted, a line was wider than the wrap, or the drawn
 * box ran off the page. A skipped block with sentence-shaped text is `misclassified`.
 */
function diagnosePage(
  layout: { blocks: DiagBlock[]; skipped: DiagBlock[]; obstacles?: DiagBlock['box'][] },
  placed: DiagPlaced[],
  pageHeight: number,
  pageWidth: number,
): void {
  const obstacles = [
    ...layout.blocks.map((block) => block.box),
    ...layout.skipped.map((block) => block.box),
    ...(layout.obstacles ?? []),
  ];
  const counts = new Map<string, number>();
  const bump = (cause: string): void => {
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  };
  const rows: string[] = [];
  let index = 0;
  const add = (block: DiagBlock, cause: string, font: string): void => {
    bump(cause);
    const prefix = block.text.replace(/\s+/gu, ' ').trim().slice(0, 40);
    rows.push(
      `${String(index).padStart(3)} ${block.role.padEnd(12)} ${String(block.column ?? '-').padStart(2)} ` +
        `${block.box.x.toFixed(0)},${block.box.y.toFixed(0)} ` +
        `${block.box.width.toFixed(0)}x${block.box.height.toFixed(0)} ` +
        `${cause.padEnd(16)} ${font.padStart(5)} ${prefix}`,
    );
    index += 1;
  };

  for (const entry of placed) {
    const block = entry.block;
    const fit = entry.fit;
    let cause: string;
    if (entry.translation.trim().length === 0) {
      cause = 'empty';
    } else if (entry.paint && entry.drawn) {
      cause = 'painted';
    } else if (!fit) {
      cause = 'empty';
    } else {
      const placeBlock = {
        box: block.box,
        room: block.box,
        role: block.role,
        fontSize: block.fontSize,
        lineHeight: 1.2,
        advance: block.box.width,
        column: block.column ?? 0,
        writing: block.writing ?? 0,
      };
      const width = wrapWidth(placeBlock as never, obstacles, pageWidth);
      if (!fit.fits) {
        cause = 'overflow:fit';
      } else if (lineOverflows(fit, width, (text) => measure(text, fit.fontSize))) {
        cause = 'overflow:line';
      } else {
        const candidate = drawnBox(placeBlock as never, fit as never, width, pageWidth);
        cause = exceedsPage(candidate, pageWidth, pageHeight) ? 'overflow:page' : 'overlap';
      }
    }
    if (!PROSE_ROLES.has(block.role) && cause === 'painted') continue;
    add(block, cause, fit?.fontSize !== undefined ? fit.fontSize.toFixed(1) : '-');
  }

  for (const block of layout.skipped) {
    if (!PROSE_ROLES.has(block.role) && !readsAsProse(block.text)) continue;
    add(block, 'misclassified', '-');
  }

  console.log('  diag: idx role          col  x,y       wxh         cause             font  text');
  for (const row of rows) console.log(`  diag: ${row}`);
  const summary = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([cause, count]) => `${cause}=${String(count)}`)
    .join(' ');
  console.log(`  diag: total=${String(rows.length)} ${summary}`);
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
    if (diagnose && !extracted.empty) {
      diagnosePage(layout as never, placed as never, extracted.height, extracted.width);
    }
    let clipped = 0;
    let vCut = 0;
    for (const entry of placed) {
      clipped += clippedPaintWidth(entry as never, (text, size) => measure(text, size));
      vCut += verticalCut(entry as never);
    }
    const orphans = extracted.empty ? 0 : orphanLineCount(extracted.lines, layout);
    const coverOverlaps = extracted.empty ? 0 : paintedCoverOverlaps(placed, extracted.width);
    const pass =
      (extracted.empty ? metrics.painted === 0 : metricsPass(metrics)) &&
      clipped <= 0.01 &&
      vCut <= 0.5 &&
      orphans === 0 &&
      coverOverlaps === 0;
    if (!pass) failed = true;
    console.log(
      `  page ${String(number)}: ${extracted.empty ? 'image-only' : 'text'}  ` +
        `lines=${String(extracted.lines.length)} body=${String(layout.bodySize)} ` +
        `blocks=${String(metrics.blocks)} painted=${String(metrics.painted)} ` +
        `skipped=${String(metrics.skipped)} withheld=${String(metrics.withheld)} ` +
        `overlap=${String(metrics.overlapPairs)} minpt=${metrics.minFontSize === null ? '-' : metrics.minFontSize.toFixed(1)} ` +
        `prose=${(metrics.prosePainted * 100).toFixed(0)}% ` +
        `paintedOnly=${(metrics.prosePaintedOnly * 100).toFixed(0)}% ` +
        `cover=${(metrics.proseCovered * 100).toFixed(0)}% ` +
        `overflowed=${String(metrics.overflowed)} clipped=${clipped.toFixed(1)} inkOver=${clipped.toFixed(1)} vCut=${vCut.toFixed(1)} ` +
        `orphans=${String(orphans)} covers=${String(coverOverlaps)} code=${(metrics.codeShare * 100).toFixed(0)}% ` +
        `eq=${(metrics.equationShare * 100).toFixed(0)}% cjk=${(metrics.cjkShare * 100).toFixed(0)}% ` +
        `${pass ? 'ok' : 'FAIL'}`,
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
  const { groupLines } = (await import(pathToFileURL(resolve(ROOT, 'src/pdf/lines.ts')).href)) as {
    groupLines: (pieces: unknown[]) => unknown[];
  };
  const cjkPiece = (text: string, y: number) => ({
    text,
    box: { x: 40, y: y - 10, width: Math.max(80, text.length * 10), height: 10 },
    baseline: y,
    fontName: 'WenQuanYiMicroHei',
    family: 'monospace',
    bold: false,
    italic: false,
    math: false,
    orientation: 0,
    size: 10,
    displayed: 0,
  });
  const cjkLines = groupLines([
    cjkPiece('本文は日本語の段落であり、ソースコードの掲載ではない。', 100),
    cjkPiece('次の行も同じ段落の続きで、翻訳の対象になる。', 114),
    cjkPiece('三行目も本文であり、等幅と誤認されても残す。', 128),
  ]);
  const cjkLayout = layoutPage(cjkLines, { images: [] }, { width: 400, height: 600, index: 0 });
  const cjkCode = cjkLayout.skipped.filter((block) => block.role === 'code').length;
  const cjkProse = cjkLayout.blocks.filter((block) => block.role === 'prose').length;
  const cjkPass = cjkCode === 0 && cjkProse > 0;
  if (!cjkPass) failed = true;
  console.log(
    `cjk-body.pdf: synthetic  lines=${String(cjkLines.length)} ` +
      `blocks=${String(cjkLayout.blocks.length)} prose=${String(cjkProse)} ` +
      `code=${String(cjkCode)} ${cjkPass ? 'ok' : 'FAIL'}`,
  );
  reports.push({
    file: 'cjk-body.pdf',
    page: 1,
    lines: cjkLines.length,
    blocks: cjkLayout.blocks.length,
    prose: cjkProse,
    code: cjkCode,
    pass: cjkPass,
  });
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
