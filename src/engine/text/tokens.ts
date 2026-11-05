const CJK_CHARACTER =
  /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/u;

const WHITESPACE = /\s/u;

/**
 * Approximates the tokenizer count. CJK characters are counted at half a token and other
 * characters at a quarter of a token, which stays slightly above the measured PLaMo ratio.
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

export function completionTokenBudget(text: string): number {
  return Math.max(32, estimateTokens(text) * 2 + 16);
}
