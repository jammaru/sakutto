/**
 * Composites the page the reader actually shows into one bitmap for export.
 *
 * The translated pane is a pdf.js canvas with absolutely positioned ".sakutto-cover"
 * elements on top. Re-laying that text out with a second font (as the old PDF writer did)
 * changed sizes, dropped headings and moved lines; the file no longer matched the pane the
 * reader was looking at. This module copies the stage instead: the original bitmap is drawn
 * at full export resolution and each cover is painted from its own DOM geometry and styles.
 * The one rule shared with the reader is the scale factor between the viewer CSS pixels and
 * the exported bitmap pixels, so a vertical cover keeps its rotation and its columns.
 */

export interface RasterStageOptions {
  /** The translated pane stage, including its cover layer. */
  stage: HTMLElement;
  /** The original page, rendered by pdf.js at export scale (not the on-screen bitmap). */
  base: HTMLCanvasElement;
  /** Page size in points, which is also the PDF page size. */
  pageWidth: number;
  pageHeight: number;
  /** Bitmap pixels per page point. */
  pixelRatio: number;
  /** CSS pixels per page point used by the viewer layout. */
  viewerScale: number;
}

function px(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** CSS rotation of one cover, in degrees; the reader only uses quarter turns. */
function rotationOf(transform: string | undefined): number {
  const match = transform ? /rotate\(\s*(-?[\d.]+)\s*(?:deg)?\s*\)/u.exec(transform) : null;
  const value = match ? Number.parseFloat(match[1] ?? '') : 0;
  return Number.isFinite(value) ? value : 0;
}

/**
 * Paints one cover in its own (pre-transform) coordinates, then lets the canvas rotation
 * place it on the page. This mirrors CSS: the cover has transform-origin 0 0, overflow
 * hidden, a fixed line-height and one pre-formatted line per row.
 */
function paintCover(
  context: CanvasRenderingContext2D,
  node: HTMLElement,
  x: number,
  y: number,
  width: number,
  height: number,
  factor: number,
): void {
  const computed = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
  const angle = rotationOf(node.style.transform || computed?.transform || undefined);
  const background = computed?.backgroundColor ?? '#ffffff';
  const opaque =
    background.length > 0 &&
    background !== 'transparent' &&
    !/^rgba\([^)]*,\s*0\s*\)$/u.test(background);

  context.save();
  context.translate(x, y);
  if (angle !== 0) context.rotate((angle * Math.PI) / 180);
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();

  if (opaque) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  }

  const lines = (node.textContent ?? '').split(/\r?\n/u);
  if (lines.some((line) => line.length > 0)) {
    const sizeCss = Math.max(1, px(computed?.fontSize) ?? 12);
    const size = sizeCss * factor;
    const family = computed?.fontFamily || 'sans-serif';
    const weight = computed?.fontWeight || '400';
    const fontStyle = computed?.fontStyle || 'normal';
    const font = fontStyle + ' ' + weight + ' ' + size.toFixed(3) + 'px ' + family;
    context.font = font;
    // An unusable family list is ignored by canvas; keep the cover readable in that case.
    if (!context.font) context.font = weight + ' ' + size.toFixed(3) + 'px sans-serif';

    const lineCss = Math.max(1, px(computed?.lineHeight) ?? sizeCss * 1.2);
    const lineHeight = lineCss * factor;
    const metrics = context.measureText('Mg');
    const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || size * 0.82;
    const descent =
      metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || size * 0.18;
    const firstBaseline = Math.max(0, (lineHeight - ascent - descent) / 2) + ascent;

    const rtl = computed?.direction === 'rtl';
    const align = computed?.textAlign ?? 'start';
    let textX = 0;
    let canvasAlign: CanvasTextAlign = 'left';
    if (align === 'center') {
      textX = width / 2;
      canvasAlign = 'center';
    } else if (align === 'right' || (align === 'end' && !rtl) || (align === 'start' && rtl)) {
      textX = width;
      canvasAlign = 'right';
    }
    context.textAlign = canvasAlign;
    context.textBaseline = 'alphabetic';
    context.fillStyle = computed?.color || '#111111';

    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      const baseline = firstBaseline + index * lineHeight;
      if (baseline - ascent > height) break;
      context.fillText(line, textX, baseline);
    }
  }

  // A clipped cover fades its last line in the reader, so the reader can tell there is more
  // text behind the marker. Keep that cue in the file too.
  if (node.dataset.clipped === 'true') {
    const fade = Math.max(1, (px(computed?.fontSize) ?? 12) * factor * 1.2);
    const gradient = context.createLinearGradient(0, height - fade, 0, height);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
    gradient.addColorStop(1, '#ffffff');
    context.fillStyle = gradient;
    context.fillRect(0, height - fade, width, fade);
  }
  context.restore();
}

/**
 * Draws the translated stage into a fresh canvas at pixelRatio pixels per page point.
 *
 * Geometry comes from the cover inline styles rather than getBoundingClientRect: an
 * off-screen page still has the right layout, while a viewport rect can be far outside the
 * window during an export of the whole document.
 */
export function rasterizeStage(options: RasterStageOptions): HTMLCanvasElement {
  const output = document.createElement('canvas');
  output.width = Math.max(1, Math.round(options.pageWidth * options.pixelRatio));
  output.height = Math.max(1, Math.round(options.pageHeight * options.pixelRatio));
  const context = output.getContext('2d');
  if (!context) return output;

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(options.base, 0, 0, output.width, output.height);

  // Reader CSS pixels to exported bitmap pixels. Both scales can carry the device ratio.
  const factor = options.pixelRatio / Math.max(0.01, options.viewerScale);
  context.save();
  context.beginPath();
  context.rect(0, 0, output.width, output.height);
  context.clip();
  for (const node of options.stage.querySelectorAll<HTMLElement>('.sakutto-cover')) {
    const x = px(node.style.left) ?? node.offsetLeft;
    const y = px(node.style.top) ?? node.offsetTop;
    const width = px(node.style.width) ?? node.offsetWidth;
    const height = px(node.style.height) ?? node.offsetHeight;
    if (width <= 0 || height <= 0) continue;
    paintCover(context, node, x * factor, y * factor, width * factor, height * factor, factor);
  }
  context.restore();
  return output;
}
