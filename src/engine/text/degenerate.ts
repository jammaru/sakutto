/**
 * Distinct pieces that look like a collapsed kernel before the session leaves WebGPU.
 * One hit retries that piece on CPU; the GPU stays up for everything else.
 */
export const DEGENERATE_SESSION_BLOCKS = 3;

function compact(value: string): string {
  return value.replace(/\s+/gu, '');
}

interface RepeatPattern {
  minLength: number;
  minCopies: number;
  coverage: number;
}

const OUTPUT_REPEAT: RepeatPattern = { minLength: 16, minCopies: 8, coverage: 0.8 };
/** Short laughs and interjections ("Hahaha…", "AAAAH!") still count as source repeats. */
const SOURCE_REPEAT: RepeatPattern = { minLength: 4, minCopies: 3, coverage: 0.5 };

/**
 * A broken WebGPU kernel can collapse every logit onto one id. Greedy sampling
 * then repeats that token until the budget ends. This is only the repeat shape;
 * {@link isBrokenTranslation} decides whether that shape is actually a failure.
 */
export function isDegenerateOutput(value: string): boolean {
  return matchesRepeatPattern(value, OUTPUT_REPEAT);
}

/** Source that is itself a chant, laugh, table rule, or run of marks. */
export function isRepetitiveSource(value: string): boolean {
  return matchesRepeatPattern(value.toLocaleLowerCase(), SOURCE_REPEAT);
}

function matchesRepeatPattern(value: string, pattern: RepeatPattern): boolean {
  const text = compact(value);
  if (text.length < pattern.minLength) return false;

  const need = Math.ceil(text.length * pattern.coverage);
  for (let size = 1; size <= 8; size += 1) {
    for (let offset = 0; offset < size; offset += 1) {
      let run = 0;
      let previous = '';
      for (let index = offset; index + size <= text.length; index += size) {
        const unit = text.slice(index, index + size);
        if (unit === previous) {
          run += size;
        } else {
          previous = unit;
          run = size;
        }
        if (run >= need && run / size >= pattern.minCopies) return true;
      }
    }
  }
  return false;
}

/**
 * True only when the output is very unlikely to be a real translation: it is a
 * collapsed short repeat, the source is not itself that kind of repeat, and
 * generation ran to the token budget (or the output is far longer than the
 * source could justify). Legitimate laughs, chants, and table rules pass.
 */
export function isBrokenTranslation(source: string, output: string, hitMaxTokens = false): boolean {
  if (!isDegenerateOutput(output)) return false;
  if (isRepetitiveSource(source) || isDegenerateOutput(source)) return false;
  if (hitMaxTokens) return true;
  const srcLen = compact(source).length;
  const outLen = compact(output).length;
  return outLen >= Math.max(srcLen * 8, 48);
}
