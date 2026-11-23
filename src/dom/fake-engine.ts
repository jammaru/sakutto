import type { TranslateOptions, TranslateSegment, TranslationChunk } from '@/engine/types';

const PLACEHOLDER = /(<\/?i\d+>)/;

/** Keeps the source words so a fixture can see that the sentence itself was not rewritten. */
export function fakeMarker(targetLanguage: string): string {
  return `§${targetLanguage}§`;
}

export function fakeTranslateText(text: string, targetLanguage: string): string {
  const marker = fakeMarker(targetLanguage);
  return text
    .split(PLACEHOLDER)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      if (part.length === 0) return '';
      return `${marker}${part}`;
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
}

const PACE_ATTRIBUTE = 'data-bench-pace';
const FLAT_EN_ATTRIBUTE = 'data-bench-flat-en';
/** One paragraph, with no spaces after the exclamation marks, as reported for X (#161). */
const FLAT_EN_THREE_LINES =
  'Welcome to Osaka!This is the second sentence.Come see me!Hope you visit.';
const FLAT_EN_TWO_LINES = 'Welcome to Osaka!This is the second line.';

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
  return {
    ttfbMs: Math.max(0, ttfbMs),
    msPerChar: Math.max(0, msPerChar),
    deltas: typeof deltas === 'number' ? Math.max(0, Math.min(8, Math.floor(deltas))) : 0,
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
  for (const segment of segments) {
    if (options.signal.aborted) return;
    const text =
      flatEnglish(segment.text, options.tgt) ?? fakeTranslateText(segment.text, options.tgt);
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
}
