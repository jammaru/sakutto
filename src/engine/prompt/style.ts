function languageTag(value: string): string {
  return value.trim().toLowerCase().replaceAll('_', '-');
}

/**
 * Writing style for PLaMo 3 Translate, independent of Japanese `form` (plain / polite).
 *
 * PFN documents only two trained output-style values: `form=plain` and `form=polite`, and
 * only when the target is Japanese. There is no `form=formal` (or similar). The trained
 * `context` field is "reference context for interpreting the source text, such as the
 * surrounding text or the situation" — PFN's own examples are a situation ("工作で折り紙を
 * 作っています。") and a page type ("プロジェクト管理ツールのヘルプページです。").
 *
 * Non-neutral styles therefore pass a short situation / document-type sentence through
 * that `context` field. They do not invent PFML keys, do not write instructions into the
 * source text, and do not use a system message. Neutral omits `context` so the prompt is
 * byte-identical to the previous default.
 */
export const TRANSLATION_STYLES = [
  'formal',
  'polite',
  'business',
  'neutral',
  'casual',
  'friendly',
  'logical',
] as const;

export type TranslationStyle = (typeof TRANSLATION_STYLES)[number];

export const DEFAULT_TRANSLATION_STYLE: TranslationStyle = 'neutral';

/** Target languages that have a trained way to express a style list. */
export const STYLED_TARGET_LANGUAGES = ['ja', 'en'] as const;
export type StyledTargetLanguage = (typeof STYLED_TARGET_LANGUAGES)[number];

/**
 * Situation sentences the model was trained to read as `context`. Imperatives
 * ("translate formally", "do not add content") are not used.
 */
const SITUATIONS: Record<
  StyledTargetLanguage,
  Record<Exclude<TranslationStyle, 'neutral'>, string>
> = {
  ja: {
    formal: '公式文書です。',
    polite: '相手への配慮を重視した丁寧な文章です。',
    business: 'ビジネス文書です。',
    casual: '日常会話です。',
    friendly: '親しい相手へのメッセージです。',
    logical: '論点と因果関係を述べた説明文です。',
  },
  en: {
    formal: 'This is an official document.',
    polite: 'This is a polite, considerate message.',
    business: 'This is a business document.',
    casual: 'This is a casual conversation.',
    friendly: 'This is a friendly message to someone you know.',
    logical: 'This is an explanation that states claims and causes.',
  },
};

export function isTranslationStyle(value: unknown): value is TranslationStyle {
  return typeof value === 'string' && (TRANSLATION_STYLES as readonly string[]).includes(value);
}

export function isStyledTargetLanguage(value: string): value is StyledTargetLanguage {
  const tag = languageTag(value);
  return tag === 'ja' || tag === 'en';
}

/**
 * Styles offered for a target language. Japanese and English get the issue's lists.
 * Other languages get none: PFN does not document a style enum for them, and faking a
 * generic list would still only work through `context` the same way.
 */
export function stylesForTarget(targetLanguage: string): readonly TranslationStyle[] {
  return isStyledTargetLanguage(targetLanguage) ? TRANSLATION_STYLES : [];
}

/**
 * Language of the situation sentence. Context interprets the source, so a ja/en source
 * uses that language; otherwise the ja/en target. Other targets produce no situation.
 */
export function situationLanguage(
  targetLanguage: string,
  sourceLanguage?: string | undefined,
): StyledTargetLanguage | null {
  const target = languageTag(targetLanguage);
  if (target !== 'ja' && target !== 'en') return null;
  if (sourceLanguage !== undefined && sourceLanguage.trim().length > 0) {
    const source = languageTag(sourceLanguage);
    if (source === 'ja' || source === 'en') return source;
  }
  return target;
}

export function situationForStyle(
  style: TranslationStyle,
  targetLanguage: string,
  sourceLanguage?: string | undefined,
): string | undefined {
  if (style === 'neutral') return undefined;
  const language = situationLanguage(targetLanguage, sourceLanguage);
  if (!language) return undefined;
  return SITUATIONS[language][style];
}

export function mergeTranslationContext(
  situation: string | undefined,
  surrounding: string | undefined,
): string | undefined {
  const extra = surrounding?.trim() ?? '';
  const parts = [situation, extra.length > 0 ? extra : undefined].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  if (parts.length === 0) return undefined;
  return parts.join('\n');
}

/** Context actually written into PFML3 for a translate request. */
export function resolvePromptContext(input: {
  style?: TranslationStyle | undefined;
  tgt: string;
  src?: string | undefined;
  context?: string | undefined;
}): string | undefined {
  return mergeTranslationContext(
    situationForStyle(input.style ?? DEFAULT_TRANSLATION_STYLE, input.tgt, input.src),
    input.context,
  );
}
