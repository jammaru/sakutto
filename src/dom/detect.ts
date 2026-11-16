import { canonicalChromeLanguage, canonicalLanguage, isPlamoOnlyTarget } from '@/shared/languages';
import { buildSegment } from './segment';

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

/**
 * The text a block translates as its own segment, without the placeholder markup that keeps
 * inline children in place. Nested block elements belong to segments of their own, so they
 * must not decide the language of the parent: a Steam comment on a Japanese page quotes a
 * Japanese author label around an English post, and the parent's own words are still English.
 */
function ownTextForLanguage(block: Element, text?: string): string {
  const source = text ?? buildSegment(block)?.source ?? '';
  return source.replace(/<\/?i\d+>/gu, ' ');
}

/**
 * Han-only labels such as a date (`11月16日 1:31`) or `[編集]` look Chinese to the script
 * heuristic because they carry no kana. On a page that declares Japanese they are Japanese,
 * not source text to translate. Any Latin, kana, Hangul, or other letter keeps the heuristic's
 * answer: a mixed run is not a Han-only label.
 */
function isHanOnly(text: string): boolean {
  let han = 0;
  for (const character of text.slice(0, 600)) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) {
      han += 1;
      continue;
    }
    if (/\p{L}/u.test(character)) return false;
  }
  return han >= 2;
}

/**
 * The language declared on an ancestor below `<html>`. A caller that scans a subtree (a mail
 * body) can pass that subtree as `scope`: an app shell around the message may declare the
 * interface locale, and reading it as the source language would mark every English block as
 * already translated. Markers outside the scanned subtree are ignored; markers on the
 * subtree root and inside it still count.
 */
function ancestorLanguage(block: Element, scope?: Element): string | null {
  const root = block.ownerDocument.documentElement;
  const ancestor = block.parentElement?.closest('[lang]');
  if (!ancestor || ancestor === root) return null;
  if (scope && !scope.contains(ancestor)) return null;
  return canonicalPageLanguage(ancestor.getAttribute('lang'));
}

/** Whether the language declared for this block is Japanese, in the same precedence order. */
function declaresJapanese(block: Element, fallback: string | null, scope?: Element): boolean {
  const root = block.ownerDocument.documentElement;
  if (block.hasAttribute('lang') && block !== root) {
    const own = canonicalPageLanguage(block.getAttribute('lang'));
    if (own) return own === 'ja';
  }

  const source =
    scope && !scope.contains(root)
      ? null
      : canonicalPageLanguage(root?.getAttribute('data-sakutto-source-lang'));
  if (source) return source === 'ja';

  const ancestor = ancestorLanguage(block, scope);
  if (ancestor) return ancestor === 'ja';

  const declared = canonicalPageLanguage(fallback);
  if (declared) return declared === 'ja';
  if (scope && !scope.contains(root)) return false;
  return canonicalPageLanguage(root?.getAttribute('lang')) === 'ja';
}

export function languageOf(
  block: Element,
  fallback: string | null,
  text?: string,
  scope?: Element,
): string | null {
  const root = block.ownerDocument.documentElement;
  if (block.hasAttribute('lang') && block !== root) {
    const own = canonicalPageLanguage(block.getAttribute('lang'));
    if (own) return own;
  }

  const ownText = ownTextForLanguage(block, text);
  const inferred = inferLanguage(ownText);
  if (inferred) {
    if (inferred === 'zh-hans' && isHanOnly(ownText) && declaresJapanese(block, fallback, scope)) {
      return 'ja';
    }
    return inferred;
  }

  const source =
    scope && !scope.contains(root)
      ? null
      : canonicalPageLanguage(root?.getAttribute('data-sakutto-source-lang'));
  if (source) {
    // See the note on `contradictsScript` below: a page can declare a language its prose is
    // not in, and a stale declaration must not override the words on the page.
    return contradictsScript(source, ownText) ? null : source;
  }

  // `<html lang>` is set to the target while a page is translated, so reading it as an
  // ancestor tag would mark every untagged block as already translated. Short Latin
  // labels ("Spaces", "Docs") infer nothing, so that tag used to swallow whole sidebars
  // and, on Hugging Face, the entire page. Only a real ancestor below the root counts.
  const ancestor = ancestorLanguage(block, scope);
  if (ancestor) return ancestor;

  const declared = canonicalPageLanguage(fallback);
  // A page can declare a language its prose is not in. The PLaMo license page is served as
  // `<html lang="ja">` with an English body, and reporting `ja` as the source told the model
  // to translate English out of Japanese. When a block is plainly not written in the script
  // of the declared language, claim no source language and let the model see the text alone.
  if (declared !== null && contradictsScript(declared, ownText)) return null;
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
export function contradictsScript(declared: string, text: string): boolean {
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
  text?: string,
  scope?: Element,
): boolean {
  // Easy Japanese is a different output style, not the Japanese already on the page.
  if (isPlamoOnlyTarget(target)) return false;
  const language = languageOf(block, fallback, text, scope);
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
