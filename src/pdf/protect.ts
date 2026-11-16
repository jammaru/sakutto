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
export type ScriptRole = 'super' | 'sub' | 'none';

export interface ProtectedSlot {
  text: string;
  script: ScriptRole;
}

export interface ProtectedText {
  text: string;
  slots: ProtectedSlot[];
}

const PLACEHOLDER = (index: number): string => `<i${String(index)}>`;
const PLACEHOLDER_PATTERN = /<i(\d+)>/g;

/** Operators and fences that belong to a formula rather than to a sentence. */
const OPERATOR = /^[=∈≈≤≥≠+−\-+×÷⊙∑∏∫√±∞∂∇⋅∘*|∥∧∨¬∀∃→↔⊂⊆⊃⊇∈∉()[\]{}.,:^_/\\]+$/u;

const SUPERSCRIPT: Readonly<Record<string, string>> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '−': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  i: 'ⁱ',
};

const SUBSCRIPT: Readonly<Record<string, string>> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '−': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  o: 'ₒ',
  x: 'ₓ',
};

/** True when every character of `text` can be drawn as Unicode super- or subscript. */
export function canUnicodeScript(text: string, script: Exclude<ScriptRole, 'none'>): boolean {
  const map = script === 'super' ? SUPERSCRIPT : SUBSCRIPT;
  for (const character of text) {
    if (map[character] === undefined) return false;
  }
  return text.length > 0;
}

/** Formats a protected script slot for the painted cover (Unicode when possible). */
export function formatScriptSlot(slot: ProtectedSlot): string {
  if (slot.script === 'none') return slot.text;
  const map = slot.script === 'super' ? SUPERSCRIPT : SUBSCRIPT;
  let output = '';
  for (const character of slot.text) {
    const mapped = map[character];
    if (mapped === undefined) return slot.text;
    output += mapped;
  }
  return output;
}

function normalizeSlots(slots: readonly string[] | readonly ProtectedSlot[]): ProtectedSlot[] {
  if (slots.length === 0) return [];
  const first = slots[0];
  if (typeof first === 'string') {
    return (slots as readonly string[]).map((text) => ({ text, script: 'none' as const }));
  }
  return slots as ProtectedSlot[];
}

export function protectInlineMath(block: LayoutBlock): ProtectedText {
  const slots: ProtectedSlot[] = [];
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

function protectLine(line: TextLine, slots: ProtectedSlot[]): string {
  const baseline = dominantBaseline(line.pieces);
  const runs = mathRuns(line.pieces, line.height, baseline);
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
    const slotText = joinPieces(run.pieces);
    slots.push({
      text: slotText,
      script: scriptRole(run.pieces, line.height, baseline),
    });
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
function mathRuns(pieces: readonly TextPiece[], lineHeight: number, baseline: number): PieceRun[] {
  const runs: PieceRun[] = [];
  let current: TextPiece[] = [];
  let currentMath = false;

  const flush = (): void => {
    if (current.length === 0) return;
    runs.push({
      pieces: current,
      protect: currentMath && isFormulaRun(current, lineHeight, baseline),
    });
    current = [];
    currentMath = false;
  };

  for (const piece of pieces) {
    const kind = kindOf(piece, lineHeight, baseline);
    if (kind === 'text') {
      flush();
      current = [piece];
      flush();
      continue;
    }
    current.push(piece);
    if (kind === 'math' || kind === 'op' || kind === 'var' || kind === 'script') {
      currentMath = true;
    }
  }
  flush();
  return runs;
}

/** Baseline most of the line's characters share, ignoring a raised or lowered script run. */
function dominantBaseline(pieces: readonly TextPiece[]): number {
  const weights = new Map<number, number>();
  for (const piece of pieces) {
    if (piece.text.trim().length === 0) continue;
    const key = Math.round(piece.baseline * 2) / 2;
    weights.set(key, (weights.get(key) ?? 0) + piece.text.length);
  }
  let best = pieces[0]?.baseline ?? 0;
  let bestWeight = -1;
  for (const [value, weight] of weights) {
    if (weight > bestWeight) {
      best = value;
      bestWeight = weight;
    }
  }
  return best;
}

const ORDINAL_SUFFIX = /^(?:st|nd|rd|th)$/iu;

/** Raised or lowered enough relative to the line's dominant baseline to be a script glyph. */
function scriptShiftThreshold(piece: TextPiece, lineHeight: number): number {
  const scale = Math.max(lineHeight, piece.size, 1);
  return scale * 0.06;
}

function isShiftedScript(piece: TextPiece, lineHeight: number, baseline: number): boolean {
  const text = piece.text.trim();
  if (text.length === 0 || text.length > 3) return false;
  if (!/^[\p{L}\p{N}]+$/u.test(text)) return false;
  return Math.abs(piece.baseline - baseline) > scriptShiftThreshold(piece, lineHeight);
}

function kindOf(
  piece: TextPiece,
  lineHeight: number,
  baseline: number,
): 'math' | 'op' | 'var' | 'script' | 'text' {
  const text = piece.text.trim();
  if (text.length === 0) return 'text';
  if (piece.math) return 'math';
  if (OPERATOR.test(text)) return 'op';
  // `150th` draws its suffix smaller, but it is punctuation on a number, not a subscript.
  // Protecting it split the word into two fake-engine markers and made the caption overflow.
  if (ORDINAL_SUFFIX.test(text)) return 'text';
  if (piece.italic && text.length <= 2 && /^\p{L}+$/u.test(text)) return 'var';
  // Small body type on the same baseline is not a subscript — only a real baseline shift is.
  if (isShiftedScript(piece, lineHeight, baseline)) return 'script';
  return 'text';
}

/**
 * Whether a protected run is a raised or lowered script, for overlay rendering.
 *
 * Formula variables mixed with operators keep `none`. Script direction follows baseline shift
 * only, never a preceding-character guess.
 */
function scriptRole(
  pieces: readonly TextPiece[],
  lineHeight: number,
  baseline: number,
): ScriptRole {
  const scriptPieces = pieces.filter((piece) => kindOf(piece, lineHeight, baseline) === 'script');
  if (scriptPieces.length === 0) return 'none';

  const hasMath = pieces.some((piece) => kindOf(piece, lineHeight, baseline) === 'math');
  const hasVar = pieces.some((piece) => kindOf(piece, lineHeight, baseline) === 'var');
  if (hasMath || hasVar) return 'none';
  if (pieces.length > 3) return 'none';

  let supers = 0;
  let subs = 0;
  for (const piece of scriptPieces) {
    const shift = piece.baseline - baseline;
    const limit = scriptShiftThreshold(piece, lineHeight);
    if (shift < -limit) supers += 1;
    else if (shift > limit) subs += 1;
  }
  if (supers > 0 && subs === 0) return 'super';
  if (subs > 0 && supers === 0) return 'sub';
  return 'none';
}

function isFormulaRun(pieces: readonly TextPiece[], lineHeight: number, baseline: number): boolean {
  const joined = pieces.map((piece) => piece.text).join('');
  if (joined.trim().length === 0) return false;
  // A hyphen inside `F-score` or the period after `Table 3` is word punctuation, not a
  // formula. Protecting it made the model treat one word as two fragments and the restored
  // translation overflow its box.
  if (/^[\u002d\u2010\u2011\u2012\u2013\u2014\u2212]+$/u.test(joined.trim())) return false;
  if (/^[.,;:!?]+$/u.test(joined.trim())) return false;

  const kinds = pieces.map((piece) => kindOf(piece, lineHeight, baseline));
  if (kinds.some((kind) => kind === 'math' || kind === 'op' || kind === 'var')) return true;
  if (!kinds.some((kind) => kind === 'script')) return false;
  // A shifted script digit beside prose is protected; smaller body type on the same baseline is not.
  return pieces.some((piece) => isShiftedScript(piece, lineHeight, baseline));
}

/**
 * Puts the original formula fragments back. Each slot must appear exactly once; Japanese
 * may reorder them. Dropping, duplicating, or inventing a tag is a wrong translation.
 *
 * Script slots are emitted as Unicode super/sub digits in the overlay text so `10³` does not
 * read as a flat `103`.
 */
export function restoreInlineMath(
  translated: string,
  slots: readonly string[] | readonly ProtectedSlot[],
): string | null {
  const normalized = normalizeSlots(slots);
  if (normalized.length === 0) return translated;
  const seen = new Set<number>();
  let count = 0;
  const restored = translated.replace(PLACEHOLDER_PATTERN, (_match, raw: string) => {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= normalized.length) return '\u0000';
    count += 1;
    seen.add(index);
    const slot = normalized[index];
    if (!slot) return '\u0000';
    return formatScriptSlot(slot);
  });
  if (restored.includes('\u0000')) return null;
  // Each slot exactly once. Japanese may reorder them; dropping, duplicating, or inventing
  // a tag is a wrong translation.
  if (count !== normalized.length || seen.size !== normalized.length) return null;
  if (PLACEHOLDER_PATTERN.test(restored)) return null;
  return restored;
}

/**
 * Markup for a script slot when Unicode cannot represent every character.
 *
 * The reader paints this inside `.sakutto-cover` when plain text is not enough.
 */
export function scriptSlotMarkup(slot: ProtectedSlot): string {
  if (slot.script === 'none') return escapeHtml(slot.text);
  if (canUnicodeScript(slot.text, slot.script)) return formatScriptSlot(slot);
  const tag = slot.script === 'super' ? 'sup' : 'sub';
  return `<${tag}>${escapeHtml(slot.text)}</${tag}>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/**
 * True when a sentence is more formula than prose. Translating it garbles the symbols;
 * leaving the source typesetting is the honest rendering.
 */
export function shouldSkipInlineMath(protectedText: ProtectedText, source: string): boolean {
  if (protectedText.slots.length === 0) return false;
  const slotChars = protectedText.slots
    .map((slot) => slot.text)
    .join('')
    .replace(/\s+/gu, '').length;
  const sourceChars = source.replace(/\s+/gu, '').length;
  const remaining = protectedText.text.replace(/<i\d+>/gu, '').replace(/\s+/gu, '');
  if (sourceChars > 0 && slotChars >= sourceChars * 0.25 && protectedText.slots.length >= 2) {
    return true;
  }
  if (remaining.length < 24 && protectedText.slots.length >= 3) return true;
  return remaining.length < 24 && slotChars >= Math.max(8, remaining.length);
}
