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
  /**
   * Stops work that has not entered a completion yet. The completion already
   * decoding still runs to the end, and its tokens are forwarded unless `signal`
   * is also aborted.
   */
  drain?: AbortSignal | undefined;
  /** Stream the first short piece before the rest of this call is batched. */
  eager?: boolean | undefined;
}

/** True when no new completion should start. */
export function isTranslateStopped(options: {
  signal: AbortSignal;
  drain?: AbortSignal | undefined;
}): boolean {
  return options.signal.aborted || options.drain?.aborted === true;
}

interface TranslationChunkBase {
  id: string;
  engine?: EngineKind | undefined;
}

export type TranslationChunk =
  | (TranslationChunkBase & {
      textDelta: string;
      final?: undefined;
      /**
       * The text streamed for this id so far was wrong (a packed request lost its line
       * alignment) and this delta starts it over.
       */
      restart?: boolean | undefined;
    })
  | (TranslationChunkBase & { textDelta?: undefined; final: string; restart?: undefined });

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
  const restart = 'restart' in value ? value.restart : undefined;
  if (restart !== undefined && (typeof restart !== 'boolean' || delta === undefined)) return false;
  const engine = 'engine' in value ? value.engine : undefined;
  return engine === undefined || engine === 'plamo' || engine === 'chrome';
}
