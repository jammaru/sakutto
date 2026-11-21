/**
 * Caption-only text cleanup. ASR providers (and translation models) occasionally emit
 * segment sentinels such as S1, ED or NC, stray E/T tokens, sound tags and repeated
 * words. Those must never reach a prompt or the overlay. This module is deliberately
 * caption-scoped: the page translation pipeline does not import it.
 */

/** Standalone sentinels. Short letter codes are only stripped next to CJK text. */
const SENTINEL = /\b(?:S\d{1,2}|NC|RS|ED)\b[\s\u3000]*/gu;
const LETTER_SENTINEL = /(^|[\s\u3000。、！？…,.!?;:])(?:E|T|S)(?=[\s\u3000。、！？…,.!?;:]|$)/gu;
/** A lone E/T/S at a line edge is a sentinel even when the source is English. */
const EDGE_SENTINEL_START = /^\s*[ETS]\s+(?=\S)/u;
const EDGE_SENTINEL_END = /\s+[ETS]\s*$/u;
const CJK = /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/u;

/** Bracketed/parenthesised production tags and musical-note runs. */
const SOUND_TAG_WORD =
  'music|musical|instrumental|singing|laughter|laughing|applause|clapping|noise|inaudible|silence|背景音|音楽|拍手|笑い声|効果音|無音';
const BRACKET_TAG = new RegExp(`\\[[\\s,.]*(?:${SOUND_TAG_WORD})[\\s!.,]*\\]`, 'giu');
const PAREN_TAG =
  /\((?:music|musical|instrumental|singing|laughter|laughing|applause|clapping|noise|inaudible|silence|音楽|拍手|笑い声|効果音)\)/giu;
const NOTE_RUN = /[♪♫♩]+/gu;
const HASH_TAG = /#[^#\n]{1,24}#/gu;
const SOUND_WORD =
  /^(?:music|musical|instrumental|singing|laughter|laughing|applause|clapping|noise|inaudible|silence|背景音|音楽|拍手|笑い声|効果音|無音)$/iu;

/**
 * Repeated one-to-three word sequences. ASR stutters (in a in a, the the) are collapsed
 * before translation so the target language never inherits an English fragment in the
 * middle of a sentence.
 */
const STUTTER = /\b([A-Za-z]{1,8}(?:[ \u00a0]+[A-Za-z]{1,8}){0,2})(?:[ \u00a0]+\1)+\b/giu;

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

/** Remove sentinel tokens that ASR/model output sometimes leaves next to captions. */
export function stripCaptionMarkers(value: string): string {
  let text = value
    .replace(SENTINEL, ' ')
    .replace(EDGE_SENTINEL_START, '')
    .replace(EDGE_SENTINEL_END, '');
  if (CJK.test(text)) text = text.replace(LETTER_SENTINEL, '$1');
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

/**
 * True for cues that are nothing but a sound tag ([Music], [音楽], ♪, (music)).
 * Such cues are dropped before any translation request is made.
 */
export function isSoundTagOnly(value: string): boolean {
  const text = value.trim();
  if (text.length === 0) return false;
  const stripped = squashSpaces(stripTags(text));
  if (stripped.length === 0) return true;
  return stripped
    .split(/[\s、。,.!?]+/u)
    .every((word) => word.length === 0 || SOUND_WORD.test(word));
}

/** Full cleanup applied to a caption before it is translated or displayed. */
export function cleanCaptionText(value: string): string {
  const withoutMarkers = stripCaptionMarkers(value);
  const withoutStutter = collapseCaptionStutter(withoutMarkers);
  return stripCaptionSoundTags(withoutStutter);
}

/**
 * Source-side cleanup. Pure sound tags return an empty string so the caller can drop
 * the cue entirely instead of sending it to the model.
 */
export function cleanCaptionSource(value: string): string {
  return isSoundTagOnly(value) ? '' : cleanCaptionText(value);
}
