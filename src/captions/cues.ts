import { hasSentenceTerminator, splitForTranslation } from '@/engine/text/sentences';
import { sanitizeTranslationInput } from '@/engine/text/sanitize';

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
/** Refinements of the same on-screen line may replace it much sooner than a new line. */
export const LIVE_CAPTION_REFINE_MIN_DISPLAY_MS = 200;
/** Coalesce a burst of DOM word updates before asking the engine about a live line. */
export const LIVE_CAPTION_DEBOUNCE_MS = 80;
/** A visible ASR segment is closed after this much silence or at these limits. */
export const LIVE_SEGMENT_GAP_MS = 650;
export const LIVE_SEGMENT_MAX_MS = 4_000;
export const CJK_LIVE_SEGMENT_MAX_MS = 2_800;
export const LIVE_SEGMENT_MAX_CHARS = 90;
export const CJK_LIVE_SEGMENT_MAX_CHARS = 40;
export const LIVE_SEGMENT_WEAK_BREAK_MIN_CHARS = 12;
/** Live tail translation: first hint quickly, then only stable / rate-limited refreshes. */
export const LIVE_TAIL_FIRST_DEBOUNCE_MS = 120;
export const LIVE_TAIL_STABLE_MS = 500;
export const LIVE_TAIL_REFRESH_MS = 1_600;
/** Previous committed translation lines kept above the live line. */
export const LIVE_ROLLUP_HISTORY_LINES = 1;
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
  return sanitizeTranslationInput(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\s*\n\s*/gu, '\n')
    .trim();
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
  const space = isCjkChar(leftChar) && isCjkChar(rightChar) ? '' : ' ';
  return normalizeCaptionText(`${a}${space}${b}`);
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

export interface LiveCaptionSegment {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface LiveCaptionStreamUpdate {
  /** Segments closed by this observation. Their translations must be frozen. */
  committed: LiveCaptionSegment[];
  /** Uncommitted visible suffix that may still change. */
  tail: string;
  tailChanged: boolean;
  lineChanged: boolean;
  lineKey: string;
}

/**
 * Turns the player's growing caption window into short committed segments plus a
 * mutable tail. A segment is closed at sentence / clause punctuation, a short ASR
 * silence, the line being replaced, or a duration/character cap. Once returned in
 * `committed`, that source text never changes again.
 */
export class LiveCaptionStream {
  private visible = '';
  private committedChars = 0;
  private line = '';
  private lineVersion = 0;
  private tailStartedAt = 0;
  private tailChangedAt = 0;
  private serial = 0;

  update(visible: string, now: number): LiveCaptionStreamUpdate {
    const next = normalizeCaptionText(visible);
    const previous = this.visible;
    const beforeTail = this.tail();
    const committed: LiveCaptionSegment[] = [];
    let lineChanged = false;

    if (next.length === 0) {
      // Keep the last visible line until either the gap closes it or a new line
      // replaces it; a transient empty DOM node must not discard spoken text.
      if (this.tail().length > 0 && now - this.tailChangedAt >= LIVE_SEGMENT_GAP_MS) {
        this.commitRemaining(now, committed);
      }
    } else if (previous.length === 0) {
      if (this.line.length > 0 && sameVisibleLine(this.line, next)) {
        this.visible = next;
        this.tailChangedAt = now;
      } else {
        if (this.line.length > 0) {
          this.commitRemaining(now, committed);
          lineChanged = true;
        }
        this.startLine(next, now);
      }
    } else if (sameVisibleLine(previous, next)) {
      this.visible = next;
      if (next.length > previous.length) this.tailChangedAt = now;
      if (this.committedChars > next.length) this.committedChars = next.length;
    } else {
      this.commitRemaining(now, committed);
      lineChanged = true;
      this.startLine(next, now);
    }

    this.extractSegments(now, committed);
    if (this.tail().length > 0 && now - this.tailChangedAt >= LIVE_SEGMENT_GAP_MS) {
      this.commitRemaining(now, committed);
    }

    return {
      committed,
      tail: this.tail(),
      tailChanged: this.tail() !== beforeTail,
      lineChanged,
      lineKey: this.lineKey(),
    };
  }

  tail(): string {
    return normalizeCaptionText(this.visible.slice(this.committedChars));
  }

  /**
   * Drop the mutable tail without closing it as a segment. Used when the player
   * removes the caption: late tail work must not paint, but the next line should
   * still continue from the last committed text instead of duplicating it.
   */
  discardTail(now: number): void {
    this.committedChars = this.visible.length;
    this.tailStartedAt = now;
    this.tailChangedAt = now;
  }

  lineKey(): string {
    return `l${String(this.lineVersion)}`;
  }

  reset(): void {
    if (this.line.length > 0) this.lineVersion += 1;
    this.visible = '';
    this.committedChars = 0;
    this.line = '';
    this.tailStartedAt = 0;
    this.tailChangedAt = 0;
  }

  private startLine(next: string, now: number): void {
    this.line = next;
    this.lineVersion += 1;
    this.visible = next;
    this.committedChars = 0;
    this.tailStartedAt = now;
    this.tailChangedAt = now;
  }

  private extractSegments(now: number, committed: LiveCaptionSegment[]): void {
    while (true) {
      const raw = this.visible.slice(this.committedChars);
      const cut = liveSegmentCut(raw, now - this.tailStartedAt);
      if (cut <= 0) return;
      const text = normalizeCaptionText(raw.slice(0, cut));
      let advance = cut;
      while (advance < raw.length && /\s/u.test(raw[advance] ?? '')) advance += 1;
      this.committedChars += advance;
      if (text.length > 0) committed.push(this.makeSegment(text, now));
      this.tailStartedAt = now;
    }
  }

  private commitRemaining(now: number, committed: LiveCaptionSegment[]): void {
    const text = this.tail();
    this.committedChars = this.visible.length;
    if (text.length > 0) committed.push(this.makeSegment(text, now));
    this.tailStartedAt = now;
    this.tailChangedAt = now;
  }

  private makeSegment(text: string, now: number): LiveCaptionSegment {
    this.serial += 1;
    return {
      id: `${captionCueId(Math.round(this.tailStartedAt), text)}:${String(this.serial)}`,
      text,
      startMs: Math.round(this.tailStartedAt),
      endMs: Math.round(now),
    };
  }
}

/**
 * Find the first safe end of a live segment. Strong punctuation ends a sentence,
 * weak punctuation ends a clause once the fragment is long enough, and a time or
 * character cap cuts at a word boundary.
 */
export function liveSegmentCut(raw: string, elapsedMs: number): number {
  const leading = raw.length - raw.trimStart().length;
  const text = raw.trimStart();
  if (text.length === 0) return -1;
  const cjk = isMostlyCjk(text);
  const maxChars = cjk ? CJK_LIVE_SEGMENT_MAX_CHARS : LIVE_SEGMENT_MAX_CHARS;
  const maxMs = cjk ? CJK_LIVE_SEGMENT_MAX_MS : LIVE_SEGMENT_MAX_MS;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (!/[.!?。！？…]/u.test(char)) continue;
    if (char === '.' && /\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? '')) {
      continue;
    }
    return leading + index + 1;
  }

  if (text.length >= LIVE_SEGMENT_WEAK_BREAK_MIN_CHARS) {
    const weak = /[,;:、，；：]/u.exec(text);
    if (weak?.index !== undefined) {
      let end = weak.index + 1;
      while (end < text.length && /[,;:、，；：]/u.test(text[end] ?? '')) end += 1;
      if (end >= LIVE_SEGMENT_WEAK_BREAK_MIN_CHARS) return leading + end;
    }
  }

  const overTime = elapsedMs >= maxMs;
  const overLength = text.length > maxChars;
  if (!overTime && !overLength) return -1;
  const limit = Math.min(text.length, maxChars);
  let cut = limit;
  for (let index = limit; index >= Math.floor(maxChars * 0.55); index -= 1) {
    if (/\s/u.test(text[index] ?? '')) {
      cut = index;
      break;
    }
  }
  if (overTime && !overLength) {
    const lastSpace = text.lastIndexOf(' ');
    if (lastSpace >= LIVE_SEGMENT_WEAK_BREAK_MIN_CHARS) cut = lastSpace;
    else if (text.length > maxChars) cut = limit;
    else cut = text.length;
  }
  while (cut > 0 && /\s/u.test(text[cut - 1] ?? '')) cut -= 1;
  return cut > 0 ? leading + cut : -1;
}

function sameVisibleLine(previous: string, next: string): boolean {
  return next.startsWith(previous) || previous.startsWith(next);
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
