/**
 * Deterministic layout for the offline replay harness.
 *
 * happy-dom does not perform text layout. This model intentionally covers only the
 * live original viewport: normal wrapping, anywhere-breaks for long tokens, and a
 * bottom-anchored viewport containing the last two lines. It is not a browser text
 * measurement engine and never reads media or network data.
 */
export interface ReplayOriginalGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  lineCount: number;
  firstVisibleLine: number;
  visibleLines: readonly string[];
  visibleText: string;
  clippedChars: number;
}

export const REPLAY_ORIGINAL_LEFT = 32;
export const REPLAY_ORIGINAL_TOP = 244;
export const REPLAY_ORIGINAL_WIDTH = 576;
export const REPLAY_ORIGINAL_HEIGHT = 72;
export const REPLAY_ORIGINAL_ROWS = 2;

const HORIZONTAL_PADDING = 12;
const CONTENT_WIDTH = REPLAY_ORIGINAL_WIDTH - HORIZONTAL_PADDING * 2;

/** Approximate relative glyph widths; only wrapping invariants matter to replay. */
function glyphWidth(character: string): number {
  if (/\s/u.test(character)) return 5;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)) return 20;
  if (/[\p{P}\p{S}]/u.test(character)) return 6;
  if (/[A-Z0-9]/u.test(character)) return 12;
  return 10;
}

function textWidth(text: string): number {
  let width = 0;
  for (const character of text) width += glyphWidth(character);
  return width;
}

function splitLongToken(token: string, lines: string[]): void {
  let line = lines.pop() ?? '';
  for (const character of token) {
    if (line && textWidth(line + character) > CONTENT_WIDTH) {
      lines.push(line);
      line = '';
    }
    line += character;
  }
  lines.push(line);
}

/** Wrap like white-space: normal plus overflow-wrap: anywhere. */
export function wrapReplayCaptionText(text: string): string[] {
  const normalized = text.trim().replace(/\s+/gu, ' ');
  if (!normalized) return [];
  const lines: string[] = [''];
  for (const word of normalized.split(' ')) {
    const line = lines.at(-1) ?? '';
    const candidate = line ? `${line} ${word}` : word;
    if (line && textWidth(candidate) <= CONTENT_WIDTH) {
      lines[lines.length - 1] = candidate;
      continue;
    }
    if (!line && textWidth(word) <= CONTENT_WIDTH) {
      lines[0] = word;
      continue;
    }
    if (line) lines.push('');
    splitLongToken(word, lines);
  }
  return lines;
}

/**
 * Lay out the original in a fixed-height, last-two-lines viewport. Characters on
 * lines intentionally rolled above the viewport are not clipping: clipping here
 * means horizontal truncation of a wrapped line, which must never occur.
 */
export function replayOriginalGeometry(text: string): ReplayOriginalGeometry {
  const lines = wrapReplayCaptionText(text);
  const firstVisibleLine = Math.max(0, lines.length - REPLAY_ORIGINAL_ROWS);
  const visibleLines = lines.slice(firstVisibleLine);
  let clippedChars = 0;
  for (const line of lines) {
    if (textWidth(line) <= CONTENT_WIDTH) continue;
    let remainingWidth = 0;
    let visibleChars = 0;
    for (const character of line) {
      remainingWidth += glyphWidth(character);
      if (remainingWidth <= CONTENT_WIDTH) visibleChars += character.length;
    }
    clippedChars += Math.max(0, line.length - visibleChars);
  }
  return {
    left: REPLAY_ORIGINAL_LEFT,
    top: REPLAY_ORIGINAL_TOP,
    width: REPLAY_ORIGINAL_WIDTH,
    height: REPLAY_ORIGINAL_HEIGHT,
    lineCount: lines.length,
    firstVisibleLine,
    visibleLines,
    visibleText: visibleLines.join(' '),
    clippedChars,
  };
}
