import { boxRight } from './geometry';
import type { LayoutBlock } from './layout';
import { joinPieces, type TextLine, type TextPiece } from './lines';

/**
 * Inline mathematics kept out of the model.
 *
 * A display equation is a block of its own and is never sent. A sentence that names a
 * variable is different: the words have to be translated and the symbols have to come back
 * exactly, because a model that rewrites `q, k ∈ R` into prose is a wrong translation, and a
 * wrong translation is worse than leaving the sentence in English.
 *
 * The page translator already asks the model to keep numbered placeholders `<iN>`. The same
 * tags are reused here so a PDF sentence is not a new prompt shape. A translation that drops
 * or invents a tag is refused, and the original sentence stays on the page.
 */
export interface ProtectedText {
  text: string;
  slots: string[];
}

const PLACEHOLDER = (index: number): string => `<i${String(index)}>`;
const PLACEHOLDER_PATTERN = /<i(\d+)>/g;

/** Operators and fences that belong to a formula rather than to a sentence. */
const OPERATOR = /^[=∈≈≤≥≠+−\-+×÷⊙∑∏∫√±∞∂∇⋅∘*|∥∧∨¬∀∃→↔⊂⊆⊃⊇∈∉()[\]{}.,:^_/\\]+$/u;

export function protectInlineMath(block: LayoutBlock): ProtectedText {
  const slots: string[] = [];
  const parts: string[] = [];

  for (const line of block.lines) {
    const protectedLine = protectLine(line, slots);
    if (protectedLine.length === 0) continue;
    if (parts.length === 0) {
      parts.push(protectedLine);
      continue;
    }
    const previous = parts[parts.length - 1] ?? '';
    const endsHyphen = /[\u002d\u2010\u2011]$/u.test(previous);
    const startsLower = /^[\p{Ll}]/u.test(protectedLine);
    if (endsHyphen && startsLower) {
      parts[parts.length - 1] = `${previous.slice(0, -1)}${protectedLine}`;
      continue;
    }
    parts.push(protectedLine);
  }

  if (slots.length === 0) return { text: block.text, slots: [] };
  return { text: parts.join(' ').replace(/\s+/gu, ' ').trim(), slots };
}

function protectLine(line: TextLine, slots: string[]): string {
  const runs = mathRuns(line.pieces, line.height);
  if (runs.every((run) => !run.protect)) {
    return line.text;
  }

  const replaced: TextPiece[] = [];
  for (const run of runs) {
    if (!run.protect) {
      replaced.push(...run.pieces);
      continue;
    }
    const first = run.pieces[0];
    const last = run.pieces.at(-1);
    if (!first || !last) continue;
    const index = slots.length;
    slots.push(joinPieces(run.pieces));
    replaced.push({
      ...first,
      text: PLACEHOLDER(index),
      box: {
        x: first.box.x,
        y: first.box.y,
        width: Math.max(first.box.width, boxRight(last.box) - first.box.x),
        height: Math.max(first.box.height, last.box.height),
      },
    });
  }
  return joinPieces(replaced);
}

interface PieceRun {
  pieces: TextPiece[];
  protect: boolean;
}

/**
 * Groups a line's pieces into runs that should be kept together.
 *
 * A run is protected when it is a stretch of math faces, operators, and one-or-two-letter
 * italic variables that contains a real formula signal — a math font or an operator — so an
 * italicised English word is not pulled out of a sentence.
 */
function mathRuns(pieces: readonly TextPiece[], lineHeight: number): PieceRun[] {
  const runs: PieceRun[] = [];
  let current: TextPiece[] = [];
  let currentMath = false;

  const flush = (): void => {
    if (current.length === 0) return;
    runs.push({ pieces: current, protect: currentMath && isFormulaRun(current, lineHeight) });
    current = [];
    currentMath = false;
  };

  for (const piece of pieces) {
    const kind = kindOf(piece, lineHeight);
    if (kind === 'text') {
      flush();
      current = [piece];
      flush();
      continue;
    }
    current.push(piece);
    if (kind === 'math' || kind === 'op' || kind === 'var') currentMath = true;
  }
  flush();
  return runs;
}

const ORDINAL_SUFFIX = /^(?:st|nd|rd|th)$/iu;

function kindOf(piece: TextPiece, lineHeight: number): 'math' | 'op' | 'var' | 'text' {
  const text = piece.text.trim();
  if (text.length === 0) return 'text';
  if (piece.math) return 'math';
  if (OPERATOR.test(text)) return 'op';
  // `150th` draws its suffix smaller, but it is punctuation on a number, not a subscript.
  // Protecting it split the word into two fake-engine markers and made the caption overflow.
  if (ORDINAL_SUFFIX.test(text)) return 'text';
  if (piece.italic && text.length <= 2 && /^\p{L}+$/u.test(text)) return 'var';
  // A subscript is set smaller than the line: `S_t` draws `t` at ~70% of the em.
  if (
    lineHeight > 0 &&
    piece.size < lineHeight * 0.78 &&
    text.length <= 3 &&
    /^[\p{L}\p{N}]+$/u.test(text)
  ) {
    return 'var';
  }
  return 'text';
}

function isFormulaRun(pieces: readonly TextPiece[], lineHeight: number): boolean {
  const joined = pieces.map((piece) => piece.text).join('');
  if (joined.trim().length === 0) return false;
  // A hyphen inside `F-score` or the period after `Table 3` is word punctuation, not a
  // formula. Protecting it made the model treat one word as two fragments and the restored
  // translation overflow its box.
  if (/^[\u002d\u2010\u2011\u2012\u2013\u2014\u2212]+$/u.test(joined.trim())) return false;
  if (/^[.,;:!?]+$/u.test(joined.trim())) return false;
  return pieces.some((piece) => {
    const kind = kindOf(piece, lineHeight);
    return kind === 'math' || kind === 'op' || (kind === 'var' && piece.size < lineHeight * 0.78);
  });
}

/**
 * Puts the original formula fragments back. Each slot must appear exactly once; Japanese
 * may reorder them. Dropping, duplicating, or inventing a tag is a wrong translation.
 */
export function restoreInlineMath(translated: string, slots: readonly string[]): string | null {
  if (slots.length === 0) return translated;
  const seen = new Set<number>();
  let count = 0;
  const restored = translated.replace(PLACEHOLDER_PATTERN, (_match, raw: string) => {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= slots.length) return '\u0000';
    count += 1;
    seen.add(index);
    return slots[index] ?? '\u0000';
  });
  if (restored.includes('\u0000')) return null;
  // Each slot exactly once. Japanese may reorder them; dropping, duplicating, or inventing
  // a tag is a wrong translation.
  if (count !== slots.length || seen.size !== slots.length) return null;
  if (PLACEHOLDER_PATTERN.test(restored)) return null;
  return restored;
}

/**
 * True when a sentence is more formula than prose. Translating it garbles the symbols;
 * leaving the source typesetting is the honest rendering.
 */
export function shouldSkipInlineMath(protectedText: ProtectedText, source: string): boolean {
  if (protectedText.slots.length === 0) return false;
  const slotChars = protectedText.slots.join('').replace(/\s+/gu, '').length;
  const sourceChars = source.replace(/\s+/gu, '').length;
  const remaining = protectedText.text.replace(/<i\d+>/gu, '').replace(/\s+/gu, '');
  if (sourceChars > 0 && slotChars >= sourceChars * 0.25 && protectedText.slots.length >= 2) {
    return true;
  }
  if (remaining.length < 24 && protectedText.slots.length >= 3) return true;
  return remaining.length < 24 && slotChars >= Math.max(8, remaining.length);
}
