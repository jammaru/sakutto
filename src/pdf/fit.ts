import type { Box } from './geometry';
import type { AnyBlockRole } from './layout';

/**
 * How a translated block is set inside the box its source filled.
 *
 * The hard part of laying a translation back onto a PDF page is that the two languages are
 * not the same length. Japanese set from English is typically 10–25% shorter in characters
 * but needs more line height, and German set from English is 20% longer outright. So the
 * translation can neither be drawn at the source's exact size and allowed to overflow, nor
 * be shrunk until it is unreadable.
 */
export interface FitRequest {
  /** The box the source text occupied, in points. */
  box: Box;
  /**
   * The room the block may grow down into, in points. This is the distance to the next block
   * below it in the same column, so growth never covers a following paragraph.
   */
  growBudget: number;
  /** Font size of the source text, in points. */
  fontSize: number;
  /** Line height the source used, as a multiple of the font size. */
  lineHeight: number;
  /** Width the text is wrapped to, in points. Normally the column's own width. */
  width: number;
  /** Measures one line of wrapped text at a candidate size, in points. */
  measure: (text: string, fontSize: number) => number;
  /** Role of the block, which decides how small body type may go. */
  role?: AnyBlockRole;
}

export type FitResult =
  | {
      fits: true;
      /** Font size to draw at, in points. */
      fontSize: number;
      /** Line height to draw at, in points. */
      lineHeight: number;
      lines: string[];
      height: number;
      /** True when the block had to grow past the source box to fit. */
      grown: boolean;
    }
  | {
      /** Even the smallest size overflows; the caller must clip or offer the full text. */
      fits: false;
      fontSize: number;
      lineHeight: number;
      lines: string[];
      height: number;
      /** Lines that fit in the space available, for the clipped rendering. */
      visibleLines: string[];
    };

/** Never shrink below this fraction of the source size; below it the text is unreadable. */
export const MIN_SCALE = 0.72;
/** An absolute floor, in points: CJK below this is a grey smear even when the scale allows it. */
export const MIN_FONT_SIZE = 6.5;
/**
 * Body type originally set at 9pt or larger may shrink a little further than the general
 * floor, because a 9pt paragraph that wraps to Japanese still has to fit two lines into a
 * box that was one Latin line. Labels, captions and headings keep the stricter 6.5pt floor.
 */
export const BODY_MIN_FONT_SIZE = 6;
/** Scale floor for that same body case: 9pt × 0.67 is just over 6pt. */
export const BODY_MIN_SCALE = 0.67;
/**
 * A block may grow by at most this multiple of its own height, even with empty space below.
 * The free-space model already stops at the next obstacle; this only caps a last paragraph
 * that would otherwise become a tall column of its own.
 */
const MAX_GROWTH = 2.2;
/**
 * Minimum leading for Japanese set from a Latin source. Its glyphs fill the em box, so a
 * leading that was comfortable for Times looks cramped in a Gothic face; a source that
 * already set a generous leading keeps it, which is why this is a floor and not a multiplier.
 *
 * 1.22 sits in the 1.15–1.25 range used for Japanese body type: tight enough that a
 * paragraph can wrap to one extra line inside the source box, loose enough that glyphs do
 * not collide.
 */
const CJK_MIN_LEADING = 1.22;
/** A fit is allowed to miss the space available by this much, in points. */
const SLACK = 1;

/**
 * Picks the largest font size at which the wrapped text fits the space available.
 *
 * The search is over a handful of candidate sizes rather than a binary search, because
 * wrapping is not monotonic in size — a word that fits on one line at 8.6pt can push a whole
 * line down, and a binary search can then accept a size that overflows. Six candidates
 * between the smallest allowed size and the source size are enough for a box whose height is
 * fixed, and each is measured exactly.
 */
export function fitText(
  request: FitRequest,
  text: string,
  target: 'ja' | 'en' | 'other',
): FitResult {
  const leading =
    target === 'ja' ? Math.max(request.lineHeight, CJK_MIN_LEADING) : request.lineHeight;
  // Trust the free-space budget as the wall. Cap only so a last paragraph cannot become a
  // tall column of its own; one extra Japanese line is always allowed when any room exists,
  // because an 8pt source line that wraps once is the common case.
  const extraLine = request.fontSize * leading;
  const growthCap = Math.max(request.box.height * MAX_GROWTH, extraLine);
  const ceiling = request.box.height + Math.min(request.growBudget, growthCap);
  const minimum = minFontFor(request);
  const kinsoku = target === 'ja';

  const candidates: number[] = [];
  for (let step = 0; step <= 6; step += 1) {
    candidates.push(request.fontSize - ((request.fontSize - minimum) * step) / 6);
  }

  let best: { fontSize: number; lines: string[]; height: number; lineHeight: number } | null = null;
  for (const size of candidates) {
    const lines = wrapText(text, request.width, (value) => request.measure(value, size), kinsoku);
    const layout = lineLayout(lines.length, size, leading, ceiling);
    if (layout.height <= ceiling + SLACK) {
      best = { fontSize: size, lines, height: layout.height, lineHeight: layout.lineHeight };
      break;
    }
  }

  if (best) {
    return {
      fits: true,
      fontSize: best.fontSize,
      lineHeight: best.lineHeight,
      lines: best.lines,
      height: best.height,
      grown: best.height > request.box.height + 0.5,
    };
  }
  const fontSize = minimum;
  const lines = wrapText(text, request.width, (value) => request.measure(value, fontSize), kinsoku);
  const layout = lineLayout(lines.length, fontSize, leading, ceiling);
  const count = Math.max(1, Math.floor((ceiling + SLACK) / Math.max(1, layout.lineHeight)));
  return {
    fits: false,
    fontSize,
    lineHeight: layout.lineHeight,
    lines,
    height: layout.height,
    visibleLines: lines.slice(0, count),
  };
}

/**
 * Height a wrapped block occupies, and the CSS line-height to draw it at.
 *
 * Leading only stacks between lines. A one-line Japanese label in an 8pt Latin box cannot
 * pay 1.34× leading — that would make even a single glyph taller than the source — so the
 * line-height is clamped to the space the fit is allowed to use.
 */
function lineLayout(
  lineCount: number,
  size: number,
  leading: number,
  ceiling: number,
): { height: number; lineHeight: number } {
  const stacked = size * leading;
  if (lineCount <= 1) {
    const lineHeight = Math.min(stacked, Math.max(size, ceiling));
    return { height: size, lineHeight };
  }
  return { height: lineCount * stacked, lineHeight: stacked };
}

/**
 * Wraps text to a width that may change with the font size.
 *
 * Wrapping is by word for a script that separates words and by character for one that does
 * not, because a Japanese paragraph has no spaces and treating it as one unbreakable word
 * would draw a single line off the side of the page. Both cases keep the text's own spaces.
 */
export function wrapText(
  text: string,
  width: number,
  measure: (value: string) => number,
  kinsoku = false,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (width <= 0) return [trimmed];

  const tokens = tokenize(trimmed);
  const lines: string[] = [];
  let current = '';

  for (const token of tokens) {
    const candidate = current.length === 0 ? token : current + token;
    // A trailing space hangs at the end of a line in CSS, so it must not decide the break.
    if (current.length > 0 && measure(candidate.trimEnd()) > width) {
      lines.push(current.trimEnd());
      current = token.trimStart();
      continue;
    }
    // One token wider than the whole column: break inside it rather than overflow.
    if (current.length === 0 && measure(token) > width) {
      const pieces = breakToken(token, width, measure);
      const last = pieces.pop() ?? '';
      lines.push(...pieces);
      current = last;
      continue;
    }
    current = candidate;
  }

  if (current.trim().length > 0) lines.push(current.trimEnd());
  return kinsoku ? applyKinsoku(lines) : lines;
}

/**
 * Japanese line-break rules: a line must not start with closing punctuation, and must not
 * end with opening punctuation. Characters that would land on the wrong side of a break are
 * moved to the neighbouring line.
 */
const KINSOKU_NO_START =
  /[、。，．・？！）\]｝」』】ゝゞ々ーァィゥェォッャュョヮぁぃぅぇぉっゃゅょゎ]/u;
const KINSOKU_NO_END = /[[（［｛「『【]/u;

function applyKinsoku(lines: readonly string[]): string[] {
  const next = [...lines];
  for (let index = 1; index < next.length; index += 1) {
    while ((next[index]?.length ?? 0) > 0 && KINSOKU_NO_START.test(next[index]?.[0] ?? '')) {
      next[index - 1] = `${next[index - 1] ?? ''}${next[index]?.[0] ?? ''}`;
      next[index] = next[index]?.slice(1) ?? '';
    }
    if ((next[index]?.length ?? 0) === 0) {
      next.splice(index, 1);
      index -= 1;
    }
  }
  for (let index = 0; index < next.length - 1; index += 1) {
    while ((next[index]?.length ?? 0) > 0 && KINSOKU_NO_END.test(next[index]?.at(-1) ?? '')) {
      const mark = next[index]?.at(-1) ?? '';
      next[index] = next[index]?.slice(0, -1) ?? '';
      next[index + 1] = `${mark}${next[index + 1] ?? ''}`;
    }
    if ((next[index]?.length ?? 0) === 0) {
      next.splice(index, 1);
      index -= 1;
    }
  }
  return next.filter((line) => line.length > 0);
}

/** Smallest type a block may use, in points. Body paragraphs originally ≥9pt may go to 6pt. */
function minFontFor(request: FitRequest): number {
  const body = request.role === 'prose' && request.fontSize >= 9 - 1e-9;
  const floor = body ? BODY_MIN_FONT_SIZE : MIN_FONT_SIZE;
  const scale = body ? BODY_MIN_SCALE : MIN_SCALE;
  return Math.max(request.fontSize * scale, Math.min(request.fontSize, floor));
}

/**
 * Splits text into wrap units: a word with its trailing space for a script that separates
 * words, and single characters for one that does not. A run of Latin characters inside a
 * Japanese line stays a word, so a URL or an identifier is never broken in the middle.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const pattern = /[\p{Script=Latin}\p{N}\p{P}\p{S}]+|\s+|[^\s]/gu;
  let pending = '';
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    if (/^\s+$/u.test(value)) {
      // A space belongs to the token before it, so a line that breaks after a word keeps the
      // space at the end of the previous line where it is invisible.
      if (tokens.length > 0) tokens[tokens.length - 1] += ' ';
      else pending += value;
      continue;
    }
    tokens.push(pending + value);
    pending = '';
  }
  if (pending.length > 0) tokens.push(pending);
  return tokens;
}

/** Breaks one over-wide token into pieces that each fit. */
function breakToken(token: string, width: number, measure: (value: string) => number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const character of token) {
    const candidate = current + character;
    if (current.length > 0 && measure(candidate) > width) {
      pieces.push(current);
      current = character;
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

/** The distance from a block's bottom to the next thing below it in its column. */
export function growBudgetFor(
  block: Box,
  below: readonly Box[],
  columnRight: number,
  pageBottom = Infinity,
): number {
  let nearest = pageBottom;
  for (const candidate of below) {
    // A box that starts beyond this column's right edge is in another column.
    if (candidate.x > columnRight - 0.5) continue;
    // A box that ends before this column starts is in another column too.
    if (candidate.x + candidate.width < block.x + 0.5) continue;

    // A neighbour that begins above this block's bottom is not *below* it: the two share a
    // row. Growing into it would put this block's text on top of that one's — but only when
    // the neighbour actually occupies this block's own measure. A figure to the side of a
    // paragraph, or a cell in the next column of the same table, must not zero the budget;
    // the paragraph can still grow into the empty space under its own words.
    const overlapX =
      Math.min(block.x + block.width, candidate.x + candidate.width) -
      Math.max(block.x, candidate.x);
    if (candidate.y < block.y + block.height - 0.5) {
      if (candidate.y + candidate.height > block.y + block.height + 0.5 && overlapX > 4) {
        return 0;
      }
      continue;
    }
    nearest = Math.min(nearest, candidate.y);
  }
  // Growth is measured from the block's own bottom edge with a small margin taken off, because
  // a translated box that ended exactly at the next block's top edge reads as touching it.
  const CLEARANCE = 2;
  if (!Number.isFinite(nearest)) return DEFAULT_GROWTH;
  return Math.max(0, nearest - (block.y + block.height) - CLEARANCE);
}

/**
 * Room a block may take when nothing follows it in its column: the foot of the page, in
 * practice. A fixed allowance keeps a last paragraph from growing past the page's margin.
 */
const DEFAULT_GROWTH = 120;
