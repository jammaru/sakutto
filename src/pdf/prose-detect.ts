/** A word long enough to be prose rather than a label, unit or notation mark. */
const PROSE_WORD = /\p{L}{3,}/gu;
const PROSE_WORDS = 3;

/** True when a block carries enough real words to count as prose. */
export function hasSourceProse(text: string): boolean {
  return (text.match(PROSE_WORD)?.length ?? 0) >= PROSE_WORDS;
}
