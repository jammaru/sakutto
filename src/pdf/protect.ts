import { SUBSCRIPT, SUPERSCRIPT } from '@/shared/scripts';
import { boxRight } from './geometry';
import type { LayoutBlock } from './layout';
import { joinPieces, lineFrom, type TextLine, type TextPiece } from './lines';

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
/**
 * A second pass for notation a typesetter set in an ordinary text face.
 *
 * Font detection handles LaTeX's math faces, but papers also write short expressions such as
 * `Q ∈ R d` or `×d k` in italic Times. Left in the prompt they come back rewritten, which is
 * worse than leaving the equation alone. A span is protected only when it contains a strong
 * mathematical operator; neighbouring prose words are never swallowed.
 *
 * Every operand is a whole word (`\p{L}` included in the lookarounds): without the bounds a
 * short variable could start inside `speedup` or steal the `s` from `matrices`, asking the
 * model to translate a misspelled word and leaving only the tail in the prompt.
 */
const TEXT_NOTATION =
  /(?<![\p{L}\p{N}_])(?:[\p{Lu}\p{N}_^][\p{L}\p{N}_^]{0,4}|[a-z][\p{N}_^]{0,3})(?![\p{L}\p{N}_])(?:\s+(?:\p{Lu}[\p{L}\p{N}_^]{0,4}|[a-z][\p{N}_^]{0,3}|[\p{N}_^]{1,4})(?![\p{L}\p{N}_])){0,4}(?:\s*(?:∈|×|÷|≈|≤|≥|≠|∑|∏|∫|∂|∇|\^)\s*(?:[\p{Lu}\p{N}_^][\p{L}\p{N}_^]{0,6}|[a-z][\p{N}_^]{0,3})(?![\p{L}\p{N}_])){1,8}/gu;

/**
 * A whole dimension expression such as `Q ∈ R d model × d k`.
 *
 * The generic operator pattern stops at the operator's right operand, which left `model`
 * and `d k` visible to the model and let them be translated into Japanese. Dimension names
 * are short lowercase technical words, so they can be consumed safely when they follow an
 * operator or a `d` and stay close to another multiplication. Ordinary English words around
 * the formula are deliberately not matched.
 */
const DIMENSION_WORD = String.raw`(?:model|hd|out|in|dim|size|[a-z][\p{N}_^]{0,3})(?![\p{L}\p{N}_])`;
const NOTATION_OPERAND = String.raw`(?:[\p{Lu}\p{N}_^][\p{L}\p{N}_^]{0,6}|[a-z][\p{N}_^]{0,3})(?![\p{L}\p{N}_])`;
const DIMENSION_CHAIN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${NOTATION_OPERAND}(?:\s+${NOTATION_OPERAND}){0,3}` +
    String.raw`\s*(?:∈|×|÷|≈|≤|≥|≠)\s*${NOTATION_OPERAND}` +
    String.raw`(?:\s+${DIMENSION_WORD}){0,3}` +
    // A chained expression can continue with another bare operand ("3 × 3 × 3", "A × B × C"),
    // not only with a named dimension. Without this branch the first pass protects only the
    // prefix and the inserted placeholder stops a second pass from reaching the tail.
    String.raw`(?:\s*(?:×|÷)\s*(?:${DIMENSION_WORD}|${NOTATION_OPERAND})(?:\s+${DIMENSION_WORD})?){0,6}`,
  'gu',
);

/**
 * Leading tokens that are unmistakably notation rather than ordinary prose.
 *
 * The notation patterns accept a leading word (`A ∈ R`) or an article before a size
 * (`a 3 × 3`) to cover symbols set in an ordinary text face. Instead of listing every prose word
 * that can occupy that position (a list that broke on `Small`, `Large`, `Deep`, `More`, `Fewer`,
 * `Double`, ...), decide from the token's shape: a single letter (including Greek), a number, a
 * letter carrying a digit/subscript/superscript, or a flattened subscripted identifier whose
 * chain continues with an operator (`Wi ∈ R ...`) is a variable; everything else is prose and
 * belongs in the prompt. `a`/`A` immediately before a number is an article, not a variable,
 * and a two-letter English word (`If`, `As`, `At`, `In`, ...) is a sentence opener even when a
 * variable follows it (`If Q ∈ R ...`).
 */
const LEAD_TOKEN = /^([^\s]+)(\s+)/u;
const NOTATION_HEAD = /^(?:\p{L}[\p{N}_^]{0,3}|[\p{N}_^]+)$/u;
/**
 * PDF extraction flattens a subscripted matrix name (`W_i`, `W_q`, `W_k`, `W_v`) into `Wi`,
 * `Wq`, `Wk`, `Wv`. Such an identifier is a capital plus exactly one lowercase letter, with
 * optional subscript marks; a prose adjective (`Small`, `Large`, `Deep`, ...) has a longer
 * lowercase tail and never matches. Shape alone is not enough for two-letter words such as
 * `In`, so the identifier only counts as notation when an operator follows its chain:
 * `Wi ∈ R ...`, `Wk × d k`, or `We ∈ R ...` with the operator directly after it. An operand
 * between the token and the operator makes it a prose opener, whatever the token's spelling.
 */
const FLATTENED_IDENTIFIER = /^\p{Lu}\p{Ll}[\p{N}_^]{0,3}$/u;
/** Flattened subscripted matrix names: W_i, W_q, W_k, W_v and W_o are notation by shape. */
const FLATTENED_MATRIX_NAME = /^W[iqkvo][\p{N}_^]{0,3}$/u;
/** Flattened W_o is indistinguishable by shape from the German opener "Wo Q ∈ ...". */
const FLATTENED_OUTPUT_MATRIX = /^Wo[\p{N}_^]{0,3}$/u;
/** A clause boundary before the token: the German "Wo" opens a clause, W_o does not. */
const CLAUSE_BOUNDARY = /[.!?;:。、]$/u;
// Only a delimiter immediately before the token opens a clause. A bracket or bullet at the
// head of a block does not: in "(The projection Wo Q ...)" the matrix follows prose.
const CLAUSE_OPENER_TAIL = /["（「『“‘„«([{•\-—]\s*$/u;
function startsClause(preceding: string): boolean {
  const before = preceding.trimEnd();
  if (before.length === 0) return true;
  if (CLAUSE_BOUNDARY.test(before)) return true;
  const openerAtEnd = CLAUSE_OPENER_TAIL.exec(before);
  if (openerAtEnd) {
    const beforeOpener = before.slice(0, openerAtEnd.index).trimEnd();
    return beforeOpener.length === 0 || !/\p{L}$/u.test(beforeOpener);
  }
  return false;
}
const IDENTIFIER_OPERATOR = /^\s*(?:\p{Lu}[\p{N}_^]{0,3}\s+)?[∈×÷]\s+\S/u;
/**
 * Another operand between a two-letter token and the operator: `If Q ∈`, `As W ∈`, `Si Q ∈`.
 * The token is then a sentence opener and belongs in the prompt, whatever language it came from.
 * A flattened identifier has the operator directly after it (`We ∈`, `In ∈`) and keeps the
 * whole expression in one slot.
 */
const OPENER_BEFORE_OPERAND = /^\p{Lu}[\p{N}_^]{0,3}\s+[∈×÷]\s+\S/u;
const LEADING_NUMBER = /^[\p{N}]/u;

function isNotationHead(token: string, following = '', preceding = ''): boolean {
  if (NOTATION_HEAD.test(token)) {
    // An article before a size is prose even though `a`/`A` fits the single-letter shape.
    return !(/^[Aa]$/u.test(token) && LEADING_NUMBER.test(following));
  }
  if (!FLATTENED_IDENTIFIER.test(token) || !IDENTIFIER_OPERATOR.test(following)) return false;
  // Position alone decides, for every two-letter token whatever language it came from: another
  // operand before the operator makes it a sentence opener (`If Q ∈`, `Si Q ∈`, `Et Q ∈`, ...),
  // while the operator directly after it makes it the flattened matrix name (`We ∈`, `In ∈`).
  // Flattened W-subscript names (`Wi Q ∈`, `Wq Q ∈`) are notation in either position, so the
  // model never sees a matrix name rewritten as prose. The one ambiguous shape is `Wo`: it is
  // W_o in "The projection Wo Q ∈ ..." but the German opener in "Wo Q ∈ ... gilt". Clause
  // position disambiguates: a clause-initial `Wo` is prose, a preceded one is the matrix.
  if (!OPENER_BEFORE_OPERAND.test(following)) return true;
  if (!FLATTENED_MATRIX_NAME.test(token)) return false;
  return !(FLATTENED_OUTPUT_MATRIX.test(token) && startsClause(preceding));
}

/**
 * Peels every leading prose token off a notation match.
 *
 * The guard below only protects a chain whose first remaining operand is clearly a variable, so
 * the peeled words are always text the model must translate. No growing vocabulary list is
 * involved: an adjective the report has not seen yet is stripped exactly like a determiner or a
 * sentence opener, and a chain that starts with an English word is left alone. Two-letter words
 * are ambiguous with flattened identifiers by shape alone, so their position in the chain (an
 * operand before the operator, not the operator itself) decides whether they are peeled.
 */
function splitProseLead(value: string, preceding = ''): { lead: string; value: string } {
  let lead = '';
  let rest = value;
  for (;;) {
    const match = LEAD_TOKEN.exec(rest);
    if (!match?.[1] || !match[2]) break;
    const token = match[1];
    const following = rest.slice(match[0].length);
    if (isNotationHead(token, following, preceding + lead)) break;
    lead += match[0];
    rest = following;
  }
  return { lead, value: rest };
}
/**
 * Prose words that look like dimension names to DIMENSION_CHAIN.
 *
 * "Q ∈ R in this paper" is notation followed by a preposition, not part of the formula.
 * A real dimension chain continues with a multiplication ("Q ∈ R d model × d k"), which is
 * the only case where these short words belong inside the protected slot.
 */
const TRAILING_PROSE_DIMENSION = /(?:\s+(?:model|hd|out|in|dim|size))+$/iu;

/** An ordinary lowercase word after the match: a preposition, not more notation. */
const PROSE_CONTINUATION = /^\s+\p{Ll}{2,}/u;
/** End of a sentence, clause or block: the trailing prose word is not part of the notation. */
const EXPRESSION_END = /^\s*(?:$|[.,;:!?)\]]|。|、)/u;

/**
 * Trims a trailing prose word that the dimension pattern mistook for a dimension name.
 *
 * `Q ∈ R in` is notation plus a preposition and so is `3 × 3 in`. With a multiplication sign
 * the word is kept only when the expression continues as notation (`d model × d k`): the
 * following text then starts with another operator or a slot, never with a lowercase English
 * word such as `this` or `the`.
 */
function trimProseDimensionSuffix(match: string, following: string): string {
  const prose = TRAILING_PROSE_DIMENSION.exec(match);
  if (!prose) return match;
  if (
    /[×÷]/u.test(match) &&
    !PROSE_CONTINUATION.test(following) &&
    !EXPRESSION_END.test(following)
  ) {
    return match;
  }
  return match.slice(0, prose.index);
}

function protectSpan(
  match: string,
  slots: ProtectedSlot[],
  following: string,
  preceding = '',
): string {
  const raw = match.trim();
  const trimmed = trimProseDimensionSuffix(raw, following);
  // The trimmed preposition stays in the prompt outside the placeholder.
  const tail = raw.slice(trimmed.length);
  const { lead, value } = splitProseLead(trimmed, preceding);
  const first = value.split(/\s+/u)[0] ?? '';
  // Only a chain that starts with a variable or a number is notation. An English adjective or
  // noun (`Small × Large`, `Model × Time`) is prose even when it fits the loose operand shape.
  // A flattened identifier needs the same operator evidence the lead peeler used, so pass the
  // rest of the chain instead of an empty following string here.
  if (value.length < 4 || !isNotationHead(first, value.slice(first.length), preceding)) return raw;
  const index = slots.length;
  slots.push({ text: value, script: 'none' });
  return lead + PLACEHOLDER(index) + tail;
}

function protectTextNotation(text: string, slots: ProtectedSlot[]): string {
  return text
    .replace(DIMENSION_CHAIN, (match, offset: number, whole: string) =>
      protectSpan(match, slots, whole.slice(offset + match.length), whole.slice(0, offset)),
    )
    .replace(TEXT_NOTATION, (match, offset: number, whole: string) =>
      protectSpan(match, slots, whole.slice(offset + match.length), whole.slice(0, offset)),
    );
}

export type ScriptRole = 'super' | 'sub' | 'none';

export interface ProtectedSlot {
  text: string;
  script: ScriptRole;
  /** Start of the script run inside `text` when the whole chemical token is one slot. */
  scriptIndex?: number;
  scriptLength?: number;
}

export interface ProtectedText {
  text: string;
  slots: ProtectedSlot[];
}

const PLACEHOLDER = (index: number): string => `<i${String(index)}>`;
const PLACEHOLDER_PATTERN = /<i(\d+)>/g;

/** Operators and fences that belong to a formula rather than to a sentence. */
const OPERATOR = /^[=∈≈≤≥≠+−\-+×÷⊙∑∏∫√±∞∂∇⋅∘*|∥∧∨¬∀∃→↔⊂⊆⊃⊇∈∉()[\]{}.,:^_/\\]+$/u;

/** True when every character of `text` can be drawn as Unicode super- or subscript. */
export function canUnicodeScript(text: string, script: Exclude<ScriptRole, 'none'>): boolean {
  const map = script === 'super' ? SUPERSCRIPT : SUBSCRIPT;
  for (const character of text) {
    if (map[character] === undefined) return false;
  }
  return text.length > 0;
}

/** The raised or lowered characters inside a glyph run, without adjoining punctuation. */
function scriptCoreText(text: string): string {
  const match = text.trim().match(/^[^\p{L}\p{N}]*([\p{L}\p{N}]{1,3})[^\p{L}\p{N}]*$/u);
  return match?.[1] ?? '';
}

function splitScriptSlot(text: string): { core: string; prefix: string; suffix: string } {
  const core = scriptCoreText(text);
  if (core.length === 0) return { core: text, prefix: '', suffix: '' };
  const start = text.indexOf(core);
  if (start < 0) return { core: text, prefix: '', suffix: '' };
  const end = start + core.length;
  return { core, prefix: text.slice(0, start), suffix: text.slice(end) };
}

/** Formats a protected script slot for the painted cover (Unicode when possible). */
export function formatScriptSlot(slot: ProtectedSlot): string {
  if (slot.script === 'none') return slot.text;
  const map = slot.script === 'super' ? SUPERSCRIPT : SUBSCRIPT;
  if (slot.scriptIndex !== undefined) {
    const index = slot.scriptIndex;
    const end = index + (slot.scriptLength ?? 1);
    const script = slot.text.slice(index, end);
    if (script.length === 0) return slot.text;
    let mappedScript = '';
    for (const character of script) {
      const mapped = map[character];
      if (mapped === undefined) return slot.text;
      mappedScript += mapped;
    }
    return `${slot.text.slice(0, index)}${mappedScript}${slot.text.slice(end)}`;
  }
  let output = '';
  for (const character of slot.text) {
    const mapped = map[character];
    output += mapped ?? character;
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

  for (const line of coalesceScriptFragments(block.lines)) {
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

  const joined = parts.join(' ').replace(/\s+/gu, ' ').trim();
  const protectedText = protectTextNotation(joined, slots);
  if (slots.length === 0) return { text: block.text, slots: [] };
  return { text: protectedText, slots };
}

function protectLine(line: TextLine, slots: ProtectedSlot[]): string {
  const ordered = lineFrom([...line.pieces].sort((left, right) => left.box.x - right.box.x));
  const baseline = dominantBaseline(ordered.pieces);
  const pieces = expandChemicalFormulas(ordered.pieces, ordered.height, baseline, slots);
  const replaced: TextPiece[] = [];
  let buffer: TextPiece[] = [];

  const flushBuffer = (): void => {
    if (buffer.length === 0) return;
    replaced.push(...protectMathRuns(buffer, ordered.height, baseline, slots));
    buffer = [];
  };

  for (const piece of pieces) {
    const tagged = piece as TagPiece;
    if (tagged.kind === 'chem') {
      flushBuffer();
      replaced.push({ ...piece, text: PLACEHOLDER(tagged.slotIndex ?? 0) });
      continue;
    }
    buffer.push(piece);
  }
  flushBuffer();
  return joinPieces(replaced);
}

function protectMathRuns(
  pieces: readonly TextPiece[],
  lineHeight: number,
  baseline: number,
  slots: ProtectedSlot[],
): TextPiece[] {
  const runs = mathRuns(pieces, lineHeight, baseline);
  const replaced: TextPiece[] = [];
  for (const run of runs) {
    if (!run.protect) {
      replaced.push(...run.pieces);
      continue;
    }
    const first = run.pieces[0];
    const last = run.pieces.at(-1);
    if (!first || !last) continue;
    const joined = joinPieces(run.pieces);
    const role = scriptRole(run.pieces, lineHeight, baseline);
    const split =
      role !== 'none' ? splitScriptSlot(joined) : { core: joined, prefix: '', suffix: '' };
    const { core, prefix, suffix } = split;
    const slotText = role !== 'none' && core.length > 0 ? core : joined;
    const index = slots.length;
    slots.push({
      text: slotText,
      script: role,
    });
    const splitPieces = role !== 'none' && (prefix.length > 0 || suffix.length > 0);
    if (splitPieces) {
      if (prefix.length > 0) replaced.push({ ...first, text: prefix });
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
      if (suffix.length > 0) replaced.push({ ...last, text: suffix });
      continue;
    }
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
  return replaced;
}

type TagPiece = TextPiece & { kind?: 'chem'; slotIndex?: number };

function trailingChemLetter(text: string): { letter: string; rest: string } | null {
  const match = /^(.*)(\p{Lu})$/u.exec(text);
  if (!match || !match[1] || !match[2]) return null;
  return { letter: match[2], rest: match[1] };
}

function leadingChemLetter(text: string): { letter: string; rest: string } | null {
  const match = /^(\p{Lu})(.*)$/u.exec(text);
  if (!match?.[1]) return null;
  return { letter: match[1], rest: match[2] ?? '' };
}

/** Folds `H` + subscript `2` + `O` into one atomic placeholder so the model cannot split it. */
function expandChemicalFormulas(
  pieces: readonly TextPiece[],
  lineHeight: number,
  baseline: number,
  slots: ProtectedSlot[],
): TagPiece[] {
  const out: TagPiece[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const lead = pieces[index];
    const script = pieces[index + 1];
    const tail = pieces[index + 2];
    if (!lead || !script || !tail) {
      if (lead) out.push(lead);
      continue;
    }
    const directSymbol = lead.text.trim();
    const directFollower = tail.text.trim();
    const direct =
      directSymbol.length === 1 &&
      directFollower.length === 1 &&
      /^\p{Lu}$/u.test(directSymbol) &&
      /^\p{Lu}$/u.test(directFollower);

    const peeledLead = direct ? null : trailingChemLetter(lead.text);
    const peeledTail = direct ? null : leadingChemLetter(tail.text);
    const symbol = direct ? directSymbol : peeledLead && peeledTail ? peeledLead.letter : '';
    const follower = direct ? directFollower : peeledLead && peeledTail ? peeledTail.letter : '';
    if (
      symbol.length === 1 &&
      follower.length === 1 &&
      /^\p{Lu}$/u.test(symbol) &&
      /^\p{Lu}$/u.test(follower) &&
      isShiftedScript(script, lineHeight, baseline) &&
      !lead.math &&
      !script.math &&
      !tail.math
    ) {
      const digit = scriptCoreText(script.text) || script.text.trim();
      const slotIndex = slots.length;
      slots.push({
        text: `${symbol}${digit}${follower}`,
        script: scriptRole([script], lineHeight, baseline),
        scriptIndex: symbol.length,
        scriptLength: digit.length,
      });
      if (!direct && peeledLead && peeledLead.rest.trim().length > 0) {
        out.push({ ...lead, text: peeledLead.rest });
      } else if (direct) {
        // single-letter runs are fully replaced by the chemical placeholder
      }
      out.push({
        ...script,
        kind: 'chem',
        slotIndex,
        text: `${symbol}${digit}${follower}`,
        box: {
          x: direct ? lead.box.x : Math.min(lead.box.x, script.box.x),
          y: Math.min(lead.box.y, script.box.y, tail.box.y),
          width:
            Math.max(boxRight(tail.box), boxRight(script.box), boxRight(lead.box)) -
            (direct ? lead.box.x : Math.min(lead.box.x, script.box.x)),
          height: Math.max(lead.box.height, script.box.height, tail.box.height),
        },
      });
      if (!direct && peeledTail && peeledTail.rest.length > 0) {
        out.push({ ...tail, text: peeledTail.rest });
      }
      index += 2;
      continue;
    }
    out.push(lead);
  }
  return out;
}

/**
 * A shifted script glyph sometimes lands on its own TextLine when the PDF extractor splits
 * baselines. Folding it into the prose line it belongs to keeps `<iN>` markers in reading
 * order instead of at the end of the block.
 */
function coalesceScriptFragments(lines: readonly TextLine[]): TextLine[] {
  if (lines.length <= 1) return [...lines];
  const working = lines.map((line) => ({ line, merged: false }));
  for (let index = 0; index < working.length; index += 1) {
    const entry = working[index];
    if (!entry || entry.merged || !isOrphanScriptLine(entry.line)) continue;
    const target = findScriptAttachTarget(working, index);
    if (target === null) continue;
    const row = working[target];
    if (!row || row.merged) continue;
    row.line = mergeTextLines(row.line, entry.line);
    entry.merged = true;
    const following = working[index + 1];
    if (
      following &&
      following !== row &&
      !following.merged &&
      leadingChemLetter(following.line.text.trim()) !== null &&
      trailingChemLetter(row.line.text) === null
    ) {
      row.line = mergeTextLines(row.line, following.line);
      following.merged = true;
    }
  }
  return working.filter((row) => !row.merged).map((row) => row.line);
}

function isOrphanScriptLine(line: TextLine): boolean {
  const trimmed = line.text.trim();
  const core = scriptCoreText(trimmed);
  if (core.length === 0 || core.length > 3) return false;
  if (line.pieces.length > 2) return false;
  // A one-glyph row has only its own baseline, so shift is judged against the prose it joins.
  return true;
}

function findScriptAttachTarget(
  working: ReadonlyArray<{ line: TextLine; merged: boolean }>,
  scriptIndex: number,
): number | null {
  const fragment = working[scriptIndex]?.line;
  if (!fragment) return null;
  let best: number | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let index = 0; index < working.length; index += 1) {
    if (index === scriptIndex) continue;
    const row = working[index];
    if (!row || row.merged) continue;
    if (!shouldMergeScriptFragment(row.line, fragment)) continue;
    const gap = Math.abs(fragment.box.x - boxRight(row.line.box));
    if (gap < bestGap) {
      bestGap = gap;
      best = index;
    }
  }
  return best;
}

function shouldMergeScriptFragment(previous: TextLine, fragment: TextLine): boolean {
  if (!isOrphanScriptLine(fragment)) return false;
  const baseline = dominantBaseline(previous.pieces);
  if (!fragment.pieces.every((piece) => isShiftedScript(piece, previous.height, baseline))) {
    return false;
  }
  const scale = Math.max(previous.height, fragment.height, 1);
  const prevRight = boxRight(previous.box);
  const fragLeft = fragment.box.x;
  if (fragLeft < previous.box.x - scale) return false;
  if (fragLeft > prevRight + scale * 2) return false;
  const baselineGap = Math.abs(fragment.baseline - previous.baseline);
  if (baselineGap > scale * 0.85) return false;
  return true;
}

function mergeTextLines(left: TextLine, right: TextLine): TextLine {
  const pieces = [...left.pieces, ...right.pieces].sort((a, b) => a.box.x - b.box.x);
  return lineFrom(pieces);
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
  const trimmed = piece.text.trim();
  // scriptCoreText takes the first few characters of a run. A whole sentence starting with
  // "Exp" is not a superscript just because its baseline differs from another merged line.
  if (trimmed.length === 0 || trimmed.length > 4) return false;
  const core = scriptCoreText(trimmed);
  if (core.length === 0 || core.length > 3) return false;
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
  const core = scriptCoreText(text);
  if (core.length > 0 && core.length <= 3 && isShiftedScript(piece, lineHeight, baseline)) {
    return 'script';
  }
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
  if (/^[.,;:!?()[\]]+$/u.test(joined.trim())) return false;

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
  // Normalize only the placeholder spelling. NFKC on the whole translation would silently
  // rewrite the reader's typography: （注意） becomes (注意), ① becomes 1 and ㍻ becomes 平成.
  const canonical = translated.replace(/[＜<]\s*[iＩｉ]\s*([\p{Nd}]+)\s*[＞>]/gu, (tag) =>
    tag.normalize('NFKC').replace(/\s+/gu, ''),
  );
  const restored = canonical.replace(PLACEHOLDER_PATTERN, (_match, raw: string) => {
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
  if (sourceChars > 0 && slotChars >= sourceChars * 0.6 && protectedText.slots.length >= 3) {
    return true;
  }
  if (remaining.length < 24 && protectedText.slots.length >= 3) return true;
  return remaining.length < 24 && slotChars >= Math.max(8, remaining.length);
}
