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
  // A serial queue models an on-device engine that decodes one request at a time.
  // Only feel-test scenarios set concurrent=1; the legacy harness stays parallel.
  const release = await claim(pace?.concurrent ?? 0, options.signal);
  try {
    if (pace?.warmupMs && !warmedUp) {
      warmedUp = true;
      await sleep(pace.warmupMs);
    }
    for (const segment of segments) {
      if (options.signal.aborted) return;
      countSoundTag(segment.text);
      const withMarker = !(pace?.markerFirstOnly === true && markerUsed);
      if (withMarker) markerUsed = true;
      const text = fakeTranslateText(segment.text, options.tgt, echoMarkers, withMarker);
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
