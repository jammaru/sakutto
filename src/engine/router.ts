import { EngineError, isAbortError } from './errors';
import type {
  EngineKind,
  IdentifiedEngine,
  TranslateOptions,
  TranslateSegment,
  TranslationChunk,
} from './types';

export type PairSupport = 'available' | 'downloadable' | 'downloading' | 'unavailable';

export interface RoutingDependencies {
  plamo: IdentifiedEngine;
  chrome: IdentifiedEngine | null;
  plamoSupports: (src: string | undefined, tgt: string) => boolean;
  chromeSupport: (
    segments: readonly TranslateSegment[],
    src: string | undefined,
    tgt: string,
  ) => Promise<PairSupport>;
}

function chunkEngine(chunk: TranslationChunk, kind: EngineKind): TranslationChunk {
  return { ...chunk, engine: chunk.engine ?? kind };
}

/**
 * Picks the engine for a request.
 *
 * A pair the model can translate always goes to the model, even while it is still loading:
 * there is no Chrome stand-in to paint first, so a reader sees the source text and then
 * PLaMo's own tokens. The built-in translator is chosen only for a pair the model cannot
 * handle at all, where it is the page's real translator rather than a preview of one.
 *
 * There is deliberately no cross-engine fallback. A model failure keeps the source text
 * visible instead of relabelling the page with a Chrome translation.
 */
export class RoutingEngine {
  private lastChoice: EngineKind | null = null;

  constructor(private readonly dependencies: RoutingDependencies) {}

  get activeEngine(): EngineKind | null {
    return this.lastChoice;
  }

  async *translate(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk> {
    if (segments.length === 0 || options.signal.aborted) return;

    const choice = await this.choose(segments, options);
    this.lastChoice = choice;

    try {
      yield* this.run(choice, segments, options);
    } catch (error) {
      if (isAbortError(error) || options.signal.aborted) return;
      throw error;
    }
  }

  private async *run(
    choice: EngineKind,
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk> {
    const engine = choice === 'plamo' ? this.dependencies.plamo : this.dependencies.chrome;
    if (!engine) {
      throw new EngineError('chrome-unavailable', 'The built-in translator is not available.');
    }

    for await (const chunk of engine.translate(segments, options)) {
      yield chunkEngine(chunk, choice);
    }
  }

  private async choose(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): Promise<EngineKind> {
    if (this.dependencies.plamoSupports(options.src, options.tgt)) return 'plamo';

    const chromeSupport = await this.dependencies.chromeSupport(segments, options.src, options.tgt);
    if (chromeSupport === 'available') return 'chrome';

    throw new EngineError(
      'unsupported-language',
      'No available engine supports this language pair.',
    );
  }
}
