import { hasSentenceTerminator, splitForTranslation } from '@/engine/text/sentences';
import { sanitizeTranslationInput } from '@/engine/text/sanitize';
import { cleanCaptionText } from './text-cleanup';

export interface CaptionCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  language?: string | undefined;
}

/**
 * A growing ASR line is translated while it is still on screen. 250 ms is long
 * enough to coalesce the burst of DOM writes for one word, short enough that a
 * new line does not wait for the sentence to finish before any request starts.
 */
export const LIVE_CAPTION_MAX_WAIT_MS = 250;
export const LIVE_CAPTION_MAX_CHARS = 72;
export const LIVE_CAPTION_MIN_DISPLAY_MS = 1_400;
/** Coalesce ASR growth briefly; replacement captions start without this delay. */
export const LIVE_CAPTION_DEBOUNCE_MS = 120;
export const WORD_CUE_MERGE_GAP_MS = 800;
export const WORD_CUE_MERGE_MAX_MS = 3_500;
export const WORD_CUE_MERGE_MAX_CHARS = 96;
export const SENTENCE_CUE_MERGE_GAP_MS = 1_500;
export const SENTENCE_CUE_MERGE_MAX_MS = 12_000;
export const SENTENCE_CUE_MERGE_MAX_CHARS = 280;
/** Japanese ASR rarely punctuates; cap merged phrases so they stay translatable. */
export const CJK_SENTENCE_CUE_MERGE_MAX_MS = 6_000;
export const CJK_SENTENCE_CUE_MERGE_MAX_CHARS = 80;
/** Fill only short ASR silences; longer pauses must not keep an old line on screen. */
export const ASR_CUE_GAP_FILL_MS = 900;
/**
 * ASR phrase grouping. A whole-sentence merge made the first translated line wait
 * for up to six seconds of speech, so ASR cues are now kept to short phrases and
 * the next phrases are prefetched instead of being glued to the current one.
 */
export const ASR_PHRASE_MERGE_GAP_MS = 700;
export const ASR_PHRASE_MERGE_MAX_MS = 4_000;
export const ASR_PHRASE_MERGE_MAX_CHARS = 120;
export const CJK_ASR_PHRASE_MERGE_MAX_MS = 2_800;
export const CJK_ASR_PHRASE_MERGE_MAX_CHARS = 48;
export const WEBVTT_HOUR_OFFSET_MS = 3_600_000;

const VTT_TIMESTAMP =
  /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})/;

export function normalizeCaptionText(value: string): string {
  return cleanCaptionText(
    sanitizeTranslationInput(value)
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/gu, ' ')
      .replace(/\s*\n\s*/gu, '\n')
      .trim(),
  );
}

export function captionCueId(startMs: number, text: string): string {
  return `${startMs}:${text.length}:${hashText(text)}`;
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function timestampToMs(
  hours: string | undefined,
  minutes: string,
  seconds: string,
  millis: string,
): number {
  const hour = hours === undefined ? 0 : Number(hours);
  return ((hour * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(millis);
}

/**
 * Parses a WebVTT document into cues. Cue settings and NOTE/STYLE blocks are ignored.
 * The parser is intentionally small: it only needs timestamps and text for translation.
 */
export function parseWebVtt(source: string, language?: string): CaptionCue[] {
  const lines = source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const cues: CaptionCue[] = [];
  let index = 0;

  if (lines[0]?.startsWith('WEBVTT')) index = 1;

  let mapOffsetMs = 0;
  while (index < lines.length) {
    const header = (lines[index] ?? '').trim();
    if (header.length === 0) {
      index += 1;
      continue;
    }
    if (header.startsWith('NOTE') || header.startsWith('STYLE') || header.startsWith('REGION')) {
      index += 1;
      continue;
    }
    if (header.toUpperCase().startsWith('X-TIMESTAMP-MAP=')) {
      mapOffsetMs = parseXTimestampMap(header) ?? mapOffsetMs;
      index += 1;
      continue;
    }
    break;
  }

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0 || line.startsWith('NOTE') || line.startsWith('STYLE')) {
      index += 1;
      continue;
    }

    let stamp = line;
    if (!stamp.includes('-->') && index + 1 < lines.length) {
      index += 1;
      stamp = lines[index] ?? '';
    }

    const match = VTT_TIMESTAMP.exec(stamp.trim());
    if (!match) {
      index += 1;
      continue;
    }

    const startMs = timestampToMs(match[1], match[2] ?? '00', match[3] ?? '00', match[4] ?? '000');
    const endMs = timestampToMs(match[5], match[6] ?? '00', match[7] ?? '00', match[8] ?? '000');
    index += 1;
    const textLines: string[] = [];
    while (index < lines.length && (lines[index] ?? '').trim().length > 0) {
      textLines.push(lines[index] ?? '');
      index += 1;
    }
    const text = normalizeCaptionText(textLines.join('\n'));
    if (text.length === 0 || endMs <= startMs) continue;
    cues.push({
      id: captionCueId(startMs, text),
      startMs,
      endMs,
      text,
      ...(language ? { language } : {}),
    });
  }

  return alignCaptionCuesToMedia(cues, undefined, mapOffsetMs);
}

function parseXTimestampMap(header: string): number | null {
  const match = /X-TIMESTAMP-MAP=LOCAL:([^,]+),MPEGTS:(\d+)/iu.exec(header);
  if (!match) return null;
  const localMs = parseVttClock(match[1] ?? '');
  const mpegts = Number(match[2]);
  if (localMs === null || !Number.isFinite(mpegts)) return null;
  return Math.round(mpegts / 90 - localMs);
}

function parseVttClock(value: string): number | null {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/u.exec(value.trim());
  if (!match) {
    const short = /^(\d{2}):(\d{2})\.(\d{3})$/u.exec(value.trim());
    if (!short) return null;
    return timestampToMs(undefined, short[1] ?? '00', short[2] ?? '00', short[3] ?? '000');
  }
  return timestampToMs(match[1], match[2] ?? '00', match[3] ?? '00', match[4] ?? '000');
}

interface Json3Segment {
  utf8?: unknown;
}

interface Json3Event {
  tStartMs?: unknown;
  dDurationMs?: unknown;
  segs?: unknown;
}

/**
 * YouTube `fmt=json3` timedtext. Events without `segs` are timing or style markers.
 */
export function parseTimedtextJson3(value: unknown, language?: string): CaptionCue[] {
  if (typeof value !== 'object' || value === null) return [];
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];

  const cues: CaptionCue[] = [];
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const record = event as Json3Event;
    if (typeof record.tStartMs !== 'number' || typeof record.dDurationMs !== 'number') continue;
    if (!Array.isArray(record.segs)) continue;
    const text = normalizeCaptionText(
      record.segs
        .map((segment) => {
          if (typeof segment !== 'object' || segment === null) return '';
          const utf8 = (segment as Json3Segment).utf8;
          return typeof utf8 === 'string' ? utf8 : '';
        })
        .join(''),
    );
    if (text.length === 0) continue;
    const startMs = record.tStartMs;
    const endMs = startMs + Math.max(0, record.dDurationMs);
    if (endMs <= startMs) continue;
    cues.push({
      id: captionCueId(startMs, text),
      startMs,
      endMs,
      text,
      ...(language ? { language } : {}),
    });
  }
  return cues;
}

/**
 * Auto-captions often arrive as one word per cue. Merge them into phrase-sized units so
 * the model sees a sentence rather than a stream of single tokens.
 */
export function mergeWordCues(cues: readonly CaptionCue[]): CaptionCue[] {
  if (cues.length === 0) return [];
  const merged: CaptionCue[] = [];
  let current: CaptionCue | null = null;

  const commit = (): void => {
    if (!current) return;
    merged.push(current);
    current = null;
  };

  for (const cue of cues) {
    if (!current) {
      current = { ...cue };
      continue;
    }

    const gap = cue.startMs - current.endMs;
    const duration = cue.endMs - current.startMs;
    const joined = joinCaptionFragments(current.text, cue.text);
    const shouldMerge =
      gap <= WORD_CUE_MERGE_GAP_MS &&
      duration <= WORD_CUE_MERGE_MAX_MS &&
      joined.length <= WORD_CUE_MERGE_MAX_CHARS &&
      !hasSentenceTerminator(current.text) &&
      isWordFragment(cue);

    if (!shouldMerge) {
      commit();
      current = { ...cue };
      continue;
    }

    current = {
      ...current,
      id: captionCueId(current.startMs, joined),
      endMs: Math.max(current.endMs, cue.endMs),
      text: joined,
    };
    if (hasSentenceTerminator(current.text) || current.text.length >= WORD_CUE_MERGE_MAX_CHARS) {
      commit();
    }
  }

  commit();
  return merged;
}

/** Word-level ASR tokens only. Full caption lines must not be glued into a false sentence. */
function isWordFragment(cue: CaptionCue): boolean {
  const trimmed = cue.text.trim();
  if (trimmed.length === 0 || trimmed.length > 16) return false;
  const cjk = isMostlyCjk(trimmed);
  if (/\s/u.test(trimmed) && !cjk) return false;
  const maxMs = cjk ? 1_800 : WORD_CUE_MERGE_GAP_MS;
  return cue.endMs - cue.startMs <= maxMs;
}

function isCjkChar(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x31f0 && code <= 0x31ff) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

function isMostlyCjk(text: string): boolean {
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (/\s/u.test(character)) continue;
    if (isCjkChar(character)) cjk += 1;
    else other += 1;
  }
  return cjk >= 2 && cjk >= other;
}

/** Japanese ASR has no spaces; do not insert ASCII gaps that become empty/huge segments. */
export function joinCaptionFragments(left: string, right: string): string {
  const a = left.trimEnd();
  const b = right.trimStart();
  if (a.length === 0) return normalizeCaptionText(b);
  if (b.length === 0) return normalizeCaptionText(a);
  const leftChar = a[a.length - 1] ?? '';
  const rightChar = b[0] ?? '';
  const cjkBoundary =
    (isCjkChar(leftChar) && isCjkChar(rightChar)) ||
    /[\u3000-\u303f\uff00-\uffef]$/u.test(a) ||
    /^[\u3000-\u303f\uff00-\uffef]/u.test(b);
  if (isMostlyCjk(a) && isMostlyCjk(b)) return normalizeCaptionText(`${a}${b}`);
  return normalizeCaptionText(`${a}${cjkBoundary ? '' : ' '}${b}`);
}

/**
 * YouTube ja ASR json3 often repeats a growing line as overlapping events
 * (`駅は` → `駅は夜明けに`). Concatenating those duplicates yields untranslatable text.
 */
export function collapseGrowingCaptionCues(cues: readonly CaptionCue[]): CaptionCue[] {
  if (cues.length === 0) return [];
  const merged: CaptionCue[] = [];
  for (const cue of cues) {
    const text = normalizeCaptionText(cue.text);
    if (text.length === 0) continue;
    const previous = merged.at(-1);
    if (!previous) {
      merged.push({ ...cue, text });
      continue;
    }
    const previousText = normalizeCaptionText(previous.text);
    const overlaps = cue.startMs <= previous.endMs + 80;
    const grows =
      text.startsWith(previousText) ||
      previousText.startsWith(text) ||
      (previousText.length >= 2 && text.includes(previousText));
    if (overlaps && grows) {
      const nextText = text.length >= previousText.length ? text : previousText;
      merged[merged.length - 1] = makeMergedCue(
        Math.min(previous.startMs, cue.startMs),
        Math.max(previous.endMs, cue.endMs),
        nextText,
        cue.language ?? previous.language,
      );
      continue;
    }
    merged.push({ ...cue, text });
  }
  return merged;
}

export function closeCaptionGaps(cues: readonly CaptionCue[], maxGapMs: number): CaptionCue[] {
  if (cues.length === 0) return [];
  const closed: CaptionCue[] = [];
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    if (!cue) continue;
    const next = cues[index + 1];
    const gap = next ? next.startMs - cue.endMs : 0;
    if (next && gap > 0 && gap <= maxGapMs) {
      closed.push(makeMergedCue(cue.startMs, next.startMs, cue.text, cue.language));
    } else {
      closed.push({ ...cue });
    }
  }
  return closed;
}

function splitCueSentences(text: string): string[] {
  const trimmed = normalizeCaptionText(text);
  if (trimmed.length === 0) return [];
  const parts = splitForTranslation(trimmed, { sentenceThreshold: 1 });
  return parts.length > 0 ? parts : [trimmed];
}

function makeMergedCue(
  startMs: number,
  endMs: number,
  text: string,
  language: string | undefined,
): CaptionCue {
  return {
    id: captionCueId(startMs, text),
    startMs,
    endMs,
    text,
    ...(language ? { language } : {}),
  };
}

export interface SentenceMergeLimits {
  gapMs: number;
  maxMs: number;
  maxChars: number;
  cjkMaxMs: number;
  cjkMaxChars: number;
}

const DEFAULT_SENTENCE_MERGE_LIMITS: SentenceMergeLimits = {
  gapMs: SENTENCE_CUE_MERGE_GAP_MS,
  maxMs: SENTENCE_CUE_MERGE_MAX_MS,
  maxChars: SENTENCE_CUE_MERGE_MAX_CHARS,
  cjkMaxMs: CJK_SENTENCE_CUE_MERGE_MAX_MS,
  cjkMaxChars: CJK_SENTENCE_CUE_MERGE_MAX_CHARS,
};

/** Short phrase-sized groups for auto-captions, where latency matters more than context. */
export const ASR_PHRASE_MERGE_LIMITS: SentenceMergeLimits = {
  gapMs: ASR_PHRASE_MERGE_GAP_MS,
  maxMs: ASR_PHRASE_MERGE_MAX_MS,
  maxChars: ASR_PHRASE_MERGE_MAX_CHARS,
  cjkMaxMs: CJK_ASR_PHRASE_MERGE_MAX_MS,
  cjkMaxChars: CJK_ASR_PHRASE_MERGE_MAX_CHARS,
};

/**
 * Join consecutive VOD cues into full sentences so the model is not asked to
 * translate mid-phrase fragments. Display uses the combined time span. Callers
 * can pass tighter limits (auto-captions do) so one translated line never covers
 * many seconds of speech.
 */
export function mergeSentenceCues(
  cues: readonly CaptionCue[],
  limits: Partial<SentenceMergeLimits> = {},
): CaptionCue[] {
  if (cues.length === 0) return [];
  const config: SentenceMergeLimits = { ...DEFAULT_SENTENCE_MERGE_LIMITS, ...limits };
  const merged: CaptionCue[] = [];
  let startMs = 0;
  let endMs = 0;
  let language: string | undefined;
  let parts: string[] = [];

  const currentText = (): string => {
    let text = '';
    for (const part of parts) text = joinCaptionFragments(text, part);
    return text;
  };

  const commit = (): void => {
    const text = currentText();
    if (text.length === 0) return;
    merged.push(makeMergedCue(startMs, endMs, text, language));
    parts = [];
  };

  const startGroup = (cue: CaptionCue, text: string): void => {
    startMs = cue.startMs;
    endMs = cue.endMs;
    language = cue.language;
    parts = [text];
  };

  for (const cue of cues) {
    for (const piece of splitCueSentences(cue.text)) {
      if (parts.length === 0) {
        startGroup(cue, piece);
      } else {
        const gap = cue.startMs - endMs;
        const duration = Math.max(endMs, cue.endMs) - startMs;
        const joined = joinCaptionFragments(currentText(), piece);
        const cjk = isMostlyCjk(joined);
        const canMerge =
          gap <= config.gapMs &&
          duration <= (cjk ? config.cjkMaxMs : config.maxMs) &&
          joined.length <= (cjk ? config.cjkMaxChars : config.maxChars) &&
          !hasSentenceTerminator(currentText());
        if (!canMerge) {
          commit();
          startGroup(cue, piece);
        } else {
          endMs = Math.max(endMs, cue.endMs);
          parts.push(piece);
        }
      }
      const built = currentText();
      const maxChars = isMostlyCjk(built) ? config.cjkMaxChars : config.maxChars;
      if (hasSentenceTerminator(built) || built.length >= maxChars) {
        commit();
      }
    }
  }
  commit();
  return merged;
}

const SENTENCE_UNIT_PAUSE_MS = 700;
const ROLLING_ASR_DEDUPE_GAP_MS = 250;
const SENTENCE_UNIT_MAX_MS = 7_000;
const SENTENCE_UNIT_MAX_CHARS = 84;
const CJK_SENTENCE_UNIT_MAX_CHARS = 42;

function normalizeSentenceUnitText(value: string): string {
  const lines = normalizeCaptionText(value).split('\n');
  let text = '';
  for (const line of lines) text = joinCaptionFragments(text, line);
  return text;
}

function rollingBoundaryIsWholeWord(left: string, right: string, length: number): boolean {
  const start = left.length - length;
  const before = left[start - 1] ?? '';
  const first = right[0] ?? '';
  const last = right[length - 1] ?? '';
  const after = right[length] ?? '';
  if (/[A-Za-z0-9]/u.test(before) && /[A-Za-z0-9]/u.test(first)) return false;
  if (/[A-Za-z0-9]/u.test(last) && /[A-Za-z0-9]/u.test(after)) return false;
  return true;
}

/** Return only the new part of a rolling ASR window, or an empty string for a stale window. */
function rollingCaptionDelta(previous: string, next: string): string {
  if (next.startsWith(previous)) return next;
  if (previous.startsWith(next) || previous.endsWith(next)) return '';

  const max = Math.min(previous.length, next.length);
  for (let length = max; length >= 2; length -= 1) {
    if (
      previous.slice(-length) === next.slice(0, length) &&
      rollingBoundaryIsWholeWord(previous, next, length)
    ) {
      return next.slice(length);
    }
  }
  return next;
}

/**
 * Convert rolling json3 windows into deltas. Comparing with the previous raw window (rather
 * than the previous delta) handles both growing prefixes and windows that drop their first words.
 */
function dedupeRollingCaptionCues(cues: readonly CaptionCue[]): CaptionCue[] {
  const fragments: CaptionCue[] = [];
  let previousRaw = '';
  let previousRawEndMs = 0;

  for (const cue of cues) {
    const text = normalizeSentenceUnitText(cue.text);
    if (text.length === 0 || !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs)) continue;
    if (cue.endMs <= cue.startMs) continue;

    const overlaps =
      fragments.length > 0 && cue.startMs <= previousRawEndMs + ROLLING_ASR_DEDUPE_GAP_MS;
    if (overlaps && text.startsWith(previousRaw)) {
      const previous = fragments.at(-1);
      if (previous) {
        previous.text = text;
        previous.endMs = Math.max(previous.endMs, cue.endMs);
        previousRaw = text;
        previousRawEndMs = Math.max(previousRawEndMs, cue.endMs);
        continue;
      }
    }
    const delta = overlaps ? rollingCaptionDelta(previousRaw, text) : text;
    const fragment = normalizeSentenceUnitText(delta);
    if (fragment.length > 0) {
      fragments.push(
        makeMergedCue(cue.startMs, cue.endMs, fragment, cue.language ?? fragments.at(-1)?.language),
      );
    } else if (overlaps) {
      const previous = fragments.at(-1);
      if (previous) previous.endMs = Math.max(previous.endMs, cue.endMs);
    }

    if (fragment.length > 0 || !overlaps) previousRaw = text;
    previousRawEndMs = Math.max(overlaps ? previousRawEndMs : 0, cue.endMs);
  }
  return fragments;
}

function sentenceUnitMaxChars(text: string): number {
  return isMostlyCjk(text) ? CJK_SENTENCE_UNIT_MAX_CHARS : SENTENCE_UNIT_MAX_CHARS;
}

function joinSentenceUnitCues(left: CaptionCue, right: CaptionCue): CaptionCue {
  const text = /^[,.!?;:%、。，！？；：]/u.test(right.text.trimStart())
    ? normalizeSentenceUnitText(`${left.text.trimEnd()}${right.text.trimStart()}`)
    : joinCaptionFragments(left.text, right.text);
  return makeMergedCue(
    Math.min(left.startMs, right.startMs),
    Math.max(left.endMs, right.endMs),
    text,
    left.language ?? right.language,
  );
}

function sentenceUnitExceedsLimits(cue: CaptionCue): boolean {
  return (
    cue.endMs - cue.startMs > SENTENCE_UNIT_MAX_MS ||
    cue.text.length > sentenceUnitMaxChars(cue.text)
  );
}

function sentenceUnitSplitIndex(text: string, target: number, maxChars: number): number {
  const clauses: number[] = [];
  for (const match of text.matchAll(/[,;，、；：]/gu)) {
    const index = (match.index ?? -1) + match[0].length;
    if (index > 0 && index < text.length) clauses.push(index);
  }
  const capped = clauses.filter((index) => index <= maxChars);
  if (text.length > maxChars && capped.length > 0) return capped.at(-1) ?? -1;
  if (clauses.length > 0) {
    return clauses.reduce((best, index) =>
      Math.abs(index - target) < Math.abs(best - target) ? index : best,
    );
  }

  const spaces: number[] = [];
  for (const match of text.matchAll(/\s+/gu)) {
    const index = match.index ?? -1;
    if (index > 0 && index < text.length) spaces.push(index);
  }
  if (spaces.length > 0) {
    const cappedSpaces = spaces.filter((index) => index <= maxChars);
    if (text.length > maxChars && cappedSpaces.length > 0) return cappedSpaces.at(-1) ?? -1;
    return spaces.reduce((best, index) =>
      Math.abs(index - target) < Math.abs(best - target) ? index : best,
    );
  }
  return isMostlyCjk(text) ? Math.min(target, text.length - 1) : -1;
}

/** Split oversized cues at a clause where possible, with proportional intermediate timings. */
function splitOversizedSentenceUnit(cue: CaptionCue): CaptionCue[] {
  if (!sentenceUnitExceedsLimits(cue)) return [cue];
  const maxChars = sentenceUnitMaxChars(cue.text);
  if (cue.text.length <= maxChars && cue.endMs - cue.startMs > SENTENCE_UNIT_MAX_MS) {
    return [{ ...cue, endMs: Math.min(cue.endMs, cue.startMs + SENTENCE_UNIT_MAX_MS) }];
  }
  const target =
    cue.text.length > maxChars ? maxChars : Math.max(1, Math.ceil(cue.text.length / 2));
  const index = sentenceUnitSplitIndex(cue.text, target, maxChars);
  if (index <= 0 || index >= cue.text.length) return [cue];

  const leftText = cue.text.slice(0, index).trim();
  const rightText = cue.text.slice(index).trim();
  if (leftText.length === 0 || rightText.length === 0) return [cue];
  const ratio = index / cue.text.length;
  let middleMs = Math.round(cue.startMs + (cue.endMs - cue.startMs) * ratio);
  if (middleMs <= cue.startMs || middleMs >= cue.endMs) {
    middleMs = Math.round((cue.startMs + cue.endMs) / 2);
  }
  if (middleMs <= cue.startMs || middleMs >= cue.endMs) return [cue];

  const left = makeMergedCue(cue.startMs, middleMs, leftText, cue.language);
  const right = makeMergedCue(middleMs, cue.endMs, rightText, cue.language);
  return [...splitOversizedSentenceUnit(left), ...splitOversizedSentenceUnit(right)];
}

function isShortSentenceUnit(cue: CaptionCue): boolean {
  if (hasSentenceTerminator(cue.text)) return false;
  if (isMostlyCjk(cue.text)) return cue.text.length <= 6;
  const words = cue.text.split(/\s+/u).filter(Boolean);
  return cue.text.length <= 14 || (words.length <= 2 && cue.text.length <= 24);
}

/** Avoid one-word translation requests when a pause or a hard limit made a tiny unfinished unit. */
function mergeShortSentenceUnits(units: readonly CaptionCue[]): CaptionCue[] {
  const merged: CaptionCue[] = [];
  for (let index = 0; index < units.length; index += 1) {
    let current = units[index];
    if (!current) continue;

    while (isShortSentenceUnit(current)) {
      const next = units[index + 1];
      if (!next) break;
      const joined = joinSentenceUnitCues(current, next);
      if (sentenceUnitExceedsLimits(joined)) break;
      current = joined;
      index += 1;
    }

    const previous = merged.at(-1);
    if (previous && isShortSentenceUnit(current) && !hasSentenceTerminator(previous.text)) {
      const joined = joinSentenceUnitCues(previous, current);
      if (!sentenceUnitExceedsLimits(joined)) {
        merged[merged.length - 1] = joined;
        continue;
      }
    }
    merged.push(current);
  }
  return merged;
}

/**
 * Build translation/display units from a timedtext track. When the original json3 value is
 * supplied it is preferred over the parsed fallback cues. Rolling ASR windows are deduped first;
 * manual fragments use the same punctuation, pause, duration, and clause grouping afterwards.
 */
export function buildSentenceUnitsFromTrack(
  cues: readonly CaptionCue[],
  json3?: unknown,
): CaptionCue[] {
  const language = cues.find((cue) => cue.language)?.language;
  const parsed = json3 === undefined ? [] : parseTimedtextJson3(json3, language);
  const fragments = dedupeRollingCaptionCues(parsed.length > 0 ? parsed : cues);
  const units: CaptionCue[] = [];
  let current: CaptionCue | null = null;

  const commit = (): void => {
    if (!current) return;
    units.push(...splitOversizedSentenceUnit(current));
    current = null;
  };

  for (const cue of fragments) {
    for (const piece of splitCueSentences(cue.text)) {
      const next = makeMergedCue(cue.startMs, cue.endMs, piece, cue.language);
      if (!current) {
        current = next;
      } else {
        const gap = next.startMs - current.endMs;
        const joined = joinSentenceUnitCues(current, next);
        if (gap >= SENTENCE_UNIT_PAUSE_MS || sentenceUnitExceedsLimits(joined)) {
          commit();
          current = next;
        } else {
          current = joined;
        }
      }
      if (hasSentenceTerminator(current.text)) commit();
    }
  }
  commit();
  return mergeShortSentenceUnits(units);
}

export function captionTimeOffsetMs(
  cues: readonly CaptionCue[],
  durationMs?: number,
  mapOffsetMs = 0,
): number {
  if (mapOffsetMs > 0) {
    const first = cues[0]?.startMs ?? 0;
    if (first + 1_000 >= mapOffsetMs) return mapOffsetMs;
  }
  const first = cues[0]?.startMs;
  if (first === undefined) return 0;
  if (durationMs !== undefined && durationMs > 0 && first >= durationMs) {
    if (first >= WEBVTT_HOUR_OFFSET_MS && first - WEBVTT_HOUR_OFFSET_MS < durationMs + 1_000) {
      return WEBVTT_HOUR_OFFSET_MS;
    }
    return first;
  }
  if (first >= WEBVTT_HOUR_OFFSET_MS && first < WEBVTT_HOUR_OFFSET_MS + 120_000) {
    return WEBVTT_HOUR_OFFSET_MS;
  }
  return 0;
}

export function shiftCaptionCues(cues: readonly CaptionCue[], offsetMs: number): CaptionCue[] {
  if (offsetMs === 0) return [...cues];
  const shifted: CaptionCue[] = [];
  for (const cue of cues) {
    const startMs = Math.max(0, cue.startMs - offsetMs);
    const endMs = cue.endMs - offsetMs;
    if (endMs <= startMs) continue;
    shifted.push(makeMergedCue(startMs, endMs, cue.text, cue.language));
  }
  return shifted;
}

/** Shift HLS/X cues that start at 1h (or beyond the media duration) onto the playhead. */
export function alignCaptionCuesToMedia(
  cues: readonly CaptionCue[],
  durationMs?: number,
  mapOffsetMs = 0,
): CaptionCue[] {
  return shiftCaptionCues(cues, captionTimeOffsetMs(cues, durationMs, mapOffsetMs));
}

export function finalizeCaptionCues(
  cues: readonly CaptionCue[],
  durationMs?: number,
  options?: { asr?: boolean },
): CaptionCue[] {
  const collapsed = options?.asr === true ? collapseGrowingCaptionCues(cues) : cues;
  const words = mergeWordCues(collapsed);
  const prepared =
    options?.asr === true ? mergeSentenceCues(words, ASR_PHRASE_MERGE_LIMITS) : words;
  const aligned = alignCaptionCuesToMedia(prepared, durationMs);
  return options?.asr === true ? closeCaptionGaps(aligned, ASR_CUE_GAP_FILL_MS) : aligned;
}

/** Current cue at `timeMs`, then the next cues in timeline order. */
export function cuesFromPlayhead(
  cues: readonly CaptionCue[],
  timeMs: number,
  limit: number,
): CaptionCue[] {
  if (limit <= 0 || cues.length === 0) return [];
  let index = cues.findIndex((cue) => timeMs >= cue.startMs && timeMs < cue.endMs);
  if (index < 0) index = cues.findIndex((cue) => cue.startMs >= timeMs);
  if (index < 0) return [];
  return cues.slice(index, index + limit);
}

export function cueAtTime(cues: readonly CaptionCue[], timeMs: number): CaptionCue | null {
  for (const cue of cues) {
    if (timeMs >= cue.startMs && timeMs < cue.endMs) return cue;
  }
  return null;
}

export function cuesInWindow(
  cues: readonly CaptionCue[],
  startMs: number,
  endMs: number,
): CaptionCue[] {
  return cues.filter((cue) => cue.endMs > startMs && cue.startMs < endMs);
}

/**
 * Growing auto-captions replace the same on-screen line as words arrive. A finished
 * line is emitted when the visible text jumps to a new phrase, hits a sentence end,
 * grows past {@link LIVE_CAPTION_MAX_CHARS}, or sits still for {@link LIVE_CAPTION_MAX_WAIT_MS}.
 */
export class LiveCaptionBuffer {
  private current = '';
  private lastChangeAt = 0;
  private line = '';
  private lineVersion = 0;

  update(visible: string, now: number): string[] {
    const next = normalizeCaptionText(visible);
    this.trackLine(next);
    if (next.length === 0) {
      const previous = this.take();
      return previous ? [previous] : [];
    }
    if (next === this.current) {
      const stale = this.flushIfStale(now);
      return stale ? [stale] : [];
    }
    if (this.current.length > 0 && next.startsWith(this.current)) {
      this.current = next;
      this.lastChangeAt = now;
      if (hasSentenceTerminator(this.current) || this.current.length >= LIVE_CAPTION_MAX_CHARS) {
        const ready = this.take();
        return ready ? [ready] : [];
      }
      return [];
    }
    const flushed: string[] = [];
    const previous = this.current.trim();
    if (previous.length > 0) flushed.push(previous);
    this.current = next;
    this.lastChangeAt = now;
    if (hasSentenceTerminator(this.current) || this.current.length >= LIVE_CAPTION_MAX_CHARS) {
      const ready = this.take();
      if (ready) flushed.push(ready);
    }
    return flushed;
  }

  flushIfStale(now: number): string | null {
    if (this.current.length === 0) return null;
    if (now - this.lastChangeAt < LIVE_CAPTION_MAX_WAIT_MS) return null;
    return this.take();
  }

  peek(): string {
    return this.current;
  }

  /** Stable id for the on-screen line while its text grows or is replaced. */
  lineKey(): string {
    return `l${String(this.lineVersion)}`;
  }

  reset(): void {
    if (this.line.length > 0) this.lineVersion += 1;
    this.current = '';
    this.lastChangeAt = 0;
    this.line = '';
  }

  /**
   * Keep one id while the player extends (or trims) the same visible line, and
   * bump it when the text jumps to a different phrase so stale work can be dropped.
   */
  private trackLine(next: string): void {
    if (next.length === 0) return;
    if (this.line.length === 0) {
      this.line = next;
      return;
    }
    if (next.startsWith(this.line) || this.line.startsWith(next)) {
      this.line = next;
      return;
    }
    this.line = next;
    this.lineVersion += 1;
  }

  private take(): string | null {
    const text = this.current.trim();
    this.current = '';
    this.lastChangeAt = 0;
    return text.length > 0 ? text : null;
  }
}
