import { MAX_SEGMENT_TEXT } from '@/engine/offscreen/protocol';
import type { TranslationChunk } from '@/engine/types';
import type { EngineSource } from './engine-status';
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
  /** Local-server requests do not wait on the packaged GGUF file. */
  engineSource?: EngineSource;
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
 *
 * A local server does not use the packaged GGUF file, so download state is ignored then —
 * the same rule the popup uses via `translationStartBlocked`.
 */
export function typedReadiness(input: TypedReadinessInput): TypedReadiness {
  if (!input.consent) return 'no-consent';
  if (input.engineSource === 'local-server') return 'ready';
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

/**
 * Ctrl+Enter (⌘+Enter on a Mac) runs the translation. It is the one accelerator a
 * multi-line box needs, because plain Enter has to keep inserting line breaks.
 */
export function isTranslateShortcut(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}): boolean {
  if (event.key !== 'Enter') return false;
  if (event.isComposing === true) return false;
  if (event.altKey === true || event.shiftKey === true) return false;
  return event.ctrlKey === true || event.metaKey === true;
}

/**
 * Per-request ceiling for the typed box. It matches `MAX_SEGMENT_TEXT` so a request the
 * UI accepts is not rejected by the offscreen protocol. The engine still splits the text
 * into prompt-sized pieces.
 */
export const MAX_TYPED_CHARS = MAX_SEGMENT_TEXT;

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

/** Apply one engine chunk to the typed box. An `error` final is a failure, not a result. */
export function applyTypedChunk(
  state: { text: string; failed: boolean },
  chunk: TranslationChunk,
): { text: string; failed: boolean } {
  if (chunk.textDelta !== undefined) {
    return {
      text: chunk.restart === true ? chunk.textDelta : state.text + chunk.textDelta,
      failed: false,
    };
  }
  if (chunk.final !== undefined) {
    if (chunk.error === true) return { text: '', failed: true };
    return { text: chunk.final, failed: false };
  }
  return state;
}

/** True when the typed box has a translation that is allowed to be copied. */
export function canCopyTypedResult(text: string, failed: boolean): boolean {
  return !failed && text.trim().length > 0;
}

/** Copies the result, reporting failure instead of throwing so the button can show it. */
export async function copyTranslation(
  text: string,
  clipboard: CopyTarget | null | undefined,
  failed = false,
): Promise<boolean> {
  if (!canCopyTypedResult(text, failed)) return false;
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
