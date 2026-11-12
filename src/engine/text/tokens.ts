const CJK_CHARACTER =
  /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/u;

const WHITESPACE = /\s/u;

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/**
 * PLaMo byte-falls back on emoji tag sequences (England/Scotland flags ~33
 * tokens), other non-BMP emoji, ZWJ sequences, and VS16 emoji presentation.
 * Eight tokens per such code point is ~2× UTF-8 bytes. Plain BMP symbols
 * (© ® ★) only need a modest extra weight so legal text does not blow the
 * prompt estimate.
 */
const BYTE_FALLBACK_TOKENS = 8;
const BMP_SYMBOL_TOKENS = 1;

function isEmojiLike(point: number | undefined): boolean {
  if (point === undefined) return false;
  if (point > 0xffff) return true;
  if (point === 0xfe0e || point === 0xfe0f) return true;
  return EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(point));
}

/**
 * Approximates the tokenizer count for packing, prompt room, and the tok/s
 * display. CJK characters are counted at half a token and other characters at
 * a quarter of a token, which stays slightly above the measured PLaMo ratio.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;

  for (const character of text) {
    if (CJK_CHARACTER.test(character)) {
      cjk += 1;
    } else if (!WHITESPACE.test(character)) {
      other += 1;
    }
  }

  return Math.max(1, Math.ceil(cjk / 2 + other / 4));
}

/** Conservative count for completion `max_tokens`, not for packing or tok/s. */
export function budgetTokens(text: string): number {
  const characters = [...text];
  const points = characters.map((character) => character.codePointAt(0) ?? 0);
  let tokens = 0;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    if (WHITESPACE.test(character)) continue;
    const point = points[index]!;
    const previous = index > 0 ? points[index - 1] : undefined;
    const next = index + 1 < points.length ? points[index + 1] : undefined;
    if (point > 0xffff) tokens += BYTE_FALLBACK_TOKENS;
    else if (point === 0x200d && (isEmojiLike(previous) || isEmojiLike(next))) {
      tokens += BYTE_FALLBACK_TOKENS;
    } else if (point === 0xfe0f && isEmojiLike(previous)) tokens += BYTE_FALLBACK_TOKENS;
    else if (next === 0xfe0f && isEmojiLike(point)) tokens += BYTE_FALLBACK_TOKENS;
    else if (CJK_CHARACTER.test(character)) tokens += 0.5;
    else if (EXTENDED_PICTOGRAPHIC.test(character)) tokens += BMP_SYMBOL_TOKENS;
    else tokens += 0.25;
  }

  return Math.max(1, Math.ceil(tokens));
}

/**
 * Completion `max_tokens` from a conservative count of the source. Byte-fallback
 * sequences (subdivision flags, family emoji) need far more room than
 * {@link estimateTokens}; the prompt/available side keeps the lighter count.
 */
export function completionTokenBudget(text: string, counted?: number): number {
  return Math.max(32, (counted ?? budgetTokens(text)) * 2 + 16);
}
