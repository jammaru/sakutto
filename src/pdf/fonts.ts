/**
 * What pdf.js reports about one font, reduced to what the reader needs.
 *
 * pdf.js hands back a font object with the embedded font's real name once the page has been
 * rendered (`TimesNewRomanPS-BoldMT`, `Helvetica-Oblique`), and that name is the only
 * reliable description of the typeface: the `styles` map in the text content reports the
 * same generic family for a bold title and its body text. Reading the name is therefore what
 * lets a heading look like a heading in the translation.
 */
export interface FontTraits {
  family: 'serif' | 'sans-serif' | 'monospace';
  bold: boolean;
  italic: boolean;
  /**
   * The font is a typesetting math font rather than a text face.
   *
   * A paper's equations are set in their own fonts — TeX ships Computer Modern Math Italic for
   * variables, CM Symbol for operators, and MS/MT/EX for extension brackets — and none of them
   * is ever used for prose. That makes the font name the one signal that says "this run is
   * mathematics" without guessing from the characters, which matters because the same italic
   * `t` appears in a sentence and in a subscript.
   */
  math: boolean;
}

/**
 * Fonts a LaTeX or TeX-derived paper sets its mathematics in.
 *
 * The list is deliberately only the *math* faces: `CMMI` (math italic), `CMSY` (symbols),
 * `CMEX` (extensible brackets), `CMMIB`/`CMBSY` (their bold forms), `MSAM`/`MSBM` (AMS
 * symbols), `EUFM`/`EUSM` (Euler) and `RSFS`/`WASY` (script and the wasy symbols).
 *
 * `CMR` is **not** here even though it is a Computer Modern face: CMR is the roman *text* of
 * a LaTeX paper, so a rule that matched it would call every body paragraph mathematics and
 * translate nothing at all. The same reasoning keeps `CMBX`, `CMTI`, `CMSS` and `CMTT` out.
 * `STIX`, `XITS`, `Latin Modern Math` and `Cambria Math` are the same idea in a modern family.
 *
 * The name is matched after pdf.js's subset prefix (`BQFOTO+CMMI12`), so a separator is
 * required before the family name.
 */
const MATH_FONT =
  /(?:^|[-+_])(?:cmmi\d*|cmsy\d*|cmex\d*|cmmib\d*|cmbsy\d*|msam\d*|msbm\d*|eufm\d*|eusm\d*|rsfs\d*|wasy\d*|stix(?:two)?math\w*|stixsize\w*|xits ?math\w*|latin ?modern ?math\w*|cambria ?math\w*|asana ?math\w*|tex ?gyre ?math\w*|dejavu ?math\w*|noto ?sans ?math\w*|libertinus ?math\w*|kp ?math\w*|fira ?math\w*|mjxtex\w*|mathjax[_-][\w-]*|ntxmi\w*|ntxsy\w*|ntxex\w*|txmi\w*|txsy\w*|lmmi\d*|lmsy\d*|lmex\d*|mt ?extra|symbol(?:mt)?)(?![a-z])/iu;

/** True when a font name is one of the typesetting math faces. */
export function isMathFontName(name: string): boolean {
  return MATH_FONT.test(name);
}

const MONOSPACE = /courier|consol|mono|code|menlo|monaco|inconsolata/iu;
/**
 * Body faces used for Han / Hiragana / Katakana text. Several of them set FixedPitch in the
 * FontDescriptor, so pdf.js reports `fontFamily: 'monospace'` even though they are not a
 * coding font. Trusting that report turns every Japanese paragraph into a listing.
 */
const CJK_FONT =
  /droid.?sans.?fallback|wenquanyi|micro.?hei|noto.?sans.?cjk|noto.?serif.?cjk|noto.?sans.?(?:jp|kr|sc|tc)|ipagothic|ipamincho|ipapgothic|ipaex|meiryo|ms.?p?mincho|ms.?p?gothic|simsun|simhei|simkai|hiragino|yu.?gothic|yu.?mincho|yugothic|yumincho|kozuka|source.?han|adobesong|adobeheiti|stsong|stheiti|mingliu|pmingliu|fangsong|kaiti|takao|vlgothic|osaka|heisei|ryumin|hanamin|nanum|malgun|batang|dotum|gulim|yahei|jhenghei|dengxian|pingfang|songti|heiti|gb2312|gungsuh|apple.?gothic|apple.?myungjo|cjk/iu;
const SANS = /helvet|arial|verdana|tahoma|calibri|noto ?sans|dejavu ?sans|liberation ?sans|sans/iu;
const BOLD = /bold|black|heavy|semibold|demi|extrabold|ultrabold/iu;
const ITALIC = /italic|oblique/iu;
/** A run this much Han / Hiragana / Katakana is body text, not a listing. */
export const CJK_MAJORITY = 0.4;

/** Reads the traits out of a font name such as `BAAAAA+TimesNewRomanPS-BoldItalicMT`. */
export function traitsOfName(name: string): FontTraits {
  return {
    family: MONOSPACE.test(name) ? 'monospace' : SANS.test(name) ? 'sans-serif' : 'serif',
    bold: BOLD.test(name),
    italic: ITALIC.test(name),
    math: isMathFontName(name),
  };
}

/**
 * Share of letters that are Han, Hiragana or Katakana, ignoring whitespace.
 *
 * Used to refuse a monospace label on a CJK-majority run: those glyphs are body text even
 * when the FontDescriptor set FixedPitch.
 */
export function cjkRatio(text: string): number {
  let letters = 0;
  let cjk = 0;
  for (const character of text) {
    if (/\s/u.test(character)) continue;
    letters += 1;
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(character)) cjk += 1;
  }
  return letters === 0 ? 0 : cjk / letters;
}

function looksLikeMonospaceFace(name: string, sample: string): boolean {
  if (CJK_FONT.test(name) || cjkRatio(sample) >= CJK_MAJORITY) return false;
  return MONOSPACE.test(name);
}

/**
 * A guess from the shapes of the glyphs, for the fonts whose name says nothing — a subset
 * with no descriptive suffix is common in generated PDFs. A serif face's `i` is the giveaway
 * in a name-independent way, but this only looks at the name and at the width of the text,
 * so it is deliberately conservative and defaults to the page's own generic family.
 *
 * `fontFamily === 'monospace'` is trusted only for a name that looks like a coding face.
 * CJK body fonts often set FixedPitch, and pdf.js then reports them as monospace.
 */
export function traitsOfStyle(
  fontFamily: string | undefined,
  name: string,
  sample = '',
): FontTraits {
  const traits = traitsOfName(name);
  if (fontFamily === 'monospace' && looksLikeMonospaceFace(name, sample)) {
    return { ...traits, family: 'monospace' };
  }
  if (
    fontFamily === 'sans-serif' &&
    traits.family === 'serif' &&
    !/serif|times|georgia/iu.test(name)
  ) {
    return { ...traits, family: 'sans-serif' };
  }
  return traits;
}

/** CSS font stack for a trait set, so a translated line is set in a face that matches. */
export function fontStack(
  traits: Pick<FontTraits, 'family'>,
  target: 'ja' | 'en' | 'other',
): string {
  const japanese =
    '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", "Meiryo"';
  const serifJapanese = '"Hiragino Mincho ProN", "Noto Serif JP", "Yu Mincho", serif';
  if (target === 'ja') return traits.family === 'serif' ? serifJapanese : japanese;

  if (traits.family === 'monospace') {
    return '"SFMono-Regular", "Cascadia Mono", "DejaVu Sans Mono", ui-monospace, monospace';
  }
  if (traits.family === 'sans-serif') {
    return '"Helvetica Neue", Helvetica, Arial, "Segoe UI", system-ui, sans-serif';
  }
  return '"Times New Roman", Times, "Liberation Serif", Georgia, serif';
}
