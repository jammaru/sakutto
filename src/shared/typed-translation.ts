import { isChromeOnlyLanguage, isTargetLanguage, type TargetLanguage } from './languages';

export type TypedDirection = 'to-ja' | 'to-other';

export interface TypedPlan {
  /** False when the direction cannot be decided from the chosen target. */
  ok: boolean;
  sourceLanguage: string | null;
  targetLanguage: TargetLanguage;
  /** The half of the main pair this direction reads, for the swap control. */
  other: TargetLanguage;
}

/** The pair the product is built around: Japanese and everything else it translates. */
export const PRIMARY_PAIR_TARGET: TargetLanguage = 'ja';

/**
 * Which way a typed input is translated. The app's target language is the direction: a
 * reader whose UI target is Japanese is typing English (or any other language) and wants
 * Japanese, and one whose target is English is typing Japanese and wants English.
 *
 * The source is left unset on purpose. PLaMo translates a paragraph without being told
 * which language it is in, and guessing here would be a second place to be wrong when a
 * user pastes a language the picker never offered.
 */
export function planTypedTranslation(targetLanguage: TargetLanguage): TypedPlan {
  const target = isTargetLanguage(targetLanguage) ? targetLanguage : PRIMARY_PAIR_TARGET;
  return {
    ok: true,
    sourceLanguage: null,
    targetLanguage: target,
    other: target === 'ja' ? 'en' : 'ja',
  };
}

/**
 * Why typed text cannot be sent right now. `ready` means the model is loaded; every other
 * value names the setup step the page has to offer first.
 */
export type TypedReadiness =
  'ready' | 'no-consent' | 'model-absent' | 'model-partial' | 'model-busy' | 'model-error';

export interface TypedReadinessInput {
  consent: boolean;
  modelState:
    'absent' | 'partial' | 'downloading' | 'verifying' | 'ready' | 'loading' | 'loaded' | 'error';
  plamoReady: boolean;
}

/**
 * The gate in front of the model. Typed text uses the same engine, the same consent record
 * and the same load flow as a page, so it waits for the same things in the same order: agree
 * to the license, have the file, then let it load.
 *
 * A Chrome-only target is refused here too. The built-in translator is a page's real engine
 * only for languages PLaMo cannot translate, and typed text is not a page, so there is no
 * half-supported direction to cover. Returning `ready` for one would make this box look like
 * a PLaMo translation while another engine wrote it.
 */
export function typedReadiness(input: TypedReadinessInput): TypedReadiness {
  if (!input.consent) return 'no-consent';
  if (input.modelState === 'error') return 'model-error';
  if (input.modelState === 'downloading' || input.modelState === 'verifying') return 'model-busy';
  if (input.modelState === 'loading') return 'model-busy';
  if (input.plamoReady) return 'ready';
  if (input.modelState === 'ready' || input.modelState === 'loaded') return 'ready';
  if (input.modelState === 'partial') return 'model-partial';
  return 'model-absent';
}

/** True when the picked target can only be served by Chrome's built-in translator. */
export function typedTargetNeedsChrome(targetLanguage: string): boolean {
  return isChromeOnlyLanguage(targetLanguage);
}

/** A character count that fits the model's own per-segment ceiling. */
export const MAX_TYPED_CHARS = 20_000;

/**
 * Trims the pasted text the way the page collector trims a block: runs of whitespace collapse
 * to one space and the ends are trimmed, but a real line break inside the text is kept as a
 * line break because the user typed it as structure.
 */
export function normalizeTypedInput(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

export interface CopyTarget {
  writeText(text: string): Promise<void>;
}

/** Copies the result, reporting failure instead of throwing so the button can show it. */
export async function copyTranslation(
  text: string,
  clipboard: CopyTarget | null | undefined,
): Promise<boolean> {
  if (text.trim().length === 0) return false;
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
