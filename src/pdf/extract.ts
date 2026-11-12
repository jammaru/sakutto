import type { Box } from './geometry';
import { figureAreas, type FigureAreas } from './figures';
import { traitsOfStyle, type FontTraits } from './fonts';
import { groupLines, isRotated, type TextLine, type TextPiece } from './lines';

/**
 * The parts of pdf.js's page proxy this reader touches, written out rather than imported.
 *
 * `import type { PDFPageProxy } from 'pdfjs-dist'` would be erased at build time, but it would
 * also make the type check depend on the package's own `.d.ts`, which describes a much larger
 * surface than anything here uses — including a worker entry point the bundler would try to
 * resolve. A structural type keeps the dependency to the packaged file and to a dynamic
 * import.
 */
export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

export interface PdfTextContent {
  items: Array<PdfTextItem | { type: string }>;
  styles: Record<string, { fontFamily?: string } | undefined>;
}

export interface PdfViewport {
  width: number;
  height: number;
  /**
   * pdf.js's 6-number page transform. `/Rotate 90` and `/Rotate 270` swap the page's axes,
   * and glyph positions in `item.transform` are still in unrotated PDF space; multiplying
   * through this matrix is what puts a cover on the canvas the reader actually drew.
   */
  transform?: number[];
}

export interface PdfPage {
  getViewport: (options: { scale: number }) => PdfViewport;
  getTextContent: () => Promise<PdfTextContent>;
  getOperatorList: () => Promise<PdfOperatorList>;
  commonObjs: { get: (name: string) => unknown };
  render: (options: Record<string, unknown>) => PdfRenderTask;
}

/** What `page.render` returns: the draw, and a way to abandon it when a newer draw starts. */
export interface PdfRenderTask {
  promise: Promise<void>;
  cancel?: () => void;
}

/** The operator list pdf.js builds for a page, as far as the reader reads it. */
export interface PdfOperatorList {
  fnArray: number[];
  argsArray: unknown[][];
}

/** The pdf.js operator codes the figure detection needs, passed in by the caller. */
export interface PdfOperatorCodes {
  OPS: Record<string, number>;
}

export interface PdfDocument {
  numPages: number;
  getPage: (index: number) => Promise<PdfPage>;
  getMetadata: () => Promise<{ info?: unknown } | null>;
  destroy: () => Promise<void>;
}

/**
 * One page of a PDF, as the reader needs it: the text laid out as lines, and the page's size
 * in points.
 */
export interface ExtractedPage {
  index: number;
  width: number;
  height: number;
  lines: TextLine[];
  /** Where the page paints its pictures, so the text inside them can be left alone. */
  figures: FigureAreas;
  /** The page carries no text layer, so there is nothing here to translate. */
  empty: boolean;
}

export interface OpenedDocument {
  document: PdfDocument;
  pageCount: number;
  /** Title from the document's metadata, or null when it has none. */
  title: string | null;
}

/**
 * Reads the title out of a document's metadata.
 *
 * A PDF's `/Title` is whatever the authoring tool wrote and is often the file name, so it is
 * only used when it carries a letter and is not simply the file's own name.
 */
export function titleFromMetadata(info: unknown, fileName: string): string | null {
  if (!info || typeof info !== 'object') return null;
  const title = (info as { Title?: unknown }).Title;
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  if (!/\p{L}/u.test(trimmed)) return null;
  if (trimmed === fileName) return null;
  return trimmed.slice(0, 300);
}

/**
 * Reads one page's text.
 *
 * pdf.js reports glyph positions in PDF space, where y grows upwards from the bottom of the
 * page. Everything downstream — the layout parser, the renderer, the DOM — works in the
 * browser's space, where y grows downwards from the top, so the flip happens here and only
 * here.
 */
export async function extractPage(
  page: PdfPage,
  index: number,
  codes: Record<string, number> | null = null,
): Promise<ExtractedPage> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const traits = await readFontTraits(page, content);
  const pieces: TextPiece[] = [];

  for (const item of content.items) {
    if (!('str' in item)) continue;
    if (item.str.length === 0) continue;
    const placed = placeTextItem(item, viewport);
    const font = traits.get(item.fontName) ?? {
      family: 'serif',
      bold: false,
      italic: false,
      math: false,
    };

    pieces.push({
      text: item.str,
      box: placed.box,
      baseline: placed.baseline,
      fontName: item.fontName,
      family: font.family,
      bold: font.bold,
      italic: font.italic,
      math: font.math,
      orientation: placed.orientation,
      size: placed.size,
      displayed: placed.displayed,
    });
  }

  const lines = groupLines(pieces);
  // The drawing areas have to be read from the operator list, which the font pass already
  // forced; this reuses it rather than parsing the content stream a third time.
  const operators = await page
    .getOperatorList()
    .then((value) => value as PdfOperatorList)
    .catch(() => null);
  const figures =
    codes === null
      ? { images: [] }
      : figureAreas(operators, codes, viewport.height, viewport.width, lines);

  return {
    index,
    width: viewport.width,
    height: viewport.height,
    lines,
    figures,
    empty: isImageOnlyPage(lines, figures, viewport.width, viewport.height),
  };
}

/**
 * True when the page has nothing a translator can read.
 *
 * A scanned page is a bitmap with no text layer, or a full-page image with only a stamp or
 * a watermark on top. Those pages are shown as drawn, with a note, rather than guessed at:
 * a transcription that invented words would be translated as if it were the source, which
 * is worse than leaving the image.
 */
export function isImageOnlyPage(
  lines: readonly TextLine[],
  figures: FigureAreas,
  width: number,
  height: number,
): boolean {
  const upright = lines.filter((line) => !isRotated(line) && line.text.trim().length > 0);
  if (upright.length === 0) return true;

  let chars = 0;
  for (const line of upright) chars += line.text.replace(/\s+/gu, '').length;
  if (chars < 12) return true;

  const pageArea = Math.max(1, width * height);
  let figureArea = 0;
  for (const image of figures.images) figureArea += image.width * image.height;
  return figureArea > pageArea * 0.8 && chars < 80;
}

/**
 * Maps one glyph run from PDF user space into the viewport the canvas was drawn in.
 *
 * pdf.js reports `item.transform` in unrotated page space. The viewport's own 6-number
 * matrix (`Util.transform` in pdf.js) includes `/Rotate`, so the three corners of the run
 * — origin, end of the advance, top of the em — become the axis-aligned box the overlay
 * paints. Without that multiply, a 90° page places covers off the canvas while the toolbar
 * still says the page is translated.
 *
 * Line grouping keys off the baseline perpendicular to the writing direction *after* that
 * rotation: `/Rotate 90` and `/Rotate 270` put a column of body lines on the same `origin.y`,
 * so the grouping coordinate has to be `origin.x` or every line in the column collapses into
 * one. The piece's `orientation` stays the text matrix's own angle — a page rotate does not
 * turn body text into a stamp — while `orientationOf` still sees the composed writing
 * direction so it can pick that axis.
 */
export function placeTextItem(
  item: PdfTextItem,
  viewport: PdfViewport,
): { box: Box; baseline: number; orientation: number; size: number; displayed: number } {
  const [a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform;
  const height = Math.hypot(c, d) || item.height || 1;
  const orientation = orientationOf(a, b);
  const matrix = viewport.transform;
  if (!matrix || matrix.length < 6) {
    const baseline = viewport.height - f;
    return {
      box: { x: e, y: baseline - height, width: item.width, height },
      baseline,
      orientation,
      size: height,
      displayed: orientation,
    };
  }
  const origin = applyViewport(matrix, e, f);
  const end = applyViewport(matrix, e + item.width, f);
  const top = applyViewport(matrix, e, f + height);
  const xs = [origin.x, end.x, top.x];
  const ys = [origin.y, end.y, top.y];
  const left = Math.min(...xs);
  const north = Math.min(...ys);
  const displayed = orientationOf(a, b, matrix);
  const size = Math.hypot(top.x - origin.x, top.y - origin.y) || height;
  return {
    box: {
      x: left,
      y: north,
      width: Math.max(...xs) - left,
      height: Math.max(...ys) - north,
    },
    baseline: displayed === 90 || displayed === 270 ? origin.x : origin.y,
    orientation,
    size,
    displayed,
  };
}

function applyViewport(matrix: readonly number[], x: number, y: number): { x: number; y: number } {
  return {
    x: (matrix[0] ?? 0) * x + (matrix[2] ?? 0) * y + (matrix[4] ?? 0),
    y: (matrix[1] ?? 0) * x + (matrix[3] ?? 0) * y + (matrix[5] ?? 0),
  };
}

function orientationOf(a: number, b: number, matrix?: readonly number[]): number {
  let dx = a;
  let dy = b;
  if (matrix && matrix.length >= 6) {
    dx = (matrix[0] ?? 0) * a + (matrix[2] ?? 0) * b;
    dy = (matrix[1] ?? 0) * a + (matrix[3] ?? 0) * b;
  }
  if (dx === 0 && dy === 0) return 0;
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized < 45 || normalized >= 315) return 0;
  return normalized < 135 ? 90 : normalized < 225 ? 180 : 270;
}

/**
 * Font names, once the page's fonts are resolved.
 *
 * The text content only knows pdf.js's internal aliases (`g_d0_f2`), and its `styles` map
 * reports one generic family per alias with no weight or slant. The real name — which carries
 * both — only exists on the font object, and that object is resolved during rendering, so the
 * operator list is built first to force it. That costs one parse of the page's content stream,
 * which is the same work the first render does and is cached with it.
 */
async function readFontTraits(
  page: PdfPage,
  content: PdfTextContent,
): Promise<Map<string, FontTraits>> {
  const names = new Set<string>();
  for (const item of content.items) {
    if (!('str' in item)) continue;
    names.add(item.fontName);
  }

  if (names.size > 0) await page.getOperatorList().catch(() => null);

  const traits = new Map<string, FontTraits>();
  for (const name of names) {
    let fontName = name;
    try {
      const font = page.commonObjs.get(name) as { name?: string; fallbackName?: string } | null;
      fontName = font?.name ?? font?.fallbackName ?? name;
    } catch {
      // The font was not resolved; the alias is all there is, and it carries no traits.
    }
    traits.set(name, traitsOfStyle(content.styles[name]?.fontFamily, fontName));
  }
  return traits;
}

/** Renders one page into a canvas at the given scale. */
export function renderPage(page: PdfPage, scale: number, canvas: HTMLCanvasElement): PdfRenderTask {
  const viewport = page.getViewport({ scale });
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return { promise: Promise.resolve() };

  // The page is drawn at the device's own resolution so a zoomed page stays sharp, and the
  // CSS size keeps it at the scale the reader asked for.
  const ratio = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${String(viewport.width)}px`;
  canvas.style.height = `${String(viewport.height)}px`;

  const task = page.render({
    canvasContext: context,
    viewport,
    ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }),
  });
  return {
    promise: task.promise,
    ...(typeof task.cancel === 'function' ? { cancel: () => task.cancel?.() } : {}),
  };
}

/** The box the page's text occupies, used for the reader's own layout decisions. */
export function textBounds(lines: readonly TextLine[]): Box | null {
  const first = lines[0];
  if (!first) return null;
  let left = first.box.x;
  let top = first.box.y;
  let right = first.box.x + first.box.width;
  let bottom = first.box.y + first.box.height;
  for (const line of lines) {
    left = Math.min(left, line.box.x);
    top = Math.min(top, line.box.y);
    right = Math.max(right, line.box.x + line.box.width);
    bottom = Math.max(bottom, line.box.y + line.box.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
