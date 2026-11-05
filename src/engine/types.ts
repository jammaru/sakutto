export type Formality = 'polite' | 'plain';

export type EngineKind = 'plamo' | 'chrome';

export interface GlossaryEntry {
  source: string;
  target: string;
}

export interface TranslateSegment {
  id: string;
  text: string;
}

export interface TranslateOptions {
  src?: string | undefined;
  tgt: string;
  form: Formality;
  glossary?: readonly GlossaryEntry[] | undefined;
  context?: string | undefined;
  priority: number;
  signal: AbortSignal;
  /** Stream the first short piece before the rest of this call is batched. */
  eager?: boolean | undefined;
  /** Show a built-in draft for this call, then replace it with the PLaMo result. */
  draft?: boolean | undefined;
  /** Paint Chrome's built-in translator only. PLaMo is not started by this call. */
  preview?: boolean | undefined;
}

interface TranslationChunkBase {
  id: string;
  engine?: EngineKind | undefined;
}

export type TranslationChunk =
  | (TranslationChunkBase & { textDelta: string; final?: undefined })
  | (TranslationChunkBase & { textDelta?: undefined; final: string });

export interface Engine {
  translate(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk>;
}

export interface IdentifiedEngine extends Engine {
  readonly kind: EngineKind;
}

export function isTranslationChunk(value: unknown): value is TranslationChunk {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value) || typeof value.id !== 'string') return false;
  const delta = 'textDelta' in value ? value.textDelta : undefined;
  const final = 'final' in value ? value.final : undefined;
  if (delta === undefined && final === undefined) return false;
  if (delta !== undefined && typeof delta !== 'string') return false;
  if (final !== undefined && typeof final !== 'string') return false;
  const engine = 'engine' in value ? value.engine : undefined;
  return engine === undefined || engine === 'plamo' || engine === 'chrome';
}
