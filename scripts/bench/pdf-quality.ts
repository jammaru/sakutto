/**
 * Offline PDF translation quality bench.
 *
 *   pnpm bench:pdf:quality --label baseline --shots
 *   pnpm bench:pdf:quality --label final --shots --fixtures paper,arxiv,scan
 *
 * No model, network or extension build is needed for the committed fixtures. arXiv 1706.03762
 * is downloaded once into bench/.cache when it is not already there. A deterministic local
 * fake engine turns prose into Japanese-shaped output, so the same input measures paragraph
 * reconstruction, protection, placement and scheduling rather than model quality.
 *
 * The 'scan' fixture is a SIMULATED OCR input: it uses scan.pdf's page size and background but
 * word boxes synthesized from paper.pdf's native text. Real OCR on scan.pdf page 1 is measured
 * by 'pnpm bench:pdf:scan:ocr'; that result is included in this report under a separate heading
 * and never folded into the simulated scan numbers. Run both with 'pnpm bench:pdf:quality:scan'.
 */
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

import {
  countsAsProse,
  entryGarbledTokens,
  expectedReadingOrder,
  isMixedLanguage,
  isProseLike,
  normalizeText,
  orderAccuracy,
  PROSE_ROLE,
  summarize,
  type QualityEntry,
  type QualityPage,
} from './pdf-quality-metrics.ts';
import { pseudoOcrRegions } from './pdf-scan-simulator.ts';
import { startStaticServer } from './static.ts';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'bench/results/pdf-quality');
const SHOTS = join(ROOT, 'bench/results/screenshots');
const ARXIV_URL = 'https://arxiv.org/pdf/1706.03762';
const ARXIV_URL_V7 = 'https://arxiv.org/pdf/1706.03762v7';
/** Pinned digest of the cached arXiv payload; an upstream change must not move the baseline. */
const ARXIV_SHA256 = 'bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Block {
  text: string;
  role: string;
  box: Box;
  room: Box;
  fontSize: number;
  lineHeight: number;
  column: number;
  advance: number;
  writing: number;
  lines: unknown[];
}

interface Layout {
  blocks: Block[];
  skipped: Block[];
  bodySize: number;
  lineHeight: number;
  pageHeight: number;
  pageWidth: number;
  obstacles: Box[];
}

interface Placed {
  block: Block;
  translation: string;
  fit: { fits: boolean; lines: string[]; fontSize: number; width: number; height: number } | null;
  paint: boolean;
  overflow: boolean;
  drawn: Box | null;
}

interface TextLine {
  text: string;
  height: number;
  box: Box;
  baseline: number;
  pieces: unknown[];
  mathRatio: number;
  proseChars: number;
}

interface Extracted {
  lines: TextLine[];
  figures: { images: Box[] };
  empty: boolean;
  width: number;
  height: number;
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined
    ? (process.argv[index + 1] ?? fallback)
    : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

// The label is only a report filename, but keep it inside the results directory.
const label = option('--label', 'run')
  .replace(/[^A-Za-z0-9._-]/gu, '_')
  .replace(/^\.\.+/u, '_');
const fixtureNames = option('--fixtures', 'paper,arxiv,scan').split(',').filter(Boolean);
const pageArg = option('--pages', '');
const shotArg = option('--shot-pages', 'arxiv:1,3,5;paper:1;scan:1');
const paceParts = option('--pace', '6,0.04').split(',').map(Number);
const ttfbMs = paceParts[0] ?? 6;
const msPerChar = paceParts[1] ?? 0.04;
const takeShots = flag('--shots');
const noDownload = flag('--no-download');
const concurrency = Number(option('--concurrency', '8'));

// Some shipped modules branch on this build flag. The bench is a fake-engine run by design.
(globalThis as Record<string, unknown>)['__SAKUTTO_FAKE_ENGINE__'] = true;

const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjs = await import(pathToFileURL(pdfjsPath).href);
const standardFontDataUrl = pathToFileURL(
  resolve(dirname(pdfjsPath), '..', '..', 'standard_fonts') + '/',
).href;

async function loadPdfModule<T>(name: string): Promise<T> {
  return (await import(pathToFileURL(resolve(ROOT, 'src/pdf', name)).href)) as T;
}

const { extractPage } = await loadPdfModule<{
  extractPage: (
    page: unknown,
    index: number,
    codes: Record<string, number> | null,
  ) => Promise<Extracted>;
}>('extract.ts');
const { layoutPage } = await loadPdfModule<{
  layoutPage: (lines: readonly TextLine[], figures: unknown, page?: object) => Layout;
}>('layout.ts');
const { placePage, paintedCoverOverlaps } = await loadPdfModule<{
  placePage: (request: {
    layout: Layout;
    translationOf: (block: Block) => string;
    target: 'ja';
    measure: (block: Block, text: string, fontSize: number) => number;
    pageHeight: number;
    pageWidth: number;
  }) => Placed[];
  paintedCoverOverlaps: (placed: readonly Placed[], pageWidth: number) => number;
}>('place.ts');
const { pageMetrics } = await loadPdfModule<{
  pageMetrics: (
    layout: Layout,
    placed: readonly Placed[],
    page: Box,
  ) => {
    overlapPairs: number;
    overlapArea: number;
    overflow: number;
    proseCovered: number;
  };
}>('metrics.ts');
const { protectInlineMath, restoreInlineMath, shouldSkipInlineMath } = await loadPdfModule<{
  protectInlineMath: (block: Block) => { text: string; slots: unknown[] };
  restoreInlineMath: (text: string, slots: unknown[]) => string | null;
  shouldSkipInlineMath: (
    protectedText: { text: string; slots: unknown[] },
    source: string,
  ) => boolean;
}>('protect.ts');
const { translationEchoesSource, isSameLanguage } = await loadPdfModule<{
  translationEchoesSource: (source: string, output: string, target: string) => boolean;
  isSameLanguage: (text: string, target: string, pageLanguage: string | null) => boolean;
}>('language.ts');
const { ocrResultToPageLayout } = await loadPdfModule<{
  ocrResultToPageLayout: (
    result: unknown,
    options: { pageIndex: number; pageWidth: number; pageHeight: number },
  ) => Layout;
}>('ocr.ts');
const { groupReadingLines } = (await import(
  pathToFileURL(resolve(ROOT, 'src/engine/ocr/order.ts')).href
)) as {
  groupReadingLines: (regions: readonly unknown[]) => unknown[];
};

/** Approximates the reader's canvas measure: CJK is one em, Latin about half an em. */
function measure(_block: Block, text: string, size: number): number {
  let width = 0;
  for (const character of text) {
    width += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      character,
    )
      ? size
      : size * 0.5;
  }
  return width;
}

const KNOWN: Record<string, string> = {
  the: 'その',
  a: '一つの',
  an: '一つの',
  and: 'そして',
  or: 'または',
  of: 'の',
  to: 'へ',
  in: 'において',
  for: 'のために',
  with: 'ともに',
  is: 'である',
  are: 'である',
  we: '我々は',
  this: 'この',
  that: 'その',
  as: 'として',
  by: 'により',
  from: 'から',
  on: 'の上で',
  it: 'それは',
  be: 'である',
  can: 'できる',
  model: 'モデル',
  paper: '論文',
  attention: '注意',
  layer: '層',
  translation: '翻訳',
  language: '言語',
  system: 'システム',
  method: '手法',
  result: '結果',
  data: 'データ',
  using: 'を用いて',
};

/**
 * A deterministic local stand-in for PLaMo. Ordinary English words become Japanese text;
 * notation, URLs, citations and protected tags survive, so a mid-block language switch here
 * means the pipeline mixed untranslatable material into prose rather than an engine quirk.
 */
function fakeTranslate(text: string): string {
  const tokens = text
    .split(/(\s+|<i\d+>)/u)
    .filter((part) => part.length > 0 && !/^\s+$/u.test(part));
  return tokens
    .map((token) => {
      if (/^<i\d+>$/u.test(token)) return token;
      if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)) return token;
      if (/[0-9=<>[\]{}|\\^∈×÷∑∏∫∂∇→+−]/u.test(token)) return token;
      if (/^(?:https?:|www\.|@|ftp:)/iu.test(token) || token.includes('@')) return token;
      const suffix = token.match(/[^\p{L}]+$/u)?.[0] ?? '';
      const key = (token.toLowerCase().match(/\p{L}+/gu) ?? []).join('');
      if (key.length === 0) return token;
      const known = KNOWN[key];
      if (known !== undefined) return known + suffix;
      const syllables = Math.max(1, Math.min(4, Math.ceil(key.length / 3)));
      return '語'.repeat(syllables) + suffix;
    })
    .join('');
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((done) => setTimeout(done, ms));
}

/** Resolves fake translations with bounded concurrency; records when the first one lands. */
async function translateBlocks(
  blocks: readonly Block[],
  pageStarted: number,
  runStarted: number,
): Promise<{ translations: Map<Block, string>; firstMs: number; runFirstMs: number }> {
  const translations = new Map<Block, string>();
  let firstMs = 0;
  let runFirstMs = 0;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, blocks.length || 1)) },
    () =>
      (async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const block = blocks[index];
          if (!block) return;
          const protectedText = protectInlineMath(block);
          const delay = ttfbMs + protectedText.text.length * msPerChar;
          await sleep(delay);
          const output = fakeTranslate(protectedText.text);
          const restored = restoreInlineMath(output, protectedText.slots);
          translations.set(block, restored ?? '');
          const arrived = Date.now();
          if (firstMs === 0) firstMs = arrived - pageStarted;
          if (runFirstMs === 0) runFirstMs = arrived - runStarted;
        }
      })(),
  );
  await Promise.all(workers);
  return { translations, firstMs, runFirstMs };
}

async function arxivBytes(): Promise<Uint8Array> {
  const cache = join(ROOT, 'bench/.cache/arxiv-1706.03762.pdf');
  const cached = await readFile(cache)
    .then((bytes) => new Uint8Array(bytes))
    .catch(() => null);
  if (cached) {
    const digest = createHash('sha256').update(cached).digest('hex');
    if (digest !== ARXIV_SHA256) {
      throw new Error('arXiv cache digest changed (' + digest + '); refresh the pinned fixture.');
    }
    return cached;
  }
  if (noDownload) throw new Error('arXiv fixture is not cached and downloads are disabled.');
  await mkdir(dirname(cache), { recursive: true });
  let response = await fetch(ARXIV_URL);
  if (!response.ok) response = await fetch(ARXIV_URL_V7);
  if (!response.ok || !response.body) throw new Error('arXiv download failed.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== ARXIV_SHA256) {
    throw new Error('arXiv download digest changed (' + digest + '); refresh the pinned fixture.');
  }
  await writeFile(cache, bytes);
  return bytes;
}
async function renderShots(report: unknown): Promise<void> {
  let server: Awaited<ReturnType<typeof startStaticServer>> | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    server = await startStaticServer({ directory: ROOT, isolated: false });
    browser = await chromium.launch({
      executablePath: process.env['CHROME_PATH'] || '/usr/local/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox'],
    });
    const page = await browser.newPage({
      viewport: { width: 1100, height: 1500 },
      deviceScaleFactor: 1,
    });
    page.on('pageerror', (error) => console.error('viewer:', error.message));
    await page.goto(server.origin + '/scripts/bench/pdf-quality-view.html');
    await page.waitForFunction('window.__pdfReady === true', null, { timeout: 20_000 });
    const shots = report as Array<{
      fixture: string;
      page: number;
      url: string;
      overlays: unknown[];
    }>;
    for (const shot of shots) {
      await page.evaluate(async (data) => {
        await (
          globalThis as unknown as {
            __renderPdf: (value: {
              url: string;
              page: number;
              scale: number;
              overlays: unknown[];
            }) => Promise<unknown>;
          }
        ).__renderPdf({
          url: location.origin + data.url,
          page: data.page,
          scale: 1.25,
          overlays: data.overlays,
        });
      }, shot);
      const directory = join(SHOTS, label);
      await mkdir(directory, { recursive: true });
      await page.locator('#sheet').screenshot({
        path: join(directory, shot.fixture + '-p' + String(shot.page) + '.png'),
      });
    }
    await page.close();
  } finally {
    await browser?.close();
    await server?.close();
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  await mkdir(OUT, { recursive: true });
  const sources = new Map<string, { bytes: Uint8Array; path: string; url: string }>();
  const arxivPath = join(ROOT, 'bench/.cache/arxiv-1706.03762.pdf');
  for (const name of fixtureNames) {
    if (name === 'arxiv') {
      sources.set(name, {
        bytes: await arxivBytes(),
        path: arxivPath,
        url: 'bench/.cache/arxiv-1706.03762.pdf',
      });
    } else {
      const relative = 'bench/pdf/' + (name === 'scan' ? 'scan.pdf' : 'paper.pdf');
      sources.set(name, {
        bytes: new Uint8Array(await readFile(join(ROOT, relative))),
        path: join(ROOT, relative),
        url: relative,
      });
    }
  }

  const pages: QualityPage[] = [];
  const shots: Array<{ fixture: string; page: number; url: string; overlays: unknown[] }> = [];
  let firstBlockMs = 0;
  for (const [fixture, source] of sources) {
    const requested = pageArg.length > 0 ? pageArg.split(',').map(Number) : [];
    const selected = requested.length > 0 ? requested : fixture === 'arxiv' ? [1, 3, 5] : [1];
    const shotList = new Set(
      (shotArg.split(';').find((entry) => entry.startsWith(fixture + ':')) ?? '')
        .slice(fixture.length + 1)
        .split(',')
        .map(Number)
        .filter((value) => Number.isFinite(value)),
    );
    const doc = await pdfjs.getDocument({
      data: source.bytes,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl,
    }).promise;

    // The scan's OCR is simulated from the printed paper's own text geometry. Same paper, same
    // page size, word-level boxes and detector order — no model is required and the layout
    // decisions under test are the shipped ones.
    let ocrLines: TextLine[] = [];
    if (fixture === 'scan') {
      const native = await pdfjs.getDocument({
        data: new Uint8Array(await readFile(join(ROOT, 'bench/pdf/paper.pdf'))),
        useSystemFonts: false,
        isEvalSupported: false,
        standardFontDataUrl,
      }).promise;
      const paperPage = await native.getPage(1);
      ocrLines = (await extractPage(paperPage, 0, pdfjs.OPS)).lines;
      await native.destroy();
    }

    for (const number of selected) {
      if (number > doc.numPages) continue;
      const pdfPage = await doc.getPage(number);
      const extracted = await extractPage(pdfPage, number - 1, pdfjs.OPS);
      let layout: Layout;
      if (fixture === 'scan') {
        const regions = pseudoOcrRegions(ocrLines);
        const lines = groupReadingLines(regions);
        layout = ocrResultToPageLayout(
          { regions, lines, text: ocrLines.map((line) => line.text).join('\n') },
          {
            pageIndex: number - 1,
            pageWidth: extracted.width,
            pageHeight: extracted.height,
          },
        );
      } else {
        layout = extracted.empty
          ? {
              blocks: [],
              skipped: [],
              bodySize: 0,
              lineHeight: 0,
              pageHeight: extracted.height,
              pageWidth: extracted.width,
              obstacles: extracted.figures.images ?? [],
            }
          : layoutPage(extracted.lines, extracted.figures, {
              width: extracted.width,
              height: extracted.height,
              index: number - 1,
            });
      }

      const pageStarted = Date.now();
      const { translations, firstMs, runFirstMs } = await translateBlocks(
        layout.blocks,
        pageStarted,
        started,
      );
      if (runFirstMs > 0 && (firstBlockMs === 0 || runFirstMs < firstBlockMs)) {
        firstBlockMs = runFirstMs;
      }

      const entries: QualityEntry[] = [];
      const translationOf = (block: Block): string => translations.get(block) ?? '';
      const placed = placePage({
        layout,
        translationOf,
        target: 'ja',
        measure,
        pageHeight: extracted.height,
        pageWidth: extracted.width,
      });
      const byBlock = new Map(placed.map((entry) => [entry.block, entry]));
      const pageLanguage = layout.blocks
        .filter((block) => block.role === 'prose')
        .slice(0, 4)
        .map((block) => block.text)
        .join(' ');
      // Use the same prose test as the metrics: a one-word heading is still prose that the
      // reader sees in English, while a numeric label or a listing line is not.
      // Proper names and page furniture are deliberately left in the source; counting them
      // as untranslated prose would make an author list look like a translation failure.
      const skippedProse = layout.skipped.filter(
        (block) => !/^(identity|furniture)$/u.test(block.role) && isProseLike(block.text),
      );
      const skippedSet = new Set(skippedProse);

      for (const block of [...layout.blocks, ...skippedProse]) {
        const entry = byBlock.get(block);
        const rawSource = block.text;
        const rawTranslation = translationOf(block);
        const source = normalizeText(rawSource);
        const translation = normalizeText(rawTranslation);
        const delivered = entry !== undefined && translation.length > 0;
        const intentionallyKept =
          isSameLanguage(
            block.text,
            'ja',
            /[\p{Script=Han}\p{Script=Hiragana}]/u.test(pageLanguage) ? 'ja' : null,
          ) || shouldSkipInlineMath(protectInlineMath(block), block.text);
        const echoed =
          delivered &&
          (translationEchoesSource(source, translation, 'ja') || translation === source);
        const proseRole = PROSE_ROLE.test(block.role);
        // A skipped block mislabelled `code` can still be a whole English sentence. Count it
        // as prose so it cannot disappear from the headline untranslated rate.
        const prose = proseRole || (skippedSet.has(block) && isProseLike(block.text));
        const untranslated = !delivered || echoed || (intentionallyKept && proseRole);
        entries.push({
          source,
          translation,
          role: block.role,
          box: block.box,
          painted: entry?.paint === true,
          overflow: entry?.overflow === true,
          delivered,
          placeholders: (translation.match(/<i\d+>/gu) ?? []).length,
          untranslated,
          prose,
          mixedLanguage: delivered && isMixedLanguage(translation),
          garbled: entryGarbledTokens(rawSource, rawTranslation, delivered),
          scale:
            entry?.fit && entry.fit.fontSize > 0
              ? entry.fit.fontSize / Math.max(1, block.fontSize)
              : 1,
        });
      }

      const geometric = expectedReadingOrder(
        layout.blocks.map((block) => ({ text: block.text, box: block.box })),
        extracted.width,
      );
      const metrics = pageMetrics(layout, placed, {
        x: 0,
        y: 0,
        width: extracted.width,
        height: extracted.height,
      });
      const coverOverlaps = paintedCoverOverlaps(placed, extracted.width);
      pages.push({
        fixture,
        textSource: fixture === 'scan' ? 'simulated-ocr' : 'native',
        page: number,
        entries,
        overlapPairs: Math.max(metrics.overlapPairs, coverOverlaps),
        overflow:
          metrics.overflow + placed.filter((entry) => entry.overflow && !entry.paint).length,
        shrunk: placed.filter(
          (entry) =>
            entry.paint && entry.fit !== null && entry.fit.fontSize < entry.block.fontSize * 0.75,
        ).length,
        untranslatedProse: entries.filter((entry) => countsAsProse(entry) && entry.untranslated)
          .length,
        proseBlocks: entries.filter(countsAsProse).length,
        skippedProse: entries.filter(
          (entry) => countsAsProse(entry) && !PROSE_ROLE.test(entry.role),
        ).length,
        readingOrder: orderAccuracy(
          layout.blocks.map((_block, index) => 'k' + String(index)),
          geometric.keys,
        ),
        twoColumn: geometric.twoColumn,
        firstBlockMs: firstMs,
        pageMs: Date.now() - pageStarted,
      });

      if (shotList.has(number)) {
        const overlays = placed.map((entry) => ({
          source: normalizeText(entry.block.text).slice(0, 60),
          role: entry.block.role,
          paint: entry.paint,
          translation: normalizeText(entry.translation).slice(0, 400),
          fontSize: entry.fit?.fontSize ?? entry.block.fontSize,
          box: entry.drawn ?? entry.block.box,
        }));
        shots.push({
          fixture,
          page: number,
          url: '/' + source.url,
          overlays,
        });
      }
    }
    await doc.destroy();
  }

  const totalMs = Date.now() - started;
  const summary = summarize(pages, firstBlockMs, totalMs);
  const sourceSummary = (source: 'native' | 'simulated-ocr') => {
    const subset = pages.filter((page) => page.textSource === source);
    const first = subset.reduce((min, page) => Math.min(min, page.firstBlockMs), Infinity);
    return {
      pages: subset.length,
      summary: summarize(
        subset,
        Number.isFinite(first) ? first : 0,
        subset.reduce((sum, page) => sum + page.pageMs, 0),
      ),
    };
  };
  const byTextSource = {
    native: sourceSummary('native'),
    'simulated-ocr': sourceSummary('simulated-ocr'),
  };
  // Real OCR is a separate model-backed bench. Read its committed result here so a simulated
  // scan measurement is never presented as an OCR measurement.
  const realOcr = await readFile(join(ROOT, 'bench/results/scan-ocr/report.json'), 'utf8')
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  const report = {
    label,
    generatedAt: new Date().toISOString(),
    engine: 'deterministic local fake',
    pace: { ttfbMs, msPerChar, concurrency },
    fixtures: [...sources.keys()],
    textSources: {
      native: 'paper.pdf and arXiv 1706.03762 use their own PDF text layer.',
      'simulated-ocr':
        'scan.pdf page geometry and background, word boxes synthesized from paper.pdf text (not OCR).',
      realOcr: 'bench/pdf/scan.pdf page 1 recognized by pnpm bench:pdf:scan:ocr; see realOcr.',
    },
    byTextSource,
    realOcr: {
      command: 'pnpm bench:pdf:scan:ocr',
      input: 'bench/pdf/scan.pdf page 1',
      report: 'bench/results/scan-ocr/report.json',
      runs: realOcr,
    },
    summary,
    pages,
  };
  const reportPath = join(OUT, label + '.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');

  const markdownRow = (name: string, s: ReturnType<typeof summarize>): string =>
    '| ' +
    name +
    ' | ' +
    String(s.pages) +
    ' | ' +
    String(s.skippedProseBlocks) +
    ' | ' +
    (s.untranslatedProseRate * 100).toFixed(1) +
    '% | ' +
    (s.mixedLanguageRate * 100).toFixed(1) +
    '% | ' +
    (s.garbledTokenRate * 100).toFixed(2) +
    '% | ' +
    s.overlapRate.toFixed(3) +
    ' | ' +
    s.overflowRate.toFixed(3) +
    ' |';
  const markdown = [
    '| label | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block ms | full ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    '| ' +
      label +
      ' | ' +
      String(summary.pages) +
      ' | ' +
      String(summary.skippedProseBlocks) +
      ' | ' +
      (summary.untranslatedProseRate * 100).toFixed(1) +
      '% | ' +
      (summary.mixedLanguageRate * 100).toFixed(1) +
      '% | ' +
      (summary.garbledTokenRate * 100).toFixed(2) +
      '% | ' +
      summary.overlapRate.toFixed(3) +
      ' | ' +
      summary.overflowRate.toFixed(3) +
      ' | ' +
      (summary.readingOrderAccuracy * 100).toFixed(1) +
      '% | ' +
      String(summary.firstTranslatedBlockMs) +
      ' | ' +
      String(summary.fullDocumentMs) +
      ' |',
  ].join('\n');
  const realRuns = Array.isArray(realOcr) ? realOcr : [];
  const fullMarkdown = [
    markdown,
    '',
    '"skipped prose" counts code/label blocks the layout skipped that still contain a natural-language sentence; they are part of the prose denominator and the untranslated rate. Proper names and page furniture are deliberately kept in the source and are reported separately, not counted as translation failures.',
    '',
    '## Text source split',
    '',
    'The scan fixture above is SIMULATED OCR: scan.pdf supplies the page size and background, but word boxes are synthesized from paper.pdf text. It measures OCR layout and placement, not recognition. Real recognition on scan.pdf is measured separately with pnpm bench:pdf:scan:ocr and listed below; never read the simulated scan row as a real-scan result.',
    '',
    '| text source | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    markdownRow('native (paper, arxiv)', byTextSource.native.summary),
    markdownRow('simulated OCR (scan)', byTextSource['simulated-ocr'].summary),
    '',
    '## Real OCR on scan.pdf page 1 (pnpm bench:pdf:scan:ocr)',
    '',
    '| variant | CER | WER | lines | blocks | skipped | cross-column | overlaps | overflow |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...realRuns.map((run) => {
      const item = run as Record<string, number | string>;
      return (
        '| ' +
        item.variant +
        ' | ' +
        Number(item.cer).toFixed(3) +
        ' | ' +
        Number(item.wer).toFixed(3) +
        ' | ' +
        item.lines +
        ' | ' +
        item.blocks +
        ' | ' +
        item.skipped +
        ' | ' +
        item.crossColumnCovers +
        ' | ' +
        item.overlapPairs +
        ' | ' +
        item.overflow +
        ' |'
      );
    }),
  ].join('\n');
  const historyPath = join(OUT, 'history.md');
  const previousHistory = await readFile(historyPath, 'utf8').catch(() => '');
  await appendFile(
    historyPath,
    previousHistory.includes('| label | pages |')
      ? markdown.split('\n').slice(2).join('\n') + '\n'
      : markdown + '\n',
  );
  await writeFile(join(OUT, label + '.md'), fullMarkdown + '\n');

  if (takeShots && shots.length > 0) await renderShots(shots);

  console.log('PDF quality bench — ' + label);
  console.log(fullMarkdown);
  for (const page of pages) {
    const untranslated = page.entries.filter((entry) => entry.untranslated).slice(0, 3);
    console.log(
      '  ' +
        page.fixture +
        ' p' +
        String(page.page) +
        ': blocks=' +
        String(page.entries.length) +
        ' prose=' +
        String(page.proseBlocks) +
        ' untranslated=' +
        String(page.untranslatedProse) +
        ' overlap=' +
        String(page.overlapPairs) +
        ' garbled=' +
        String(page.entries.reduce((sum, entry) => sum + entry.garbled.length, 0)) +
        ' order=' +
        page.readingOrder.toFixed(2) +
        (page.twoColumn ? ' (2col)' : ''),
    );
    for (const entry of untranslated) {
      console.log('    kept: ' + entry.role + ' — ' + entry.source.slice(0, 80));
    }
  }
  console.log('wrote ' + reportPath);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
