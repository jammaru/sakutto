/**
 * Prepares source for translation. Model output is cleaned separately by
 * `sanitizeModelOutput`: runaway invisibles, C0/C1, PUA, long joiner/tag/bidi
 * runs, and Latin/CJK bidi overrides are removed. Chillu ZWJ, emoji ZWJ/tag
 * sequences, joining-script ZWNJ, and bidi next to RTL letters stay.
 *
 * The model, especially PLaMo 3 Translate on llama.cpp, can copy invisible format
 * characters until max_tokens (`finish_reason: length`). That is issue #73: a Latin
 * sentence with WORD JOINER / ZWNJ / ZWJ never produces a real translation.
 *
 * The rule is not a blind Cf strip. Some of those code points carry meaning:
 *
 * - Always drop: U+00AD soft hyphen, U+200B ZWSP, U+2060 word joiner, U+FEFF BOM,
 *   U+180E Mongolian vowel separator, U+2061–2064 invisible math, U+206A–206F
 *   deprecated format, C0/C1 except TAB/LF (CRLF becomes newline), lone surrogates,
 *   private-use, annotation chars, and other default-ignorables that are not
 *   listed as kept below.
 * - Keep ZWJ inside emoji ZWJ sequences (family, role, flags-as-ZWJ), including
 *   when a DOM placeholder `<iN>` sits between the parts.
 * - Keep ZWNJ/ZWJ between letters of scripts that use them (Arabic/Persian,
 *   Hebrew, Indic, and other joining scripts), including across a placeholder.
 * - Keep ZWJ/ZWNJ when the immediately preceding code point is a virama or
 *   combining mark in a joining script, even at word end (Malayalam chillu,
 *   Hindi halant+ZWJ).
 * - Keep bidi controls (U+200E/200F, U+202A–202E, U+2066–2069) when the text
 *   contains an RTL script; drop them in Latin/CJK-only text.
 * - Keep variation selectors attached to a symbol, emoji, or Han ideograph
 *   (emoji presentation and CJK IVS); drop a lone VS.
 * - Keep Unicode tag characters (U+E0020–E007F) that continue an emoji tag
 *   sequence such as a subdivision flag; drop tags in Latin/CJK junk.
 * - Map Zs spaces (NBSP, narrow NBSP, ideographic space, …) to U+0020; map
 *   U+2028/U+2029 to newline. Do not NFKC: fullwidth/halfwidth stay.
 * - NFC-compose so decomposed Japanese dakuten and accented Latin match the
 *   precomposed form the model expects. Combining marks that remain are kept.
 *
 * Placeholder tags (`<i1>…</i1>`) are ASCII and pass through, so DOM gap
 * alignment is unchanged. Neighbor scans treat those tokens as transparent.
 * Callers must sanitize only the text sent to the model, never the live Text
 * nodes: restore still uses `slot.original`.
 *
 * Aggressive mode is a retry after an invisible-character runaway: it also
 * drops ZWNJ/ZWJ/bidi that careful mode kept, but still preserves emoji ZWJ
 * sequences, emoji VS, tag flags, and virama+ZWJ chillu forms. For RTL source
 * that retry therefore drops bidi embeddings / isolates / marks the first
 * (careful) attempt had preserved, so the translation may lose intended
 * directionality. Latin source is unchanged between modes, so the retry is
 * skipped and the original is shown as a failure.
 */

export type SanitizeMode = 'careful' | 'aggressive';

const JOINING_LETTER =
  /\p{Script=Arabic}|\p{Script=Syriac}|\p{Script=Thaana}|\p{Script=Nko}|\p{Script=Mongolian}|\p{Script=Phags_Pa}|\p{Script=Manichaean}|\p{Script=Psalter_Pahlavi}|\p{Script=Adlam}|\p{Script=Hanifi_Rohingya}|\p{Script=Hebrew}|\p{Script=Mandaic}|\p{Script=Samaritan}|\p{Script=Yezidi}|\p{Script=Devanagari}|\p{Script=Bengali}|\p{Script=Gurmukhi}|\p{Script=Gujarati}|\p{Script=Oriya}|\p{Script=Tamil}|\p{Script=Telugu}|\p{Script=Kannada}|\p{Script=Malayalam}|\p{Script=Sinhala}|\p{Script=Myanmar}|\p{Script=Khmer}|\p{Script=Tibetan}|\p{Script=Limbu}|\p{Script=Tai_Le}|\p{Script=New_Tai_Lue}|\p{Script=Tai_Tham}|\p{Script=Tai_Viet}|\p{Script=Balinese}|\p{Script=Javanese}|\p{Script=Sundanese}|\p{Script=Cham}|\p{Script=Lepcha}|\p{Script=Buginese}|\p{Script=Tagalog}|\p{Script=Hanunoo}|\p{Script=Buhid}|\p{Script=Tagbanwa}|\p{Script=Rejang}|\p{Script=Batak}|\p{Script=Brahmi}|\p{Script=Kaithi}|\p{Script=Sharada}|\p{Script=Takri}|\p{Script=Khojki}|\p{Script=Khudawadi}|\p{Script=Mahajani}|\p{Script=Modi}|\p{Script=Grantha}|\p{Script=Newa}|\p{Script=Dogra}|\p{Script=Nandinagari}|\p{Script=Gunjala_Gondi}|\p{Script=Masaram_Gondi}|\p{Script=Wancho}|\p{Script=Dives_Akuru}|\p{Script=Nyiakeng_Puachue_Hmong}/u;

const RTL_LETTER =
  /\p{Script=Arabic}|\p{Script=Hebrew}|\p{Script=Syriac}|\p{Script=Thaana}|\p{Script=Nko}|\p{Script=Adlam}|\p{Script=Hanifi_Rohingya}|\p{Script=Mandaic}|\p{Script=Samaritan}|\p{Script=Yezidi}|\p{Script=Psalter_Pahlavi}|\p{Script=Manichaean}/u;

const VISIBLE_CONTENT = /\p{L}|\p{N}|\p{P}|\p{S}|\p{M}/u;

const ALWAYS_DROP = new Set<number>([
  0x00ad, // soft hyphen
  0x034f, // combining grapheme joiner
  0x115f,
  0x1160,
  0x180b,
  0x180c,
  0x180d,
  0x180e,
  0x180f,
  0x200b, // ZWSP
  0x2060, // word joiner
  0x2061,
  0x2062,
  0x2063,
  0x2064,
  0x2065,
  0x206a,
  0x206b,
  0x206c,
  0x206d,
  0x206e,
  0x206f,
  0x3164,
  0xfeff, // BOM / ZWNBSP
  0xffa0,
  0xfff9,
  0xfffa,
  0xfffb,
]);

const BIDI = new Set<number>([
  0x061c, // Arabic letter mark
  0x200e, // LRM
  0x200f, // RLM
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
]);

export const ZWJ = 0x200d;
export const ZWNJ = 0x200c;
const KHMER_INHERENT_AQ = 0x17b4;
const KHMER_INHERENT_AA = 0x17b5;
const MAX_INVISIBLE_RUN = 4;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Drops unpaired UTF-16 surrogates so NFC cannot throw and the model never sees them. */
export function stripLoneSurrogates(text: string): string {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isHighSurrogate(code)) {
      const next = text.charCodeAt(index + 1);
      if (isLowSurrogate(next)) {
        output += text.slice(index, index + 2);
        index += 1;
        continue;
      }
      continue;
    }
    if (isLowSurrogate(code)) continue;
    output += text[index];
  }
  return output;
}

function toPoints(text: string): number[] {
  const points: number[] = [];
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point !== undefined) points.push(point);
  }
  return points;
}

function character(point: number): string {
  return String.fromCodePoint(point);
}

function isDefaultIgnorable(point: number): boolean {
  return ALWAYS_DROP.has(point) || /\p{Default_Ignorable_Code_Point}/u.test(character(point));
}

function isC0OrC1(point: number): boolean {
  return point < 0x20 || (point >= 0x7f && point <= 0x9f);
}

function isPrivateUse(point: number): boolean {
  return (
    (point >= 0xe000 && point <= 0xf8ff) ||
    (point >= 0xf0000 && point <= 0xffffd) ||
    (point >= 0x100000 && point <= 0x10fffd)
  );
}

function isVariationSelector(point: number): boolean {
  return (point >= 0xfe00 && point <= 0xfe0f) || (point >= 0xe0100 && point <= 0xe01ef);
}

function isTagCharacter(point: number): boolean {
  return point === 0xe0001 || (point >= 0xe0020 && point <= 0xe007f);
}

function isEmojiPresentationSelector(point: number): boolean {
  return point === 0xfe0e || point === 0xfe0f;
}

function isExtendedPictographic(point: number): boolean {
  return /\p{Extended_Pictographic}/u.test(character(point));
}

function isRegionalIndicator(point: number): boolean {
  return /\p{Regional_Indicator}/u.test(character(point));
}

function isSkinTone(point: number): boolean {
  return point >= 0x1f3fb && point <= 0x1f3ff;
}

function isEmojiZWJNeighbor(point: number): boolean {
  if (isEmojiPresentationSelector(point) || isSkinTone(point)) return true;
  if (point === 0x20e3) return true;
  if (isExtendedPictographic(point) || isRegionalIndicator(point)) return true;
  return false;
}

function isJoiningLetter(point: number): boolean {
  const ch = character(point);
  return /\p{L}/u.test(ch) && JOINING_LETTER.test(ch);
}

function isJoiningMark(point: number): boolean {
  return isMark(point) && JOINING_LETTER.test(character(point));
}

function isMark(point: number): boolean {
  return /\p{M}/u.test(character(point));
}

function isRtlLetter(point: number): boolean {
  return RTL_LETTER.test(character(point));
}

function isHan(point: number): boolean {
  return /\p{Script=Han}/u.test(character(point));
}

function isKhmer(point: number): boolean {
  return /\p{Script=Khmer}/u.test(character(point));
}

function isKhmerInherentVowel(point: number): boolean {
  return point === KHMER_INHERENT_AQ || point === KHMER_INHERENT_AA;
}

function isInvisibleRunChar(point: number): boolean {
  return point === ZWJ || point === ZWNJ || BIDI.has(point) || isTagCharacter(point);
}

function isLetterNumberOrSymbol(point: number): boolean {
  return /\p{L}|\p{N}|\p{S}/u.test(character(point));
}

function isKeycapBase(point: number): boolean {
  return point === 0x23 || point === 0x2a || (point >= 0x30 && point <= 0x39);
}

function isSkippableForLetters(point: number, tagged: boolean): boolean {
  if (tagged) return true;
  if (point === ZWJ || point === ZWNJ) return true;
  return isMark(point) || isDefaultIgnorable(point) || isC0OrC1(point);
}

function isSkippableForEmoji(point: number, tagged: boolean): boolean {
  if (tagged) return true;
  if (point === ZWJ) return true;
  return isEmojiPresentationSelector(point) || isSkinTone(point) || isTagCharacter(point);
}

/**
 * Marks code points that belong to a DOM placeholder `<iN>` / `</iN>`.
 * Neighbor scans treat those tokens as transparent so a joiner on either
 * side of a slot still sees the letters / emoji around it.
 */
function placeholderTagMask(points: readonly number[]): boolean[] {
  const mask = Array.from({ length: points.length }, () => false);
  let index = 0;
  while (index < points.length) {
    if (points[index] !== 0x3c) {
      index += 1;
      continue;
    }
    let cursor = index + 1;
    if (cursor < points.length && points[cursor] === 0x2f) cursor += 1;
    if (cursor >= points.length || points[cursor] !== 0x69) {
      index += 1;
      continue;
    }
    cursor += 1;
    const digitStart = cursor;
    while (cursor < points.length && points[cursor]! >= 0x30 && points[cursor]! <= 0x39) {
      cursor += 1;
    }
    if (cursor === digitStart || cursor >= points.length || points[cursor] !== 0x3e) {
      index += 1;
      continue;
    }
    for (let filled = index; filled <= cursor; filled += 1) mask[filled] = true;
    index = cursor + 1;
  }
  return mask;
}

interface NeighborTables {
  prevImmediate: Array<number | undefined>;
  prevLetter: Array<number | undefined>;
  nextLetter: Array<number | undefined>;
  prevEmoji: Array<number | undefined>;
  nextEmoji: Array<number | undefined>;
}

function buildNeighborTables(
  points: readonly number[],
  tagged: readonly boolean[],
): NeighborTables {
  const count = points.length;
  const prevImmediate: Array<number | undefined> = Array.from({ length: count });
  const prevLetter: Array<number | undefined> = Array.from({ length: count });
  const nextLetter: Array<number | undefined> = Array.from({ length: count });
  const prevEmoji: Array<number | undefined> = Array.from({ length: count });
  const nextEmoji: Array<number | undefined> = Array.from({ length: count });

  let lastImmediate: number | undefined;
  let lastAfterLetters: number | undefined;
  let lastAfterEmoji: number | undefined;
  for (let index = 0; index < count; index += 1) {
    prevImmediate[index] = lastImmediate;
    prevLetter[index] = lastAfterLetters;
    prevEmoji[index] =
      lastAfterEmoji !== undefined && isEmojiZWJNeighbor(lastAfterEmoji)
        ? lastAfterEmoji
        : undefined;
    const point = points[index]!;
    const tag = tagged[index] === true;
    if (!tag) lastImmediate = point;
    if (!isSkippableForLetters(point, tag)) lastAfterLetters = point;
    if (!isSkippableForEmoji(point, tag)) lastAfterEmoji = point;
  }

  let nextAfterLetters: number | undefined;
  let nextAfterEmoji: number | undefined;
  for (let index = count - 1; index >= 0; index -= 1) {
    nextLetter[index] = nextAfterLetters;
    nextEmoji[index] =
      nextAfterEmoji !== undefined && isEmojiZWJNeighbor(nextAfterEmoji)
        ? nextAfterEmoji
        : undefined;
    const point = points[index]!;
    const tag = tagged[index] === true;
    if (!isSkippableForLetters(point, tag)) nextAfterLetters = point;
    if (!isSkippableForEmoji(point, tag)) nextAfterEmoji = point;
  }

  return { prevImmediate, prevLetter, nextLetter, prevEmoji, nextEmoji };
}

function inEmojiTagSequence(
  points: readonly number[],
  tagged: readonly boolean[],
  index: number,
): boolean {
  let seenFlag = false;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (tagged[cursor] === true) continue;
    const point = points[cursor];
    if (point === undefined) return false;
    if (isTagCharacter(point)) continue;
    seenFlag = isExtendedPictographic(point);
    break;
  }
  if (!seenFlag) return false;
  for (let cursor = index; cursor < points.length; cursor += 1) {
    if (tagged[cursor] === true) continue;
    const point = points[cursor];
    if (point === undefined) return false;
    if (point === 0xe007f) return true;
    if (!isTagCharacter(point)) return false;
  }
  return false;
}

function keepVariationSelector(
  point: number,
  previous: number | undefined,
  mode: SanitizeMode,
): boolean {
  if (previous === undefined) return false;
  if (isEmojiPresentationSelector(point)) {
    return (
      isLetterNumberOrSymbol(previous) || isEmojiZWJNeighbor(previous) || isKeycapBase(previous)
    );
  }
  if (mode === 'aggressive') return false;
  return isHan(previous) || isLetterNumberOrSymbol(previous);
}

function keepJoiner(
  point: number,
  index: number,
  neighbors: NeighborTables,
  mode: SanitizeMode,
): boolean {
  if (point !== ZWJ && point !== ZWNJ) return false;
  if (
    point === ZWJ &&
    neighbors.prevEmoji[index] !== undefined &&
    neighbors.nextEmoji[index] !== undefined
  ) {
    return true;
  }
  const previous = neighbors.prevImmediate[index];
  if (previous !== undefined && isJoiningMark(previous)) return true;
  if (mode === 'aggressive') return false;
  const prev = neighbors.prevLetter[index];
  const next = neighbors.nextLetter[index];
  if (prev === undefined || next === undefined) return false;
  return isJoiningLetter(prev) && isJoiningLetter(next);
}

function mapSpace(point: number): string | null {
  if (point === 0x09) return ' ';
  if (point === 0x0a) return '\n';
  if (point === 0x0d) return '\n';
  if (point === 0x2028 || point === 0x2029) return '\n';
  if (/\p{Zs}/u.test(character(point))) return ' ';
  return null;
}

function needsJoinerTables(text: string): boolean {
  return text.includes('\u200d') || text.includes('\u200c') || text.includes('<i');
}

/**
 * NFC + the careful (or aggressive) format-character policy. Idempotent.
 * Does not collapse newlines or placeholder tags.
 */
export function sanitizeTranslationInput(text: string, mode: SanitizeMode = 'careful'): string {
  const normalized = stripLoneSurrogates(text.replace(/\r\n?/gu, '\n')).normalize('NFC');
  const points = toPoints(normalized);
  // Neighbor tables are omitted when there is no ZWJ/ZWNJ and no `<i` placeholder.
  // Tag-only strings (subdivision flags) take this path; inEmojiTagSequence walks
  // the points directly. keepJoiner is unreachable without a joiner in the text.
  const needsTables = needsJoinerTables(normalized);
  const tagged = needsTables ? placeholderTagMask(points) : undefined;
  const neighbors = needsTables && tagged ? buildNeighborTables(points, tagged) : undefined;
  let hasRtl = false;
  for (let index = 0; index < points.length; index += 1) {
    if (tagged?.[index] === true) continue;
    if (isRtlLetter(points[index]!)) {
      hasRtl = true;
      break;
    }
  }

  let output = '';
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;

    if (tagged?.[index] === true) {
      output += character(point);
      continue;
    }

    const space = mapSpace(point);
    if (space !== null) {
      output += space;
      continue;
    }

    if (isC0OrC1(point) || isPrivateUse(point)) continue;

    const previous = neighbors?.prevImmediate[index] ?? (index > 0 ? points[index - 1] : undefined);

    if (point === ZWJ || point === ZWNJ) {
      // `neighbors` is defined iff the text contained a joiner or `<i`.
      if (neighbors && keepJoiner(point, index, neighbors, mode)) output += character(point);
      continue;
    }

    if (BIDI.has(point)) {
      if (mode === 'careful' && hasRtl) output += character(point);
      continue;
    }

    if (isKhmerInherentVowel(point)) {
      if (previous !== undefined && isKhmer(previous)) output += character(point);
      continue;
    }

    if (isVariationSelector(point)) {
      if (keepVariationSelector(point, previous, mode)) output += character(point);
      continue;
    }

    if (isTagCharacter(point)) {
      if (inEmojiTagSequence(points, tagged ?? [], index)) output += character(point);
      continue;
    }

    if (ALWAYS_DROP.has(point) || isDefaultIgnorable(point)) continue;

    output += character(point);
  }

  return output;
}

/**
 * Strip runaway invisibles and control characters from model output.
 * Meaningful chillu ZWJ, emoji ZWJ/tag sequences, joining-script ZWNJ, and
 * bidi controls next to RTL letters are kept. Long consecutive joiner / tag /
 * bidi runs are dropped, and trailing joiners are trimmed except a chillu ZWJ.
 * Latin/CJK output does not keep bidi overrides.
 */
export function sanitizeModelOutput(text: string): string {
  const normalized = stripLoneSurrogates(text.replace(/\r\n?/gu, '\n')).normalize('NFC');
  const points = toPoints(normalized);
  // Same fast path as input: flags and other tag-only strings skip the tables.
  const needsTables = needsJoinerTables(normalized);
  const tagged = needsTables ? placeholderTagMask(points) : undefined;
  const neighbors = needsTables && tagged ? buildNeighborTables(points, tagged) : undefined;
  let hasRtl = false;
  for (let index = 0; index < points.length; index += 1) {
    if (tagged?.[index] === true) continue;
    if (isRtlLetter(points[index]!)) {
      hasRtl = true;
      break;
    }
  }

  const keep = points.map((point, index) => {
    if (tagged?.[index] === true) return true;
    if (point === 0x09 || point === 0x0a) return true;
    if (isC0OrC1(point) || isPrivateUse(point) || ALWAYS_DROP.has(point)) return false;
    const previous = neighbors?.prevImmediate[index] ?? (index > 0 ? points[index - 1] : undefined);
    if (isKhmerInherentVowel(point)) return previous !== undefined && isKhmer(previous);
    if (point === ZWJ || point === ZWNJ) {
      return neighbors !== undefined && keepJoiner(point, index, neighbors, 'careful');
    }
    if (BIDI.has(point)) return hasRtl;
    if (isVariationSelector(point)) {
      return keepVariationSelector(point, previous, 'careful');
    }
    if (isTagCharacter(point)) return inEmojiTagSequence(points, tagged ?? [], index);
    if (isDefaultIgnorable(point)) return false;
    if (point === 0x1f3f4) {
      for (let cursor = index + 1; cursor < points.length; cursor += 1) {
        if (tagged?.[cursor] === true) continue;
        const next = points[cursor];
        if (next === undefined) break;
        if (isTagCharacter(next)) return inEmojiTagSequence(points, tagged ?? [], cursor);
        break;
      }
    }
    return true;
  });

  let cursor = 0;
  while (cursor < points.length) {
    if (!isInvisibleRunChar(points[cursor]!)) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    let protectedRun = false;
    while (cursor < points.length && isInvisibleRunChar(points[cursor]!)) {
      if (keep[cursor] === true) protectedRun = true;
      cursor += 1;
    }
    if (!protectedRun && cursor - start > MAX_INVISIBLE_RUN) {
      for (let drop = start; drop < cursor; drop += 1) keep[drop] = false;
    }
  }

  const kept: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    if (keep[index] === true) kept.push(points[index]!);
  }
  while (kept.length > 0) {
    const last = kept[kept.length - 1]!;
    if (last !== ZWJ && last !== ZWNJ) break;
    const previous = kept[kept.length - 2];
    if (last === ZWJ && previous !== undefined && isJoiningMark(previous)) break;
    kept.pop();
  }
  return kept.map(character).join('');
}

function placeholderTagLength(text: string, index: number): number {
  if (text.charCodeAt(index) !== 0x3c) return 0;
  let cursor = index + 1;
  if (text.charCodeAt(cursor) === 0x2f) cursor += 1;
  if (text.charCodeAt(cursor) !== 0x69) return 0;
  cursor += 1;
  const digitStart = cursor;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code < 0x30 || code > 0x39) break;
    cursor += 1;
  }
  if (cursor === digitStart || text.charCodeAt(cursor) !== 0x3e) return 0;
  return cursor + 1 - index;
}

/**
 * True when the string has a letter, number, punctuation, symbol, or mark
 * after dropping placeholder tags and invisibles. Stops at the first visible
 * character so a large selection is not fully copied.
 */
export function hasTranslatableText(text: string): boolean {
  const stripped = stripLoneSurrogates(text);
  for (let index = 0; index < stripped.length;) {
    const tagLength = placeholderTagLength(stripped, index);
    if (tagLength > 0) {
      index += tagLength;
      continue;
    }
    const point = stripped.codePointAt(index);
    if (point === undefined) break;
    index += point > 0xffff ? 2 : 1;
    if (point === 0x09 || point === 0x0a || point === 0x0d) continue;
    if (isC0OrC1(point) || isPrivateUse(point) || ALWAYS_DROP.has(point)) continue;
    if (point === ZWJ || point === ZWNJ || BIDI.has(point)) continue;
    if (isVariationSelector(point) || isTagCharacter(point)) continue;
    if (isDefaultIgnorable(point)) continue;
    if (mapSpace(point) !== null) continue;
    if (VISIBLE_CONTENT.test(character(point))) return true;
  }
  return false;
}

/** Visible letters/marks/punctuation after careful sanitizing; used to detect empty output. */
export function visibleContent(text: string): string {
  let output = '';
  for (const ch of sanitizeTranslationInput(text)) {
    if (VISIBLE_CONTENT.test(ch)) output += ch;
  }
  return output;
}

function validTagChars(output: string): number {
  let count = 0;
  for (const ch of sanitizeModelOutput(output)) {
    const point = ch.codePointAt(0);
    if (point !== undefined && isTagCharacter(point)) count += 1;
  }
  return count;
}

/**
 * True when the model produced no (or almost no) visible text from a real source.
 * No visible text plus leftover non-space characters is always a runaway.
 * Otherwise hidden = compact − visible, minus tag characters of valid emoji
 * tag sequences (England/Scotland flags) that the output sanitizer keeps.
 * RTL ZWNJ/ZWJ and bidi stay in the hidden count because they can still be a
 * joiner storm. Runaway if significant ≥ max(16, visible×8), or if the token
 * budget filled with significant ≥ 16 and more than four times the visible count.
 */
export function isInvisibleRunawayOutput(
  source: string,
  output: string,
  hitMaxTokens = false,
): boolean {
  if (!hasTranslatableText(source)) return false;
  const visible = visibleContent(output);
  const compact = [...output.replace(/\s+/gu, '')];
  const visibleCount = [...visible].length;
  if (visibleCount === 0) return compact.length > 0;
  const hidden = Math.max(0, compact.length - visibleCount);
  const significant = Math.max(0, hidden - validTagChars(output));
  if (significant >= Math.max(16, visibleCount * 8)) return true;
  return hitMaxTokens && significant >= 16 && significant > visibleCount * 4;
}

/** The #73 fixture: WORD JOINER, ZWNJ and ZWJ stuffed into Latin text. */
export const ISSUE_73_HIDDEN =
  '\u2060\u200C\u200D\u200D\u200D\u200D\u200D\u200D\u200D\u200C\u200D\u200D\u200D\u200C\u200D\u200D\u200D\u200C\u200C\u200C\u200D\u200C\u200D\u200C\u200C\u2060';
