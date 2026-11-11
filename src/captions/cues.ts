import { hasSentenceTerminator, splitForTranslation } from '@/engine/text/sentences';

export interface CaptionCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  language?: string | undefined;
}

export const LIVE_CAPTION_MAX_WAIT_MS = 900;
export const LIVE_CAPTION_MAX_CHARS = 72;
export const LIVE_CAPTION_MIN_DISPLAY_MS = 1_400;
export const WORD_CUE_MERGE_GAP_MS = 800;
export const WORD_CUE_MERGE_MAX_MS = 3_500;
export const WORD_CUE_MERGE_MAX_CHARS = 96;
export const SENTENCE_CUE_MERGE_GAP_MS = 1_500;
export const SENTENCE_CUE_MERGE_MAX_MS = 12_000;
export const SENTENCE_CUE_MERGE_MAX_CHARS = 280;
export const WEBVTT_HOUR_OFFSET_MS = 3_600_000;

const VTT_TIMESTAMP =
  /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})/;

export function normalizeCaptionText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
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
    const joined = normalizeCaptionText(`${current.text} ${cue.text}`);
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
  if (/\s/u.test(trimmed)) return false;
  return cue.endMs - cue.startMs <= WORD_CUE_MERGE_GAP_MS;
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

/**
 * Join consecutive VOD cues into full sentences so the model is not asked to
 * translate mid-phrase fragments. Display uses the combined time span.
 */
export function mergeSentenceCues(cues: readonly CaptionCue[]): CaptionCue[] {
  if (cues.length === 0) return [];
  const merged: CaptionCue[] = [];
  let startMs = 0;
  let endMs = 0;
  let language: string | undefined;
  let parts: string[] = [];

  const currentText = (): string => normalizeCaptionText(parts.join(' '));

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
        const joined = normalizeCaptionText(`${currentText()} ${piece}`);
        const canMerge =
          gap <= SENTENCE_CUE_MERGE_GAP_MS &&
          duration <= SENTENCE_CUE_MERGE_MAX_MS &&
          joined.length <= SENTENCE_CUE_MERGE_MAX_CHARS &&
          !hasSentenceTerminator(currentText());
        if (!canMerge) {
          commit();
          startGroup(cue, piece);
        } else {
          endMs = Math.max(endMs, cue.endMs);
          parts.push(piece);
        }
      }
      if (
        hasSentenceTerminator(currentText()) ||
        currentText().length >= SENTENCE_CUE_MERGE_MAX_CHARS
      ) {
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
): CaptionCue[] {
  return alignCaptionCuesToMedia(mergeSentenceCues(mergeWordCues(cues)), durationMs);
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

  update(visible: string, now: number): string[] {
    const next = normalizeCaptionText(visible);
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

  reset(): void {
    this.current = '';
    this.lastChangeAt = 0;
  }

  private take(): string | null {
    const text = this.current.trim();
    this.current = '';
    this.lastChangeAt = 0;
    return text.length > 0 ? text : null;
  }
}
