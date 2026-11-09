import { canonicalLanguage } from '@/shared/languages';
import { sha256Hex } from '../model/sha256';
import { sanitizeGlossary } from '../prompt/pfml3';
import { resolvePromptContext } from '../prompt/style';
import type { Formality, GlossaryEntry, TranslationStyle } from '../types';

export interface CacheKeyInput {
  model: string;
  tgt: string;
  form: Formality;
  text: string;
  src?: string | undefined;
  style?: TranslationStyle | undefined;
  glossary?: readonly GlossaryEntry[] | undefined;
  context?: string | undefined;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function glossaryVersion(glossary: readonly GlossaryEntry[] | undefined): string {
  if (!glossary || glossary.length === 0) return 'none';
  return fnv1a(glossary.map((entry) => `${entry.source}\u0000${entry.target}`).join('\u0001'));
}

function languagePart(value: string | undefined): string {
  if (!value || value.trim().length === 0) return 'auto';
  return canonicalLanguage(value) ?? value.trim().toLowerCase();
}

export function buildTranslationCacheKey(input: CacheKeyInput): string {
  const parts = [
    'v1',
    input.model,
    languagePart(input.src),
    languagePart(input.tgt),
    input.form,
    glossaryVersion(sanitizeGlossary(input.glossary ?? [])),
  ];
  const context = resolvePromptContext({
    style: input.style,
    tgt: input.tgt,
    src: input.src,
    context: input.context,
  });
  // Neutral with no surrounding context keeps the previous 7-part key so cached
  // translations for the default style stay valid.
  if (context) parts.push(`ctx:${fnv1a(context)}`);
  parts.push(sha256Hex(input.text));
  return parts.join('|');
}
