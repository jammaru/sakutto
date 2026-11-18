import { hasSentenceTerminator, sentenceSpans } from '@/engine/text/sentences';
import type { PlainTextLineBreakMode } from './settings';
import { normalizeTypedInput } from './typed-translation';

/**
 * `none` is the historical behaviour and must stay byte-for-byte identical: the model
 * receives the joined paragraph and the translation is shown as it comes back.
 */
export { PLAIN_TEXT_LINE_BREAK_MODES, normalizePlainTextLineBreaks } from './settings';
export type { PlainTextLineBreakMode } from './settings';

/** A break is either a hard boundary or a wrapped/OCR line inside a sentence. */
export type PlainTextBreakKind = 'boundary' | 'mid-sentence';

export interface PlainTextBreak {
  /** UTF-16 offset in `modelText` immediately after the previous source line. */
  modelOffset: number;
  kind: PlainTextBreakKind;
  /** True when one or more blank source lines separate the two lines. */
  blank: boolean;
  /** Number of blank source lines between the two non-empty lines. */
  blankLines: number;
  /** Previous non-empty source line. */
  before: string;
  /** Next non-empty source line. */
  after: string;
}

export interface PlainTextBreakMap {
  /** Normalized source snapshot the offsets were measured on. */
  source: string;
  /** Text sent to the model: wrapped lines joined, paragraph gaps preserved. */
  modelText: string;
  /** Breaks between non-empty source lines, in source order. */
  breaks: readonly PlainTextBreak[];
}

export interface PreparedPlainText {
  modelText: string;
  breakMap: PlainTextBreakMap;
}

const LIST_ITEM = /^\s*(?:[-*•·‣▪◦]|\d+[.)]|[①-⑳])\s+/u;
const HEADING_START =
  /^(?:#{1,6}\s+|(?:chapter|part|section|book|volume|appendix|prologue|epilogue)\b|(?:第[0-9一二三四五六七八九十百千]+[章節节部]))/iu;
const CONTINUATION_END = /[,;:，、；：\-–—/]$/u;
const SENTENCE_START = /^[\p{Lu}\p{Lt}\p{N}"'“‘([]/u;
const CJK_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * A short line with no terminal punctuation can be a heading when the next line starts
 * a new sentence. Wrapped OCR lines usually continue with a lower-case word or a comma,
 * and those stay mid-sentence so the break can move to the sentence end.
 */
function isHeadingLike(before: string, after: string): boolean {
  const text = before.trim();
  if (text.length === 0 || text.length >= 60) return false;
  if (hasSentenceTerminator(text) || CONTINUATION_END.test(text)) return false;
  if (HEADING_START.test(text)) return true;
  if (/^[A-Z0-9][^a-z]*$/u.test(text) && text.length > 3) return true;
  const words = text.split(/\s+/u).length;
  return words <= 8 && (SENTENCE_START.test(after) || CJK_START.test(after));
}

function classifyBreak(before: string, after: string, blankLines: number): PlainTextBreakKind {
  if (blankLines > 0) return 'boundary';
  if (LIST_ITEM.test(before)) return 'boundary';
  if (hasSentenceTerminator(before)) return 'boundary';
  if (isHeadingLike(before, after)) return 'boundary';
  return 'mid-sentence';
}

/**
 * The same classification the translation mapping uses, exposed for the typed-page source
 * marks so the marks a reader sees on the input agree with what the translation will do
 * at that break: `boundary` breaks stay, `mid-sentence` breaks are joined for the model.
 */
export function classifyPlainTextBreak(
  before: string,
  after: string,
  blankLines: number,
): PlainTextBreakKind {
  return classifyBreak(before, after, blankLines);
}

/**
 * Text the engine should receive and the break map used when reformatting the result.
 * In `none` mode the supplied source is sent unchanged so translations stay identical
 * to the previous release; joining happens only when the reader asked for visible breaks.
 */
export function plainTextTranslationInput(
  normalizedSource: string,
  mode: PlainTextLineBreakMode,
): { engineText: string; breakMap: PlainTextBreakMap | null } {
  if (mode === 'none') {
    return { engineText: normalizedSource, breakMap: null };
  }
  const prepared = preparePlainTextForModel(normalizedSource);
  return { engineText: prepared.modelText, breakMap: prepared.breakMap };
}

/**
 * Canonical source for a selection request. `none` matches the historical engine input
 * exactly: trim the ends but keep internal spacing. Other modes use the same normalization
 * as break mapping, so offer/dedupe comparisons and engine input agree.
 */
export function plainTextSelectionSource(text: string, mode: PlainTextLineBreakMode): string {
  return mode === 'none' ? text.trim() : normalizeTypedInput(text);
}

/**
 * Builds the model input and records where each source line break landed.
 *
 * The source is first normalized exactly like the typed box already does: CRLF/CR
 * become LF, horizontal whitespace collapses, and the ends are trimmed. Each line is
 * trimmed at the break too, so stray spaces before a newline cannot double the join
 * space or move a break offset out of its sentence. A single LF inside a paragraph
 * becomes a space so the model translates whole sentences; a blank line becomes
 * `\n\n` so paragraphs stay separate.
 */
export function preparePlainTextForModel(normalizedSource: string): PreparedPlainText {
  const source = normalizeTypedInput(normalizedSource);
  const lines = source.split('\n');
  const nonEmpty: { text: string; index: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const text = (lines[index] ?? '').trim();
    if (text.length > 0) nonEmpty.push({ text, index });
  }

  let modelText = '';
  const breaks: PlainTextBreak[] = [];
  for (let index = 0; index < nonEmpty.length; index += 1) {
    const line = nonEmpty[index];
    if (line === undefined) continue;
    if (index > 0) {
      const previous = nonEmpty[index - 1];
      if (previous === undefined) continue;
      const blankLines = line.index - previous.index - 1;
      breaks.push({
        modelOffset: modelText.length,
        kind: classifyBreak(previous.text, line.text, blankLines),
        blank: blankLines > 0,
        blankLines,
        before: previous.text,
        after: line.text,
      });
      modelText += blankLines > 0 ? '\n\n' : ' ';
    }
    modelText += line.text;
  }

  return {
    modelText,
    breakMap: { source, modelText, breaks },
  };
}

interface TextUnit {
  start: number;
  end: number;
}

function trimUnit(text: string, start: number, end: number): TextUnit | null {
  let first = start;
  let last = end;
  while (first < last && /\s/u.test(text[first] ?? '')) first += 1;
  while (last > first && /\s/u.test(text[last - 1] ?? '')) last -= 1;
  return last > first ? { start: first, end: last } : null;
}

/**
 * Splits text into sentence ranges, then cuts any range at explicit hard boundaries
 * (a blank line or a heading/list break). Mid-sentence cuts are deliberately absent:
 * those breaks must not create a new translation unit.
 */
function textUnits(text: string, hardCuts: readonly number[]): TextUnit[] {
  const spans = sentenceSpans(text);
  const points = new Set<number>();
  for (const span of spans) {
    points.add(span.start);
    points.add(span.end);
  }
  for (const cut of hardCuts) {
    if (cut > 0 && cut < text.length) points.add(cut);
  }
  for (const match of text.matchAll(/\n+/gu)) {
    if (match.index === undefined) continue;
    if (match.index > 0) points.add(match.index);
    const end = match.index + match[0].length;
    if (end < text.length) points.add(end);
  }

  const sorted = [...points].sort((left, right) => left - right);
  const units: TextUnit[] = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const start = sorted[index];
    const end = sorted[index + 1];
    if (start === undefined || end === undefined) continue;
    const unit = trimUnit(text, start, end);
    if (unit) units.push(unit);
  }
  return units;
}

function boundaryAfterUnit(unitIndex: number, sourceUnits: number, targetUnits: number): number {
  if (sourceUnits === 0 || targetUnits === 0) return 0;
  if (unitIndex >= sourceUnits - 1) return targetUnits;
  return Math.min(
    targetUnits,
    Math.max(1, Math.round(((unitIndex + 1) * targetUnits) / sourceUnits)),
  );
}

function unitAtOffset(units: readonly TextUnit[], offset: number): number {
  if (units.length === 0) return -1;
  const first = units[0];
  if (!first || offset <= first.start) return 0;

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (!unit) continue;
    if (offset <= unit.end) {
      // A break can sit in the whitespace between two units (for example after a
      // trailing space that survived in a caller-supplied break map). It belongs to
      // the line that just ended, not to the next one and certainly not the last one.
      if (offset < unit.start) return index > 0 ? index - 1 : index;
      return index;
    }
  }
  return units.length - 1;
}

function safeOffset(text: string, offset: number): number {
  if (offset <= 0 || offset >= text.length) return offset;
  const code = text.charCodeAt(offset);
  // A low surrogate at the insertion point means the previous code unit started a pair.
  if (code >= 0xdc00 && code <= 0xdfff) return offset + 1;
  return offset;
}

interface Insertion {
  offset: number;
}

function mappedInsertions(
  modelText: string,
  translation: string,
  breakMap: PlainTextBreakMap,
): Insertion[] {
  if (translation.length === 0 || breakMap.breaks.length === 0) return [];

  const hardCuts = breakMap.breaks
    .filter((entry) => entry.kind === 'boundary')
    .map((entry) => entry.modelOffset);
  const sourceUnits = textUnits(modelText, hardCuts);
  const targetUnits = textUnits(translation, []);
  if (sourceUnits.length === 0 || targetUnits.length === 0) return [];

  const byOffset = new Map<number, Insertion>();
  for (const entry of breakMap.breaks) {
    const unitIndex = unitAtOffset(sourceUnits, entry.modelOffset);
    if (unitIndex < 0) continue;
    const boundary = boundaryAfterUnit(unitIndex, sourceUnits.length, targetUnits.length);
    if (boundary <= 0) continue;
    const targetUnit = targetUnits[boundary - 1];
    if (!targetUnit) continue;
    const offset = safeOffset(translation, targetUnit.end);
    // A break with only whitespace after it has nothing to separate; do not add a
    // trailing newline that the old (`none`) output never had.
    if (offset <= 0 || offset > translation.length) continue;
    if (translation.slice(offset).trim().length === 0) continue;
    byOffset.set(offset, { offset });
  }

  return [...byOffset.values()].sort((left, right) => left.offset - right.offset);
}

/** The separator replaces the space or paragraph newline the model already emitted. */
function skipSeparatorWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/u.test(text[index] ?? '')) index += 1;
  return index;
}

/**
 * Applies the setting to a finished translation. `none` returns the exact input string;
 * `keep` and `wider` insert one real newline at each mapped source break, and `blank`
 * inserts two (`\n\n`) so the copied data itself contains the empty line.
 *
 * `wider` is no longer a translation-side spacing choice: the reader who asked for it
 * wants help spotting breaks in the *source*, which the typed page does with marks on
 * its input box. Its translation output therefore matches `keep`, and every surface that
 * renders, selects, or copies the result carries the same real newline characters.
 */
export function applyPlainTextLineBreaks(
  modelText: string,
  translation: string,
  breakMap: PlainTextBreakMap,
  mode: PlainTextLineBreakMode,
): string {
  if (mode === 'none') return translation;

  const insertions = mappedInsertions(modelText, translation, breakMap);
  if (insertions.length === 0) return translation;
  const separator = mode === 'blank' ? '\n\n' : '\n';
  let text = '';
  let cursor = 0;
  for (const insertion of insertions) {
    if (insertion.offset <= cursor) continue;
    text += translation.slice(cursor, insertion.offset);
    text += separator;
    cursor = skipSeparatorWhitespace(translation, insertion.offset);
  }
  text += translation.slice(cursor);
  return text;
}
