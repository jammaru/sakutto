export type Formality = 'polite' | 'plain';

export type EngineKind = 'plamo' | 'chrome';

export interface GlossaryEntry {
  source: string;
  target: string;
}

export interface TranslateSegment {
  id: string;
  text: string;
  /** Page bytes to restore on failure. Planning/prompts use `text`. */
  original?: string;
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
  /** Cancel running worse-priority jobs (live captions vs a page batch). */
  preempt?: boolean | undefined;
  /**
   * Ignore both the cache read and the cache write. A retry of a block that just failed must
   * ask the model again instead of receiving the output that failed.
   */
  bypassCache?: boolean | undefined;
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
      error?: undefined;
    })
  | (TranslationChunkBase & {
      textDelta?: undefined;
      final: string;
      restart?: undefined;
      /**
       * This id could not be translated. `final` is the source text so the block is not
       * left hanging; the caller must not cache it or treat it as a finished translation.
       */
      error?: boolean | undefined;
    });

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
  const error = 'error' in value ? value.error : undefined;
  if (error !== undefined && (typeof error !== 'boolean' || final === undefined)) return false;
  const engine = 'engine' in value ? value.engine : undefined;
  return engine === undefined || engine === 'plamo' || engine === 'chrome';
}
