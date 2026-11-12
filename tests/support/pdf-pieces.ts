import type { TextPiece } from '@/pdf/lines';

/** A synthetic glyph run at a position, in top-left space. */
export function piece(
  text: string,
  x: number,
  baseline: number,
  width: number,
  options: {
    em?: number;
    bold?: boolean;
    italic?: boolean;
    math?: boolean;
    family?: TextPiece['family'];
    orientation?: number;
  } = {},
): TextPiece {
  const em = options.em ?? 10;
  return {
    text,
    box: { x, y: baseline - em, width, height: em },
    baseline,
    fontName: options.math === true ? 'CMMI10' : options.bold === true ? 'bold' : 'regular',
    family: options.family ?? 'serif',
    bold: options.bold === true,
    italic: options.italic === true,
    math: options.math === true,
    orientation: options.orientation ?? 0,
    size: em,
  };
}

/** A Latin-width stand-in: one character is half an em. */
export function measure(text: string, size: number): number {
  let cjk = 0;
  for (const character of text) {
    if (
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)
    ) {
      cjk += 1;
    }
  }
  return cjk * size + (text.length - cjk) * size * 0.5;
}
