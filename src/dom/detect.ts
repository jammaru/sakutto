import { canonicalChromeLanguage, canonicalLanguage } from '@/shared/languages';

export function canonicalPageLanguage(tag: string | null | undefined): string | null {
  if (!tag) return null;
  return canonicalLanguage(tag) ?? canonicalChromeLanguage(tag);
}

/**
 * Script heuristic used when the page has no language tag and the LanguageDetector API is
 * absent. Latin text is left undecided because the same letters cover many languages.
 */
export function inferLanguage(text: string): string | null {
  const sample = text.slice(0, 600);
  let hangul = 0;
  let kana = 0;
  let han = 0;
  let cyrillic = 0;
  let arabic = 0;
  let thai = 0;
  let hebrew = 0;
  let latin = 0;

  for (const character of sample) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0xac00 && code <= 0xd7af) hangul += 1;
    else if (code >= 0x3040 && code <= 0x30ff) kana += 1;
    else if (code >= 0x4e00 && code <= 0x9fff) han += 1;
    else if (code >= 0x0400 && code <= 0x04ff) cyrillic += 1;
    else if (code >= 0x0600 && code <= 0x06ff) arabic += 1;
    else if (code >= 0x0e00 && code <= 0x0e7f) thai += 1;
    else if (code >= 0x0590 && code <= 0x05ff) hebrew += 1;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1;
  }

  const letters = hangul + kana + han + cyrillic + arabic + thai + hebrew + latin;
  // A few kana or kanji inside an English sentence must not mark the block as Japanese.
  if (latin > 0 && latin * 2 >= letters) return null;

  if (kana >= 2 && kana >= hangul) return 'ja';

  const ranked: readonly (readonly [string, number])[] = [
    ['ko', hangul],
    ['zh-hans', han],
    ['ru', cyrillic],
    ['ar', arabic],
    ['th', thai],
    ['he', hebrew],
  ];

  let best: string | null = null;
  let score = 0;
  for (const [language, count] of ranked) {
    if (count > score) {
      score = count;
      best = language;
    }
  }

  return score >= 2 ? best : null;
}

export function languageOf(block: Element, fallback: string | null): string | null {
  const root = block.ownerDocument.documentElement;
  if (block.hasAttribute('lang') && block !== root) {
    const own = canonicalPageLanguage(block.getAttribute('lang'));
    if (own) return own;
  }

  const inferred = inferLanguage(block.textContent ?? '');
  if (inferred) return inferred;

  const source = canonicalPageLanguage(root?.getAttribute('data-sakutto-source-lang'));
  if (source) {
    // See the note on `contradictsScript` below: a page can declare a language its prose is
    // not in, and a stale declaration must not override the words on the page.
    return contradictsScript(source, block.textContent ?? '') ? null : source;
  }

  // `<html lang>` is set to the target while a page is translated, so reading it as an
  // ancestor tag would mark every untagged block as already translated. Short Latin
  // labels ("Spaces", "Docs") infer nothing, so that tag used to swallow whole sidebars
  // and, on Hugging Face, the entire page. Only a real ancestor below the root counts.
  const ancestor = block.parentElement?.closest('[lang]');
  if (ancestor && ancestor !== root) {
    const tagged = canonicalPageLanguage(ancestor.getAttribute('lang'));
    if (tagged) return tagged;
  }

  const declared = canonicalPageLanguage(fallback);
  // A page can declare a language its prose is not in. The PLaMo license page is served as
  // `<html lang="ja">` with an English body, and reporting `ja` as the source told the model
  // to translate English out of Japanese. When a block is plainly not written in the script
  // of the declared language, claim no source language and let the model see the text alone.
  if (declared !== null && contradictsScript(declared, block.textContent ?? '')) return null;
  return declared;
}

/** Languages written without Latin letters, used only to spot a wrong declared tag. */
const NON_LATIN_SCRIPTS: ReadonlySet<string> = new Set([
  'ja',
  'zh-hans',
  'zh-hant',
  'ko',
  'ru',
  'ar',
  'th',
  'he',
]);

/** Enough letters to make the script of a block unambiguous. */
const SCRIPT_SAMPLE_MIN_LETTERS = 24;

/**
 * True when a block has no character from the declared language's script at all. A Japanese
 * page that quotes an English sentence keeps the quote out of the Japanese reading, and a
 * Japanese paragraph always carries kana or kanji, so an all-Latin run of prose is not
 * Japanese whatever the tag says.
 */
function contradictsScript(declared: string, text: string): boolean {
  if (!NON_LATIN_SCRIPTS.has(declared)) return false;
  let latin = 0;
  let other = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1;
    else if (code > 0x7f && /\p{L}/u.test(character)) other += 1;
  }
  return other === 0 && latin >= SCRIPT_SAMPLE_MIN_LETTERS;
}

export function isAlreadyTargetLanguage(
  block: Element,
  target: string,
  fallback: string | null,
): boolean {
  const language = languageOf(block, fallback);
  const canonicalTarget = canonicalPageLanguage(target);
  return language !== null && canonicalTarget !== null && language === canonicalTarget;
}

interface LanguageDetectorResult {
  detectedLanguage: string;
  confidence?: number;
}

interface LanguageDetectorInstance {
  detect(text: string): Promise<readonly LanguageDetectorResult[]>;
  destroy?(): void;
}

interface LanguageDetectorConstructor {
  availability(): Promise<string>;
  create(): Promise<LanguageDetectorInstance>;
}

/**
 * One sample for the whole document. Block tags still win later; this only fills in pages
 * that never declared a language.
 */
export async function detectDocumentLanguage(doc: Document): Promise<string | null> {
  if (canonicalPageLanguage(doc.documentElement.lang)) return null;

  const detector = (globalThis as { LanguageDetector?: LanguageDetectorConstructor })
    .LanguageDetector;
  if (!detector) return inferLanguage(doc.body?.innerText ?? '');

  try {
    const availability = await detector.availability();
    if (availability === 'unavailable' || availability === 'no') {
      return inferLanguage(doc.body?.innerText ?? '');
    }

    const instance = await detector.create();
    try {
      const sample = (doc.body?.innerText ?? '').slice(0, 1200);
      if (sample.trim().length === 0) return null;
      const results = await instance.detect(sample);
      let best: LanguageDetectorResult | null = null;
      for (const result of results) {
        if (!best || (result.confidence ?? 0) > (best.confidence ?? 0)) best = result;
      }
      return (
        canonicalPageLanguage(best?.detectedLanguage) ?? inferLanguage(doc.body?.innerText ?? '')
      );
    } finally {
      instance.destroy?.();
    }
  } catch {
    return inferLanguage(doc.body?.innerText ?? '');
  }
}
