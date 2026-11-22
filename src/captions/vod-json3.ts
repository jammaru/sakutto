import { hasSentenceTerminator } from '@/engine/text/sentences';
import { captionCueId, joinCaptionFragments, normalizeCaptionText, type CaptionCue } from './cues';

export const VOD_WORD_PAUSE_MS = 700;
export const VOD_CUE_MAX_MS = 7_000;
export const VOD_CUE_MAX_CHARS = 84;
export const VOD_CJK_CUE_MAX_CHARS = 42;

export interface VodWord {
  text: string;
  startMs: number;
  endMs: number;
  eventIndex: number;
  segmentIndex: number;
  timing: 'offset' | 'event';
}

export interface VodCaptionCue extends CaptionCue {
  sourceWordStart: number;
  sourceWordEnd: number;
  numericLexemes: string[];
}

export interface VodSourceCoverage {
  acceptedTokens: number;
  repeatedTokens: number;
  emittedTokens: number;
  offsetTokens: number;
  estimatedTokens: number;
  complete: boolean;
}

export interface VodTimeline {
  words: VodWord[];
  cues: VodCaptionCue[];
  language?: string | undefined;
  asr: boolean;
  sourceCoverage: VodSourceCoverage;
}

interface RawSegment {
  text: string;
  offsetMs: number | null;
  segmentIndex: number;
}

/** Numeric spellings are compared before a caption translation may be cached. */
export function numericLexemes(text: string): string[] {
  return text.match(/\d+(?:,\d{3})*(?:\.\d+)*/gu) ?? [];
}

export function numericLexemesEqual(source: string, translated: string): boolean {
  const left = numericLexemes(source);
  const right = numericLexemes(translated);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Reuse the translator's atomic inline-placeholder convention for exact numerics. */
export function protectCaptionNumerics(source: string): string {
  let index = 0;
  return source.replace(/\d+(?:,\d{3})*(?:\.\d+)*/gu, () => '<i' + String(index++) + '>');
}

/** Restore every placeholder once, in order, or reject the hostile engine output. */
export function restoreCaptionNumerics(output: string, source: string): string | null {
  const numbers = numericLexemes(source);
  if (numbers.length === 0) return output;
  const markers = [...output.matchAll(/<i(\d+)>/gu)];
  if (
    markers.length !== numbers.length ||
    markers.some((marker, index) => marker[1] !== String(index))
  ) {
    return null;
  }
  let restored = output;
  for (let index = 0; index < numbers.length; index += 1) {
    restored = restored.replace('<i' + String(index) + '>', numbers[index] ?? '');
  }
  return numericLexemesEqual(source, restored) ? restored : null;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function rawSegments(value: unknown): RawSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: RawSegment[] = [];
  for (let segmentIndex = 0; segmentIndex < value.length; segmentIndex += 1) {
    const segment = value[segmentIndex];
    if (typeof segment !== 'object' || segment === null) continue;
    const record = segment as { utf8?: unknown; tOffsetMs?: unknown };
    if (typeof record.utf8 !== 'string') continue;
    const text = normalizeCaptionText(record.utf8);
    if (text.length === 0) continue;
    segments.push({
      text,
      offsetMs: finiteNonNegative(record.tOffsetMs) ? record.tOffsetMs : null,
      segmentIndex,
    });
  }
  return segments;
}

function timedWordEnd(startMs: number, eventEndMs: number, starts: readonly number[]): number {
  const next = starts.find((candidate) => candidate > startMs);
  return next ?? eventEndMs;
}

/**
 * Reconstruct one immutable word timeline from raw fmt=json3 events. Repeated rolling
 * instances are identified by their absolute source time and text, rather than by a
 * suffix of the previously visible string. Events without usable offsets are retained
 * with explicitly estimated event-level timing for compatibility.
 */
export function parseVodJson3Timeline(
  value: unknown,
  language?: string,
  asr = true,
): VodTimeline | null {
  if (typeof value !== 'object' || value === null) return null;
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events)) return null;

  const words: VodWord[] = [];
  let acceptedTokens = 0;
  let offsetTokens = 0;
  let estimatedTokens = 0;
  let sawOffset = false;

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (typeof event !== 'object' || event === null) continue;
    const record = event as { tStartMs?: unknown; dDurationMs?: unknown; segs?: unknown };
    if (!finiteNonNegative(record.tStartMs) || !finiteNonNegative(record.dDurationMs)) continue;
    const eventStartMs = record.tStartMs;
    const eventEndMs = eventStartMs + record.dDurationMs;
    if (!Number.isFinite(eventEndMs) || eventEndMs <= eventStartMs) continue;
    const segments = rawSegments(record.segs);
    if (segments.length === 0) continue;

    const starts = segments.map((segment) =>
      segment.offsetMs === null ? eventStartMs : eventStartMs + segment.offsetMs,
    );
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) continue;
      const startMs = starts[index] ?? eventStartMs;
      const timing = segment.offsetMs === null ? 'event' : 'offset';
      if (startMs < eventStartMs || startMs >= eventEndMs) continue;
      const endMs = timing === 'offset' ? timedWordEnd(startMs, eventEndMs, starts) : eventEndMs;
      if (!Number.isFinite(endMs) || endMs <= startMs) continue;
      acceptedTokens += 1;
      if (timing === 'offset') {
        sawOffset = true;
        offsetTokens += 1;
      } else {
        estimatedTokens += 1;
      }
      words.push({
        text: segment.text,
        startMs,
        endMs,
        eventIndex,
        segmentIndex: segment.segmentIndex,
        timing,
      });
    }
  }

  // An offset-less document must use the legacy rolling-string parser instead. Its
  // timings are not word accurate and should not be represented as such.
  if (!sawOffset || words.length === 0) return null;
  words.sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.eventIndex - right.eventIndex ||
      left.segmentIndex - right.segmentIndex,
  );

  const deduped: VodWord[] = [];
  const seen = new Map<string, number>();
  let repeatedTokens = 0;
  for (const word of words) {
    const key = JSON.stringify([word.startMs, word.text]);
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      repeatedTokens += 1;
      const existing = deduped[existingIndex];
      if (existing) existing.endMs = Math.max(existing.endMs, word.endMs);
      continue;
    }
    seen.set(key, deduped.length);
    deduped.push({ ...word });
  }

  const sourceCoverage: VodSourceCoverage = {
    acceptedTokens,
    repeatedTokens,
    emittedTokens: deduped.length,
    offsetTokens,
    estimatedTokens,
    complete: acceptedTokens - repeatedTokens === deduped.length,
  };
  const cues = buildVodCues(deduped, language);
  if (cues.length === 0) return null;
  return { words: deduped, cues, language, asr, sourceCoverage };
}

function isCjkRun(text: string): boolean {
  const chars = [...text.replace(/\s/gu, '')];
  const cjk = chars.filter((char) => /[\u3040-\u30ff\u3400-\u9fff]/u.test(char)).length;
  return cjk >= 2 && cjk * 2 >= chars.length;
}

/** Join source tokens without inserting spaces inside decimals or before punctuation. */
export function joinVodWords(left: string, right: string): string {
  const a = left.trimEnd();
  const b = right.trimStart();
  if (!a) return b;
  if (!b) return a;
  if (/^[,.!?;:%)\]}…、。，！？；：]/u.test(b)) return normalizeCaptionText(a + b);
  if (/\d+\.$/u.test(a) && /^\d/u.test(b)) return normalizeCaptionText(a + b);
  if (a.endsWith('(') || a.endsWith('[')) return normalizeCaptionText(a + b);
  return joinCaptionFragments(a, b);
}

function cueText(words: readonly VodWord[]): string {
  let text = '';
  for (const word of words) text = joinVodWords(text, word.text);
  return text;
}

function makeCue(
  words: readonly VodWord[],
  startIndex: number,
  language?: string,
): VodCaptionCue | null {
  const first = words[0];
  const last = words.at(-1);
  if (!first || !last) return null;
  const text = cueText(words);
  if (!text) return null;
  return {
    id: captionCueId(first.startMs, text) + ':' + String(last.endMs),
    startMs: first.startMs,
    endMs: last.endMs,
    text,
    ...(language ? { language } : {}),
    sourceWordStart: startIndex,
    sourceWordEnd: startIndex + words.length,
    numericLexemes: numericLexemes(text),
  };
}

function exceedsCueLimits(words: readonly VodWord[]): boolean {
  const first = words[0];
  const last = words.at(-1);
  if (!first || !last) return false;
  const text = cueText(words);
  return (
    last.endMs - first.startMs > VOD_CUE_MAX_MS ||
    text.length > (isCjkRun(text) ? VOD_CJK_CUE_MAX_CHARS : VOD_CUE_MAX_CHARS)
  );
}

/** Build display cues only at whole timed-token boundaries. */
export function buildVodCues(words: readonly VodWord[], language?: string): VodCaptionCue[] {
  const units: VodCaptionCue[] = [];
  let current: VodWord[] = [];
  let startIndex = 0;

  const commit = (): void => {
    const cue = makeCue(current, startIndex, language);
    if (cue) units.push(cue);
    current = [];
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!word) continue;
    const previous = current.at(-1);
    if (previous && word.startMs - previous.endMs >= VOD_WORD_PAUSE_MS) commit();
    if (current.length === 0) startIndex = index;
    const candidate = [...current, word];
    if (current.length > 0 && exceedsCueLimits(candidate)) {
      commit();
      startIndex = index;
    }
    current.push(word);
    const next = words[index + 1];
    const followedByCloser = next !== undefined && /^["'”’)\]}]+$/u.test(next.text);
    if (hasSentenceTerminator(cueText(current)) && !followedByCloser) commit();
  }
  commit();

  // Extremely short finished sentences are grouped at token boundaries when doing
  // so avoids an unreadable flash. No source timing or text is discarded.
  const grouped: VodCaptionCue[] = [];
  for (const cue of units) {
    const previous = grouped.at(-1);
    if (!previous) {
      grouped.push(cue);
      continue;
    }
    const previousWords = words.slice(previous.sourceWordStart, previous.sourceWordEnd);
    const cueWords = words.slice(cue.sourceWordStart, cue.sourceWordEnd);
    const combined = [...previousWords, ...cueWords];
    const short = previous.text.length <= 14 || previous.text.trim().split(/\s+/u).length <= 2;
    if (
      short &&
      cue.startMs - previous.endMs < 500 &&
      cue.startMs - previous.startMs < 1_200 &&
      !exceedsCueLimits(combined)
    ) {
      const merged = makeCue(combined, previous.sourceWordStart, language);
      if (merged) grouped[grouped.length - 1] = merged;
    } else {
      grouped.push(cue);
    }
  }
  return grouped;
}
