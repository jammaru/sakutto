const CJK_CHARACTER =
  /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/u;

const WHITESPACE = /\s/u;

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/**
 * PLaMo byte-falls back on emoji tag sequences (England/Scotland flags ~33
 * tokens), other non-BMP emoji, and pictographs. A common-vocab heuristic of
 * 1/4 token per code point under-counts those as ~2 tokens and the completion
 * hits max_tokens. Eight tokens per such code point is ~2× UTF-8 bytes.
 */
const BYTE_FALLBACK_TOKENS = 8;

function isByteFallbackHeavy(character: string, point: number): boolean {
  if (point > 0xffff) return true;
  return EXTENDED_PICTOGRAPHIC.test(character);
}

/**
 * Approximates the tokenizer count. CJK characters are counted at half a token and other
 * common-vocab characters at a quarter of a token. Emoji, tags, and other non-BMP code
 * points use a byte-fallback cost so a subdivision flag is not treated as two tokens.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;

  for (const character of text) {
    if (WHITESPACE.test(character)) continue;
    const point = character.codePointAt(0);
    if (point === undefined) continue;
    if (isByteFallbackHeavy(character, point)) tokens += BYTE_FALLBACK_TOKENS;
    else if (CJK_CHARACTER.test(character)) tokens += 0.5;
    else tokens += 0.25;
  }

  return Math.max(1, Math.ceil(tokens));
}

export function completionTokenBudget(text: string): number {
  return Math.max(32, estimateTokens(text) * 2 + 16);
}
