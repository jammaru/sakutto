/**
 * Prepares source (and model output) for translation.
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
 * - Keep ZWJ inside emoji ZWJ sequences (family, role, flags-as-ZWJ).
 * - Keep ZWNJ/ZWJ between letters of scripts that use them (Arabic/Persian,
 *   Hebrew, Indic, and other joining scripts).
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
 * alignment is unchanged. Callers must sanitize only the text sent to the model,
 * never the live Text nodes: restore still uses `slot.original`.
 *
 * Aggressive mode is a retry: it also drops ZWNJ/ZWJ/bidi that careful mode
 * kept, but still preserves emoji ZWJ sequences, emoji VS, and tag flags.
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
  0x17b4,
  0x17b5,
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

function isMark(point: number): boolean {
  return /\p{M}/u.test(character(point));
}

function isRtlLetter(point: number): boolean {
  return RTL_LETTER.test(character(point));
}

function isHan(point: number): boolean {
  return /\p{Script=Han}/u.test(character(point));
}

function isLetterNumberOrSymbol(point: number): boolean {
  return /\p{L}|\p{N}|\p{S}/u.test(character(point));
}

function isKeycapBase(point: number): boolean {
  return point === 0x23 || point === 0x2a || (point >= 0x30 && point <= 0x39);
}

function skipIgnorable(points: readonly number[], start: number, step: 1 | -1): number | undefined {
  for (let index = start; index >= 0 && index < points.length; index += step) {
    const point = points[index];
    if (point === undefined) continue;
    if (point === ZWJ || point === ZWNJ) continue;
    if (isMark(point) || isDefaultIgnorable(point) || isC0OrC1(point)) continue;
    return point;
  }
  return undefined;
}

function skipEmoji(points: readonly number[], start: number, step: 1 | -1): number | undefined {
  for (let index = start; index >= 0 && index < points.length; index += step) {
    const point = points[index];
    if (point === undefined) continue;
    if (
      point === ZWJ ||
      isEmojiPresentationSelector(point) ||
      isSkinTone(point) ||
      isTagCharacter(point)
    ) {
      continue;
    }
    if (isEmojiZWJNeighbor(point)) return point;
    return undefined;
  }
  return undefined;
}

function inEmojiTagSequence(points: readonly number[], index: number): boolean {
  let seenFlag = false;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const point = points[cursor];
    if (point === undefined) return false;
    if (isTagCharacter(point)) continue;
    seenFlag = isExtendedPictographic(point);
    break;
  }
  if (!seenFlag) return false;
  for (let cursor = index; cursor < points.length; cursor += 1) {
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
  points: readonly number[],
  index: number,
  mode: SanitizeMode,
): boolean {
  const prevEmoji = skipEmoji(points, index - 1, -1);
  const nextEmoji = skipEmoji(points, index + 1, 1);
  if (point === ZWJ && prevEmoji !== undefined && nextEmoji !== undefined) return true;

  if (mode === 'aggressive') return false;

  const prev = skipIgnorable(points, index - 1, -1);
  const next = skipIgnorable(points, index + 1, 1);
  if (prev === undefined || next === undefined) return false;
  if (point === ZWNJ || point === ZWJ) {
    return isJoiningLetter(prev) && isJoiningLetter(next);
  }
  return false;
}

function mapSpace(point: number): string | null {
  if (point === 0x09) return ' ';
  if (point === 0x0a) return '\n';
  if (point === 0x0d) return '\n';
  if (point === 0x2028 || point === 0x2029) return '\n';
  if (/\p{Zs}/u.test(character(point))) return ' ';
  return null;
}

/**
 * NFC + the careful (or aggressive) format-character policy. Idempotent.
 * Does not collapse newlines or placeholder tags.
 */
export function sanitizeTranslationInput(text: string, mode: SanitizeMode = 'careful'): string {
  const normalized = stripLoneSurrogates(text.replace(/\r\n?/gu, '\n')).normalize('NFC');
  const points = toPoints(normalized);
  let hasRtl = false;
  for (const point of points) {
    if (isRtlLetter(point)) {
      hasRtl = true;
      break;
    }
  }

  let output = '';
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;

    const space = mapSpace(point);
    if (space !== null) {
      output += space;
      continue;
    }

    if (isC0OrC1(point) || isPrivateUse(point)) continue;

    if (point === ZWJ || point === ZWNJ) {
      if (keepJoiner(point, points, index, mode)) output += character(point);
      continue;
    }

    if (BIDI.has(point)) {
      if (mode === 'careful' && hasRtl) output += character(point);
      continue;
    }

    if (isVariationSelector(point)) {
      const previous = points[index - 1];
      if (keepVariationSelector(point, previous, mode)) output += character(point);
      continue;
    }

    if (isTagCharacter(point)) {
      if (inEmojiTagSequence(points, index)) output += character(point);
      continue;
    }

    if (ALWAYS_DROP.has(point) || isDefaultIgnorable(point)) continue;

    output += character(point);
  }

  return output;
}

/** True when the string has a letter, number, punctuation, symbol, or mark after sanitizing. */
export function hasTranslatableText(text: string): boolean {
  return visibleContent(text).length > 0;
}

/** Visible letters/marks/punctuation after careful sanitizing; used to detect empty output. */
export function visibleContent(text: string): string {
  let output = '';
  for (const character of sanitizeTranslationInput(text)) {
    if (VISIBLE_CONTENT.test(character)) output += character;
  }
  return output;
}

/**
 * True when the model produced no (or almost no) visible text from a real source:
 * a run of format chars, or a length finish with nothing the reader can see.
 */
export function isInvisibleRunawayOutput(
  source: string,
  output: string,
  hitMaxTokens = false,
): boolean {
  if (visibleContent(source).length === 0) return false;
  const visible = visibleContent(output);
  if (visible.length === 0) return output.replace(/\s+/gu, '').length > 0;
  const compact = output.replace(/\s+/gu, '');
  if (compact.length >= 16 && visible.length / compact.length < 0.2) return true;
  if (hitMaxTokens && visible.length < 8 && compact.length > visible.length * 4) return true;
  return false;
}

/** The #73 fixture: WORD JOINER, ZWNJ and ZWJ stuffed into Latin text. */
export const ISSUE_73_HIDDEN =
  '\u2060\u200C\u200D\u200D\u200D\u200D\u200D\u200D\u200D\u200C\u200D\u200D\u200D\u200C\u200D\u200D\u200D\u200C\u200C\u200C\u200D\u200C\u200D\u200C\u200C\u2060';
