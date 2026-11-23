import type { OcrResult } from '@/engine/ocr/types';
import type { TranslateOptions, TranslateSegment, TranslationChunk } from '@/engine/types';

const PLACEHOLDER = /(<\/?i\d+>)/;
/**
 * E2E-only knobs. The page can ask the fake engine to echo marker-like tokens that were
 * left in the source (a defect the ASR harness must catch) and can count pure sound-tag
 * segments that were sent to the model at all. Neither knob exists in release builds.
 */
const ECHO_ATTRIBUTE = 'data-bench-echo-markers';
const SOUND_TAG_COUNT_ATTRIBUTE = 'data-bench-sound-tag-translations';
const DEFAULT_ECHO = ['S1', 'ED', 'E', 'T', 'NC', 'RS'];
const SOUND_TAG_ONLY =
  /^(?:\[[^\]]{1,32}\]|\([^)]{1,32}\)|[♪♫♩]+|#[^#]{1,24}#)(?:\s*(?:\[[^\]]{1,32}\]|\([^)]{1,32}\)|[♪♫♩]+|#[^#]{1,24}#))*\s*$/u;

/** Keeps the source words so a fixture can see that the sentence itself was not rewritten. */
export function fakeMarker(targetLanguage: string): string {
  return `§${targetLanguage}§`;
}

function readEchoMarkers(): readonly string[] {
  const raw = globalThis.document?.documentElement?.getAttribute(ECHO_ATTRIBUTE) ?? null;
  if (raw === null || raw.length === 0) return [];
  if (raw === '1') return DEFAULT_ECHO;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (entry): entry is string => typeof entry === 'string' && /^[A-Za-z0-9]{1,4}$/u.test(entry),
      );
    }
  } catch {
    // Ignore malformed bench configuration.
  }
  return [];
}

function countSoundTag(text: string): void {
  if (!SOUND_TAG_ONLY.test(text.trim())) return;
  const root = globalThis.document?.documentElement;
  if (!root) return;
  const next = Number(root.getAttribute(SOUND_TAG_COUNT_ATTRIBUTE) ?? '0') + 1;
  root.setAttribute(SOUND_TAG_COUNT_ATTRIBUTE, String(next));
}

export function fakeTranslateText(
  text: string,
  targetLanguage: string,
  echoMarkers: readonly string[] = [],
  withMarker = true,
): string {
  const marker = withMarker ? fakeMarker(targetLanguage) : '';
  return text
    .split(PLACEHOLDER)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      if (part.length === 0) return '';
      const echoed = echoMarkers.filter((token) => new RegExp(`\\b${token}\\b`, 'u').test(part));
      return `${marker}${part}${echoed.length > 0 ? ` ${echoed.join(' ')}` : ''}`;
    })
    .join('');
}

/**
 * A synthetic decode cost. The page bench sets this so the fake engine takes a
 * deterministic, text-length-dependent amount of time instead of returning instantly.
 * Without it the scheduler's batching, packing and priority decisions all collapse into
 * a single tick, and no page-side speed change can be measured.
 */
export interface FakePace {
  /** Delay before the first delta, standing in for prefill. */
  ttfbMs: number;
  /** Milliseconds per output character, standing in for decode. */
  msPerChar: number;
  /** How many streaming deltas each segment is split into before the final text. */
  deltas: number;
  /** One-off cost of the first translation on a page (model load / warmup). */
  warmupMs?: number | undefined;
  /** Maximum simultaneous translation calls; 1 models a serial engine queue. */
  concurrent?: number | undefined;
  /** Prefix only the first call with the marker (for cumulative incremental lines). */
  markerFirstOnly?: boolean | undefined;
}

const PACE_ATTRIBUTE = 'data-bench-pace';
const FLAT_EN_ATTRIBUTE = 'data-bench-flat-en';
/** One paragraph, with no spaces after the exclamation marks, as reported for X (#161). */
const FLAT_EN_THREE_LINES =
  'Welcome to Osaka!This is the second sentence.Come see me!Hope you visit.';
const FLAT_EN_TWO_LINES = 'Welcome to Osaka!This is the second line.';
/** The same flat paragraph, sharded across the per-line requests of a pre-wrap post. */
const FLAT_EN_PREWRAP_LINES =
  'Welcome to Osaka!This is the second sentence.Come see me!Hope you visit.' +
  'The fifth line continues this single paragraph.The sixth line has no newline.' +
  'The seventh line stays glued to the next.The eighth line ends the flat paragraph.';

/**
 * An X fixture can ask for the model's flattened-English failure shape. Only multi-line
 * segments are flattened: a single-line lazy reply still gets the marked fake output so a
 * test can tell which reply was translated.
 */
function flatEnglish(text: string, target: string): string | null {
  if (!/^en(?:-|$)/iu.test(target)) return null;
  const enabled = globalThis.document?.documentElement?.getAttribute(FLAT_EN_ATTRIBUTE);
  if (enabled !== '1' || !text.includes('\n')) return null;
  return text.includes('\n\n') ? FLAT_EN_THREE_LINES : FLAT_EN_TWO_LINES;
}

/**
 * A line-by-line X body sends one request per non-empty source line, so no single request
 * contains the newlines `flatEnglish` looks for. Use the same flat paragraph in that shape
 * too: one sentence per request, with no newline in any answer.
 */
function flatEnglishPieces(segments: readonly TranslateSegment[], target: string): string[] | null {
  if (!/^en(?:-|$)/iu.test(target)) return null;
  const enabled = globalThis.document?.documentElement?.getAttribute(FLAT_EN_ATTRIBUTE);
  if (enabled !== '1' || segments.length <= 1) return null;
  if (segments.some((segment) => segment.text.includes('\n') || !segment.id.includes('#'))) {
    return null;
  }
  const short = FLAT_EN_THREE_LINES.split(/(?<=[.!?])(?=[A-Z])/u);
  const sentences =
    segments.length <= short.length ? short : FLAT_EN_PREWRAP_LINES.split(/(?<=[.!?])(?=[A-Z])/u);
  const parts: string[] = Array.from({ length: segments.length }, () => '');
  let cursor = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const end = Math.round(((index + 1) * sentences.length) / parts.length);
    parts[index] = sentences.slice(cursor, end).join('');
    cursor = end;
  }
  return parts;
}

let warmedUp = false;
let markerUsed = false;
let queueTail: Promise<void> = Promise.resolve();

/**
 * The pace is read from the page itself so the bench can set it before translation
 * starts, without a test-only bridge between the page and the content script's world.
 * Only this fake engine reads it, and the fake engine is not in the release build.
 */
function readPace(): FakePace | null {
  const raw = globalThis.document?.documentElement?.getAttribute(PACE_ATTRIBUTE) ?? null;
  if (raw === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const ttfbMs = record.ttfbMs;
  const msPerChar = record.msPerChar;
  const deltas = record.deltas;
  if (typeof ttfbMs !== 'number' || typeof msPerChar !== 'number') return null;
  const warmupMs = record.warmupMs;
  const concurrent = record.concurrent;
  return {
    ttfbMs: Math.max(0, ttfbMs),
    msPerChar: Math.max(0, msPerChar),
    deltas: typeof deltas === 'number' ? Math.max(0, Math.min(8, Math.floor(deltas))) : 0,
    ...(typeof warmupMs === 'number' ? { warmupMs: Math.max(0, warmupMs) } : {}),
    ...(typeof concurrent === 'number' ? { concurrent: Math.max(1, Math.floor(concurrent)) } : {}),
    ...(record.markerFirstOnly === true ? { markerFirstOnly: true } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function* fakeTranslate(
  segments: readonly TranslateSegment[],
  options: TranslateOptions,
): AsyncGenerator<TranslationChunk> {
  const pace = readPace();
  const echoMarkers = readEchoMarkers();
  const flatPieces = flatEnglishPieces(segments, options.tgt);
  // A serial queue models an on-device engine that decodes one request at a time.
  // Only feel-test scenarios set concurrent=1; the legacy harness stays parallel.
  const release = await claim(pace?.concurrent ?? 0, options.signal);
  try {
    if (pace?.warmupMs && !warmedUp) {
      warmedUp = true;
      await sleep(pace.warmupMs);
    }
    for (const [index, segment] of segments.entries()) {
      if (options.signal.aborted) return;
      countSoundTag(segment.text);
      const withMarker = !(pace?.markerFirstOnly === true && markerUsed);
      if (withMarker) markerUsed = true;
      const text =
        flatPieces?.[index] ??
        flatEnglish(segment.text, options.tgt) ??
        fakeTranslateText(segment.text, options.tgt, echoMarkers, withMarker);
      if (!pace) {
        yield { id: segment.id, final: text, engine: 'plamo' };
        continue;
      }

      await sleep(pace.ttfbMs);
      if (options.signal.aborted) return;
      if (pace.deltas > 0 && text.length > 1) {
        const cut = Math.max(1, Math.floor(text.length / (pace.deltas + 1)));
        let offset = 0;
        while (offset + cut < text.length) {
          await sleep(cut * pace.msPerChar);
          if (options.signal.aborted) return;
          yield { id: segment.id, textDelta: text.slice(offset, offset + cut), engine: 'plamo' };
          offset += cut;
        }
        await sleep((text.length - offset) * pace.msPerChar);
        if (options.signal.aborted) return;
        yield { id: segment.id, final: text, engine: 'plamo' };
        continue;
      }

      await sleep(text.length * pace.msPerChar);
      if (options.signal.aborted) return;
      yield { id: segment.id, final: text, engine: 'plamo' };
    }
  } finally {
    release();
  }
}

/** Claim the single engine slot when the scenario asks for a serial queue. */
async function claim(limit: number, signal: AbortSignal): Promise<() => void> {
  if (limit <= 0) return () => undefined;
  const previous = queueTail;
  let release = (): void => undefined;
  queueTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    release();
  };
  // An aborted caller may stop iterating this generator entirely, so its finally
  // block never runs. Release the slot on abort too, or the queue deadlocks.
  signal.addEventListener('abort', releaseOnce, { once: true });
  await previous;
  return () => {
    signal.removeEventListener('abort', releaseOnce);
    releaseOnce();
  };
}

/**
 * Deterministic OCR for fake-engine UI tests: the image popup placement, copy and resize
 * paths do not need a 23 MB model download or a real recognition pass.
 */
export async function fakeOcrRecognize(): Promise<OcrResult> {
  const text = 'LOCAL TRANSLATION NOTES';
  const quad = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 12 },
    { x: 0, y: 12 },
  ] as const;
  const region = {
    text,
    quad,
    confidence: 1,
    recognitionConfidence: 1,
    vertical: false,
    symbolScores: [],
  };
  return {
    text,
    regions: [region],
    lines: [{ orientation: 'horizontal', items: [region], indices: [0] }],
  };
}
