/**
 * Builds the PDF fixtures the PDF tests and the PDF bench read.
 *
 * The source is HTML written for this repository, printed by Chromium so the PDF carries a
 * real text layer: embedded font subsets, per-glyph positions, a two-column layout, a table
 * and a figure. A fixture generated this way can be committed: it is small and it is our own
 * text.
 *
 *   node scripts/bench/build-pdf-fixtures.ts
 *
 * Writes:
 *   bench/pdf/paper.pdf  the paper, with selectable text
 *   bench/pdf/scan.pdf   the same layout as one bitmap per page, with no text layer, which is
 *                        the shape a scanned document arrives in
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceDirectory = join(root, 'bench', 'pdf');
const sourceHtml = join(sourceDirectory, 'paper.html');

/** A4 at 150 dpi. The scan fixture is rendered at this size so text stays legible. */
const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;

async function printPaper(outPath: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`file://${sourceHtml.replaceAll('\\', '/')}`, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
    await writeFile(outPath, pdf);
  } finally {
    await browser.close();
  }
}

/**
 * Renders the same document as a screen, one bitmap per A4 page, and packs the bitmaps into
 * an image-only PDF. Going through the screen instead of the print engine is deliberate: no
 * text operator is emitted anywhere, so the result has no text layer at all, which is what a
 * scanner produces.
 */
async function buildScan(outPath: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: PAGE_WIDTH, height: PAGE_HEIGHT } });
    await page.goto(`file://${sourceHtml.replaceAll('\\', '/')}`, { waitUntil: 'load' });
    const fullHeight = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    );
    const pages = Math.max(1, Math.ceil(fullHeight / PAGE_HEIGHT));
    const images: Buffer[] = [];
    for (let index = 0; index < pages; index += 1) {
      const shot = await page.screenshot({
        type: 'jpeg',
        quality: 82,
        clip: { x: 0, y: index * PAGE_HEIGHT, width: PAGE_WIDTH, height: PAGE_HEIGHT },
      });
      images.push(shot);
    }
    await writeFile(outPath, imageOnlyPdf(images));
  } finally {
    await browser.close();
  }
}

/**
 * Writes a PDF whose every page is one JPEG, full bleed. Hand-written so the fixture needs no
 * PDF authoring dependency, and so the file is byte-stable for a given set of images.
 */
function imageOnlyPdf(images: readonly Buffer[]): Buffer {
  const parts: Buffer[] = [];
  const offsets = new Map<number, number>();
  let length = 0;
  const push = (value: string | Buffer): void => {
    const buffer = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
    parts.push(buffer);
    length += buffer.length;
  };

  push('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n');

  // Object 1 is the catalog and 2 is the page tree, both written at the end. Each page takes
  // three objects: the image, its content stream and the page itself.
  const pageIds: number[] = [];
  let nextId = 3;

  for (const jpeg of images) {
    const imageId = nextId;
    const contentId = nextId + 1;
    const pageId = nextId + 2;
    nextId += 3;
    pageIds.push(pageId);

    offsets.set(imageId, length);
    push(
      `${String(imageId)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${String(PAGE_WIDTH)} /Height ${String(PAGE_HEIGHT)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${String(jpeg.length)} >>\nstream\n`,
    );
    push(jpeg);
    push('\nendstream\nendobj\n');

    // A4 in points, so the page keeps the paper's physical size.
    const content = 'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q\n';
    offsets.set(contentId, length);
    push(
      `${String(contentId)} 0 obj\n<< /Length ${String(content.length)} >>\nstream\n${content}endstream\nendobj\n`,
    );

    offsets.set(pageId, length);
    push(
      `${String(pageId)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${String(imageId)} 0 R >> >> /Contents ${String(contentId)} 0 R >>\nendobj\n`,
    );
  }

  const kids = pageIds.map((id) => `${String(id)} 0 R`).join(' ');
  offsets.set(2, length);
  push(`2 0 obj\n<< /Type /Pages /Count ${String(pageIds.length)} /Kids [${kids}] >>\nendobj\n`);
  offsets.set(1, length);
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const xrefStart = length;
  let xref = `xref\n0 ${String(nextId)}\n0000000000 65535 f \n`;
  for (let id = 1; id < nextId; id += 1) {
    xref += `${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${String(nextId)} /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`,
  );

  return Buffer.concat(parts);
}

async function main(): Promise<void> {
  await mkdir(sourceDirectory, { recursive: true });
  await printPaper(join(sourceDirectory, 'paper.pdf'));
  await buildScan(join(sourceDirectory, 'scan.pdf'));
  console.log('wrote bench/pdf/paper.pdf and bench/pdf/scan.pdf');
}

await main();
