import { classifyPlainTextBreak, type PlainTextBreakKind } from './plain-text-line-breaks';

/**
 * Line-break marks for the typed page's source box (`wider` mode).
 *
 * The reader pastes OCR or book text where a hard line break is indistinguishable from
 * the box's own soft wrapping, especially when a wrapped line ends near the right margin.
 * A native textarea cannot draw anything per line, and faking extra spacing with a shifted
 * mirror behind transparent text would desynchronize the caret and mouse selection from
 * the visible lines, which breaks the very fixing this mode exists for. The marks are
 * therefore painted over the unmodified textarea: a subtle rule for breaks the
 * translation keeps, and a "↵" chip for breaks that sit inside a sentence. The value,
 * caret, IME, undo, and selection of the textarea are never touched.
 */

/** One hard source line plus the exact break characters that ended it. */
export interface SourceLineSegment {
  /** Line text without its trailing break. */
  text: string;
  /** The literal break after the line: '\n', '\r\n', '\r', or '' after the final line. */
  lineBreak: string;
}

/** A mark drawn after one source line. */
export interface SourceBreakMark {
  /** Index of the marked line in the segments `segmentSourceText` returned. */
  lineIndex: number;
  /**
   * The classification the translation itself uses: `boundary` breaks stay in the
   * translation, `mid-sentence` breaks are joined (and are the ones to spot and fix).
   */
  kind: PlainTextBreakKind;
}

const SOURCE_LINE_BREAK = /\r\n|\r|\n/gu;

/**
 * Splits text into hard lines while keeping the exact break characters. Joining
 * `text` and `lineBreak` back together reproduces the input byte for byte, so CRLF
 * input, lone CR, and a trailing newline all survive a round trip.
 */
export function segmentSourceText(text: string): SourceLineSegment[] {
  const segments: SourceLineSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(SOURCE_LINE_BREAK)) {
    const index = match.index ?? 0;
    segments.push({ text: text.slice(cursor, index), lineBreak: match[0] });
    cursor = index + match[0].length;
  }
  segments.push({ text: text.slice(cursor), lineBreak: '' });
  return segments;
}

/** `segmentSourceText` in reverse: the exact original string. */
export function rejoinSourceSegments(segments: readonly SourceLineSegment[]): string {
  return segments.map((segment) => segment.text + segment.lineBreak).join('');
}

/**
 * Marks the line breaks the box's own wrapping can disguise. A break next to an empty
 * line already renders as a visibly blank row — wider than any mark — so only breaks
 * between two consecutive non-empty lines are marked; those are the ones that look like
 * an ordinary soft wrap. The classification is the translation's own, so each mark says
 * what will actually happen to that break.
 */
export function sourceBreakMarksFromSegments(
  segments: readonly SourceLineSegment[],
): SourceBreakMark[] {
  const marks: SourceBreakMark[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = segments[index + 1];
    if (!segment || !next) continue;
    if (segment.lineBreak.length === 0) continue;
    const before = segment.text.trim();
    const after = next.text.trim();
    if (before.length === 0 || after.length === 0) continue;
    marks.push({ lineIndex: index, kind: classifyPlainTextBreak(before, after, 0) });
  }
  return marks;
}

/** Convenience wrapper: segments plus marks for one source string. */
export function sourceBreakMarks(text: string): SourceBreakMark[] {
  return sourceBreakMarksFromSegments(segmentSourceText(text));
}
