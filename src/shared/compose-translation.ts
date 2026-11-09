import { inferLanguage } from '@/dom/detect';
import { canonicalLanguage, isTargetLanguage, type TargetLanguage } from './languages';
import { PRIMARY_PAIR_TARGET, typedTargetNeedsChrome } from './typed-translation';

export type ComposePlan = {
  ok: boolean;
  sourceLanguage: string | null;
  targetLanguage: TargetLanguage;
  /** The other side of the ja ↔ preferred pair, for the swap control. */
  other: TargetLanguage;
};

/**
 * How long to wait after the last keystroke before refreshing a live preview. Short enough
 * that a pause in typing still feels like a reply, long enough that a burst of keys does
 * not start a request per letter.
 */
export const COMPOSE_PREVIEW_MS = 700;

/**
 * The other half of the pair a compose request can flip to. Japanese is one side; the
 * reader's saved target (or English, when that target is already Japanese) is the other.
 */
export function composePairOther(
  current: TargetLanguage,
  preferred: TargetLanguage,
): TargetLanguage {
  if (current === 'ja') return preferred === 'ja' ? 'en' : preferred;
  return 'ja';
}

/**
 * True when the draft already reads as the chosen target, so translating into that target
 * would be a no-op. Only scripts `inferLanguage` can name (kana, Hangul, Han, and the
 * other distinctive ones) count: Latin letters cover many languages, so a German draft
 * with an English target must not be treated as "already English" and sent to Japanese.
 */
export function draftLooksLikeTarget(text: string, target: string): boolean {
  const inferred = inferLanguage(text);
  if (!inferred) return false;
  const canonical = canonicalLanguage(target) ?? (isTargetLanguage(target) ? target : null);
  if (!canonical) return false;
  return sameScript(inferred, canonical);
}

function sameScript(inferred: string, target: string): boolean {
  if (inferred === target) return true;
  return inferred.startsWith('zh') && target.startsWith('zh');
}

function chooseComposeTarget(text: string, preferred: TargetLanguage): TargetLanguage {
  if (draftLooksLikeTarget(text, preferred)) return composePairOther(preferred, preferred);
  return preferred;
}

/**
 * Which way a draft in a message box is translated.
 *
 * The saved target language is the default, matching the typed-text page. A draft that is
 * already in that language — Japanese when the target is Japanese, English when it is
 * English — flips to the other side of the main pair so the first request is not a no-op.
 * `swapped` inverts that choice for this field, the way the typed page's swap control does.
 * `explicit` skips the auto-flip: the preview language the reader picked is the target.
 *
 * The source is left unset for the engine: PLaMo does not need it, and a wrong guess here
 * would be a second place to fail. `sourceLanguage` is only the heuristic the swap and the
 * preview kicker can show.
 */
export function planComposeTranslation(
  text: string,
  preferred: TargetLanguage,
  swapped = false,
  explicit = false,
): ComposePlan {
  const preferredTarget = isTargetLanguage(preferred) ? preferred : PRIMARY_PAIR_TARGET;
  const auto = explicit ? preferredTarget : chooseComposeTarget(text, preferredTarget);
  const target = swapped ? composePairOther(auto, preferredTarget) : auto;
  return {
    ok: !typedTargetNeedsChrome(target),
    sourceLanguage: inferLanguage(text),
    targetLanguage: target,
    other: composePairOther(target, preferredTarget),
  };
}
