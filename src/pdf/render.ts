import { fontStack } from './fonts';
import type { Box } from './geometry';
import type { BlockTraits } from './session';

/**
 * The measurement a fit depends on.
 *
 * A canvas is used rather than the DOM because a fit is computed for many candidate sizes
 * before anything is drawn, and laying text out in a detached element for each candidate
 * would force a style recalculation per block. The context is the same text shaper the
 * renderer uses, so a measured line breaks where the drawn one does.
 */
export class TextMeasurer {
  private readonly context: CanvasRenderingContext2D | null;
  private readonly cache = new Map<string, number>();

  constructor() {
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    this.context = canvas?.getContext('2d') ?? null;
  }

  /** Width of `text` at `fontSize` points, in points. */
  measure(
    text: string,
    fontSize: number,
    traits: BlockTraits,
    target: 'ja' | 'en' | 'other',
  ): number {
    const key = `${traits.family}|${traits.bold ? 'b' : ''}${traits.italic ? 'i' : ''}|${target}|${fontSize.toFixed(2)}|${text}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    let width: number;
    if (this.context) {
      this.context.font = cssFont(fontSize, traits, target);
      width = this.context.measureText(text).width;
    } else {
      // No canvas (a unit test, or a document that refused one): a rough width is enough to
      // make the fit's search terminate, and the renderer re-fits what it draws.
      let cjk = 0;
      for (const character of text) {
        if (
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)
        ) {
          cjk += 1;
        }
      }
      width = cjk * fontSize + (text.length - cjk) * fontSize * 0.5;
    }

    // The cache is keyed per size, so it would grow without bound on a long document. A cap
    // keeps the memory flat; an entry is cheap to recompute.
    if (this.cache.size > 20_000) this.cache.clear();
    this.cache.set(key, width);
    return width;
  }

  clear(): void {
    this.cache.clear();
  }
}

/** The CSS `font` shorthand for one trait set, which is what a canvas measures with. */
export function cssFont(
  fontSize: number,
  traits: BlockTraits,
  target: 'ja' | 'en' | 'other' = 'en',
): string {
  const style = traits.italic ? 'italic ' : '';
  const weight = traits.bold ? '700 ' : '400 ';
  return `${style}${weight}${String(fontSize)}px ${fontStack(traits, target)}`;
}

/** The inline style for one translated block, in pixels of the rendered page. */
export function coverStyle(
  box: Box,
  fontSize: number,
  lineHeight: number,
  traits: BlockTraits,
  align: 'left' | 'center' | 'right',
  target: 'ja' | 'en' | 'other' = 'en',
): string {
  return [
    `left:${box.x.toFixed(2)}px`,
    // The box sits where the source's first line was, and grows downwards from there.
    `top:${box.y.toFixed(2)}px`,
    `width:${box.width.toFixed(2)}px`,
    `font-size:${fontSize.toFixed(2)}px`,
    `line-height:${lineHeight.toFixed(2)}px`,
    `font-family:${fontStack(traits, target)}`,
    `font-weight:${traits.bold ? '700' : '400'}`,
    `font-style:${traits.italic ? 'italic' : 'normal'}`,
    `text-align:${align === 'left' ? 'start' : align}`,
  ].join(';');
}

/**
 * Horizontal ink that overflowed a painted cover, in CSS pixels.
 *
 * `scrollWidth > clientWidth` is the check Chromium uses when `white-space: pre` and
 * `overflow: hidden` clip a last glyph that canvas `measureText` thought would fit.
 */
export function coverInkOverflowPx(node: Pick<HTMLElement, 'scrollWidth' | 'clientWidth'>): number {
  return Math.max(0, node.scrollWidth - node.clientWidth);
}

/**
 * The stylesheet the reader injects for its pages and the boxes over them.
 *
 * Colours are literal rather than custom properties: the reader page owns its own palette,
 * and a translated box must paint the paper colour exactly, or a second or two after a
 * translation lands the source glyphs underneath would show through it. A custom property
 * that failed to resolve is invisible in review and very visible on screen.
 */
export const READER_STYLE = `
.sakutto-page {
  position: relative;
  background: #ffffff;
  box-shadow: 0 1px 2px rgb(15 23 32 / 12%), 0 8px 24px rgb(15 23 32 / 10%);
}

.sakutto-page__pane--translated {
  position: absolute;
  inset: 0;
}

.sakutto-page__pane--original {
  display: none;
}

.sakutto-page__stage {
  position: relative;
  width: 100%;
  height: 100%;
}

.sakutto-page__caption {
  display: none;
  margin: 0 0 6px;
  color: #4b5563;
  font: 600 11px/1.3 "Segoe UI", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif;
}

.sakutto-page__canvas {
  display: block;
  width: 100%;
  height: 100%;
}

[data-compare="true"] .sakutto-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  background: transparent;
  box-shadow: none;
}

[data-compare="true"] .sakutto-page__pane--original,
[data-compare="true"] .sakutto-page__pane--translated {
  position: relative;
  inset: auto;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  box-shadow: 0 1px 2px rgb(15 23 32 / 12%), 0 8px 24px rgb(15 23 32 / 10%);
}

[data-compare="true"] .sakutto-page__caption {
  display: block;
}

[data-compare="true"] .sakutto-page__stage {
  height: auto;
  flex: none;
}

/*
 * The selectable text layer. The glyphs are transparent, not hidden: a reader drags over this
 * layer to copy a phrase or to translate only that part, and visibility: hidden would take
 * the spans out of selection entirely. The ::selection rule paints the highlight the browser
 * would have drawn over real text.
 */
.sakutto-page__text {
  position: absolute;
  inset: 0;
  z-index: 3;
  overflow: hidden;
  user-select: text;
  -webkit-user-select: text;
  line-height: 1;
}

.sakutto-page__text span {
  position: absolute;
  display: block;
  overflow: hidden;
  white-space: pre;
  color: transparent;
  cursor: text;
  transform-origin: 0 0;
}

.sakutto-page__text ::selection {
  background: color-mix(in srgb, var(--accent, #2563eb) 32%, transparent);
  color: transparent;
}

/*
 * A selection's translation, shown beside the selection rather than over it: a reader who
 * asked for one paragraph wants to compare it with the original.
 */
.sakutto-select {
  position: absolute;
  z-index: 5;
  max-height: 45%;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid color-mix(in srgb, var(--accent, #2563eb) 35%, #d5dbe4);
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 6px 22px rgb(15 23 32 / 16%);
  color: #111111;
  font: 13px/1.65 "Hiragino Sans", "Noto Sans JP", "Yu Gothic", system-ui, sans-serif;
  white-space: pre-wrap;
}

.sakutto-select[hidden] {
  display: none;
}

.sakutto-select[data-state="failed"] {
  color: #8a1f1f;
}

.sakutto-page__layer {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: hidden;
}

/*
 * A translated block paints the paper over the source text, because the page image under it
 * still holds the original glyphs. The box reads as part of the page only when its background
 * is the same colour as the paper.
 */
.sakutto-cover {
  position: absolute;
  margin: 0;
  padding: 0;
  background: #ffffff;
  color: #111111;
  overflow: hidden;
  /* Wrapping is done in script against a measured width. Letting CSS wrap again is what
     made a line that fitted in the canvas overflow the box and vanish under overflow:hidden. */
  white-space: pre;
  overflow-wrap: normal;
  word-break: keep-all;
  font-kerning: normal;
  text-align: start;
}

/* The clipped case: the box is capped and its last line fades, so a reader can tell there is
   more text without the page gaining a scrollbar. */
.sakutto-cover[data-clipped="true"]::after {
  content: "";
  position: absolute;
  inset: auto 0 0 0;
  height: 1.2em;
  background: linear-gradient(to bottom, rgb(255 255 255 / 0%), #ffffff);
  pointer-events: none;
}

.sakutto-page__missing {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: none;
  place-content: center;
  padding: 24px;
  background: rgb(255 255 255 / 82%);
  color: #1f2937;
  font: 13px/1.55 "Segoe UI", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif;
  text-align: center;
}

/* Only a page with no text layer shows the notice; every other page keeps it out of the way
   without having to remove the node. The default is none so a page that never sets the flag
   cannot leave the notice on screen. */
.sakutto-page[data-page-empty="true"] .sakutto-page__missing {
  display: grid;
}

.sakutto-page__render-failed {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: none;
  place-content: center;
  padding: 24px;
  background: rgb(255 255 255 / 82%);
  color: #1f2937;
  font: 13px/1.55 "Segoe UI", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif;
  text-align: center;
}

.sakutto-page[data-render-failed="true"]:not([data-page-empty="true"]) .sakutto-page__render-failed {
  display: grid;
}

/*
 * Marker for a translation that did not fit in place. It sits on the source box so a reader
 * can open the full text without the page painting a cut sentence over the original.
 */
.sakutto-overflow {
  position: absolute;
  z-index: 5;
  padding: 0;
  border: 2px solid #ffffff;
  border-radius: 999px;
  background: #1d4ed8;
  box-shadow: 0 1px 2px rgb(15 23 32 / 35%);
  cursor: pointer;
}
.sakutto-overflow:hover,
.sakutto-overflow[aria-expanded="true"] {
  background: #1e40af;
}
.sakutto-overflow:focus-visible {
  outline: 2px solid #1d4ed8;
  outline-offset: 2px;
}
`;
