/**
 * Caption-only text cleanup. ASR providers (and translation models) occasionally emit
 * segment sentinels such as S1, ED or NC, stray E/T tokens, sound tags and repeated
 * words. Those must never reach an ASR prompt or the overlay.
 *
 * Human/manual captions are deliberately NOT exposed to that aggressive cleanup:
 * `cleanHumanCaptionText` only normalises whitespace, so ordinary words such as "NC",
 * "T Shirts", "S is", "key of E" and legitimate repetitions ("had had", "very very")
 * survive verbatim. Maintainer-pattern stripping is restricted and confined to the
 * ASR helpers.
 * The module is caption-scoped: the page translation pipeline does not import it.
 */

const CJK_CHARS = '\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef';
const CJK = new RegExp(`[${CJK_CHARS}]`, 'u');

/** Boundary after a short maintainer code: whitespace, CJK punctuation, CJK or end. */
const AFTER_CODE = `(?=[\\s\\u3000${CJK_CHARS}]|$)`;
/** Boundary before a trailing maintainer code, captured so punctuation is preserved. */
const BEFORE_CODE = '(^|[\\s\\u3000。、！？…])';

/**
 * Restricted maintainer markers. Long codes are only removed at a line edge or next
 * to CJK; one-letter codes are only removed next to CJK (or as a leading English E,
 * the exact ASR artefact the maintainer fixtures contain). This keeps English words
 * and initials intact when the aggressive path is used on ASR text.
 */
const LEAD_NUMBERED = new RegExp(`^\\s*S\\d{1,2}${AFTER_CODE}[\\s\\u3000]*`, 'u');
const LEAD_MULTI = new RegExp(`^\\s*(?:NC|RS|ED)${AFTER_CODE}[\\s\\u3000]*`, 'u');
const LEAD_CJK_CODE = new RegExp(
  `^\\s*[ETS](?!\\s*(?:サイズ|シャツ))${AFTER_CODE}[\\s\\u3000]*(?=[\\s\\u3000${CJK_CHARS}])`,
  'u',
);
const LEAD_ENGLISH_E = /^\s*E(?=[\s\u3000]+[A-Za-z])[\s\u3000]*/u;
const TRAIL_MULTI = new RegExp(`${BEFORE_CODE}(?:NC|RS|ED)[\\s\\u3000]*$`, 'u');
const TRAIL_CJK_CODE = new RegExp(`${BEFORE_CODE}(?:S\\d{1,2}|NC|RS|ED|[ETS])[\\s\\u3000]*$`, 'u');

/** Bracketed/parenthesised production tags and musical-note runs. */
const SOUND_TAG_WORD =
  'music|musical|instrumental|singing|laughter|laughing|applause|clapping|noise|inaudible|silence|背景音|音楽|拍手|笑い声|効果音|無音';
const BRACKET_TAG = new RegExp(`\\[[\\s,.]*(?:${SOUND_TAG_WORD})[\\s!.,]*\\]`, 'giu');
const PAREN_TAG = new RegExp(`\\((?:${SOUND_TAG_WORD})\\)`, 'giu');
const NOTE_RUN = /[♪♫♩]+/gu;
const HASH_TAG = /#[^#\n]{1,24}#/gu;
/**
 * Bare sound words are an ASR-only policy. A plain "Music" / "音楽" cue can be real
 * human caption text, so this must NOT be folded into `isSoundTagOnly`.
 */
const SOUND_WORD =
  /^(?:music|musical|instrumental|singing|laughter|laughing|applause|clapping|noise|inaudible|silence|背景音|音楽|拍手|笑い声|効果音|無音)$/iu;

/**
 * Repeated two-to-three word sequences are ASR stutters ("in a in a"). Single-word
 * repetitions ("had had", "very very", "no no") are legitimate English emphasis and
 * must be preserved.
 */
const STUTTER =
  /\b([A-Za-z]{1,8}[ \u00a0]+[A-Za-z]{1,8}(?:[ \u00a0]+[A-Za-z]{1,8})?)(?:[ \u00a0]+\1)+\b/giu;

function stripTags(value: string): string {
  return value
    .replace(BRACKET_TAG, ' ')
    .replace(PAREN_TAG, ' ')
    .replace(HASH_TAG, ' ')
    .replace(NOTE_RUN, ' ');
}

function squashSpaces(value: string): string {
  return value
    .replace(/[ \t\u00a0]{2,}/gu, ' ')
    .replace(/\s+([。、！？…,.!?;:])/gu, '$1')
    .trim();
}

/** Remove only ASR maintainer markers; repeat to keep the result idempotent. */
export function stripCaptionMarkers(value: string): string {
  const hasCjk = CJK.test(value);
  let text = value;
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    text = text.replace(LEAD_NUMBERED, '').replace(LEAD_MULTI, '').replace(LEAD_ENGLISH_E, '');
    if (hasCjk) {
      text = text.replace(LEAD_CJK_CODE, '').replace(TRAIL_CJK_CODE, '$1');
    }
    text = text.replace(TRAIL_MULTI, '$1');
    if (text === before) break;
  }
  return squashSpaces(text);
}

/** Collapse ASR stutters; an already clean string is returned unchanged. */
export function collapseCaptionStutter(value: string): string {
  return value.replace(STUTTER, '$1');
}

/** Drop production tags but keep a ♪-wrapped lyric line as translatable text. */
export function stripCaptionSoundTags(value: string): string {
  return squashSpaces(stripTags(value));
}

/** True for a cue that is nothing but a bracketed/parenthesised sound tag or notes. */
export function isSoundTagOnly(value: string): boolean {
  const text = value.trim();
  if (text.length === 0) return false;
  return squashSpaces(stripTags(text)).length === 0;
}

/** True for a *bare* sound word. Only the ASR path uses this as a drop policy. */
export function isBareSoundWord(value: string): boolean {
  return SOUND_WORD.test(value.trim());
}

/** Human/manual captions: only whitespace is normalised, never any words. */
export function cleanHumanCaptionText(value: string): string {
  return squashSpaces(value);
}

/** ASR captions: restricted markers, ASR-only stutters and production tags. */
export function cleanAsrCaptionText(value: string): string {
  // Tags first: stripping ♪/[Music] can expose a leading/trailing maintainer code.
  return collapseCaptionStutter(stripCaptionMarkers(stripCaptionSoundTags(value)));
}

/**
 * General caption cleanup kept for callers that clean an unknown source once. Its
 * patterns are restricted, so ordinary human words and repetition are preserved.
 * Human ingestion/display use {@link cleanHumanCaptionText} instead.
 */
export function cleanCaptionText(value: string): string {
  return cleanAsrCaptionText(value);
}

/** Apply the right cleanup without the pure-tag drop (contexts, model output). */
export function cleanCaptionForMode(value: string, asr = false): string {
  return asr ? cleanAsrCaptionText(value) : cleanHumanCaptionText(value);
}

/**
 * The single normalisation used for cache keys, model source and overlay original.
 * A pure bracketed tag returns an empty string; a bare sound word only does so on
 * the ASR path, where "music" is a production cue rather than caption prose.
 */
export function cleanCaptionSource(value: string, asr = false): string {
  if (isSoundTagOnly(value) || (asr && isBareSoundWord(value))) return '';
  return cleanCaptionForMode(value, asr);
}
