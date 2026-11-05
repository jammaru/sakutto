import { EngineError } from '../errors';
import type { Formality, GlossaryEntry } from '../types';

export const PFML3 = {
  tag: '<|plamo:tag|>',
  msg: '<|plamo:msg|>',
  key: '<|plamo:key|>',
  val: '<|plamo:val|>',
  index: '<|plamo:index|>',
  item: '<|plamo:item|>',
} as const;

export const BOS_TOKEN = '<|plamo:bos|>';

export const TRANSLATION_STOP_TOKENS: readonly string[] = [PFML3.tag, BOS_TOKEN];

const RESERVED_TOKEN = '<|plamo:';
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z]{4})?$/;

export interface PromptInput {
  text: string;
  tgt: string;
  src?: string | undefined;
  form?: Formality | undefined;
  glossary?: readonly GlossaryEntry[] | undefined;
  context?: string | undefined;
}

function checkText(value: string, field: string): string {
  if (typeof value !== 'string') {
    throw new EngineError('invalid-input', `${field} must be a string.`);
  }
  if (value.trim().length === 0) {
    throw new EngineError('invalid-input', `${field} must not be empty.`);
  }
  if (value.includes(RESERVED_TOKEN)) {
    throw new EngineError('invalid-input', `${field} must not contain PFML tokens.`);
  }
  return value;
}

export function normalizeLanguageTag(value: string): string {
  return value.trim().toLowerCase().replaceAll('_', '-');
}

export function checkLanguageTag(value: string, field: string): string {
  const normalized = normalizeLanguageTag(value);
  if (!LANGUAGE_PATTERN.test(normalized)) {
    throw new EngineError(
      'unsupported-language',
      `${field} must be a lowercase language code such as en, ja or zh-hans.`,
    );
  }
  return normalized;
}

export function sanitizeGlossary(glossary: readonly GlossaryEntry[]): GlossaryEntry[] {
  const entries = new Map<string, string>();

  for (const entry of glossary) {
    const source = entry.source.trim();
    const target = entry.target.trim();
    if (source.length === 0 || target.length === 0) continue;
    if (source.includes(RESERVED_TOKEN) || target.includes(RESERVED_TOKEN)) continue;
    entries.set(source, target);
  }

  return [...entries].map(([source, target]) => ({ source, target }));
}

/**
 * Builds a PFML3 translation prompt. The BOS token is omitted because llama.cpp prepends it
 * when the prompt is tokenized.
 */
export function buildTranslationPrompt(input: PromptInput): string {
  const text = checkText(input.text, 'text');
  const tgt = checkLanguageTag(input.tgt, 'target_lang');

  if (input.form !== undefined && tgt !== 'ja') {
    throw new EngineError('invalid-input', 'form requires target_lang ja.');
  }

  let prompt = `${PFML3.tag}dataset${PFML3.msg}translation`;

  if (input.context && input.context.trim().length > 0) {
    prompt += `${PFML3.tag}context${PFML3.msg}${checkText(input.context, 'context')}`;
  }

  if (input.glossary && input.glossary.length > 0) {
    prompt += `${PFML3.tag}glossary`;
    for (const [index, entry] of input.glossary.entries()) {
      const source = checkText(entry.source, `glossary source ${String(index)}`);
      const target = checkText(entry.target, `glossary target ${String(index)}`);
      prompt += `${PFML3.index}${source}${PFML3.item}${target}`;
    }
  }

  prompt += `${PFML3.tag}input`;
  if (input.src !== undefined && input.src.trim().length > 0) {
    prompt += `${PFML3.key}lang${PFML3.val}${checkLanguageTag(input.src, 'source_lang')}`;
  }
  prompt += `${PFML3.msg}${text}`;
  prompt += `${PFML3.tag}output${PFML3.key}lang${PFML3.val}${tgt}`;

  if (input.form !== undefined) {
    prompt += `${PFML3.key}form${PFML3.val}${input.form}`;
  }

  return `${prompt}${PFML3.msg}`;
}

export function cleanModelOutput(value: string): string {
  let output = value;
  for (const marker of [PFML3.tag, BOS_TOKEN]) {
    const index = output.indexOf(marker);
    if (index !== -1) output = output.slice(0, index);
  }
  return output.trim();
}
