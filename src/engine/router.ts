import { EngineError, isAbortError } from './errors';
import { ChunkStream } from './queue/chunk-stream';
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
  plamoReady: () => boolean;
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

export class RoutingEngine {
  private lastChoice: EngineKind | null = null;
  private readonly draftSupport = new Map<string, Promise<PairSupport>>();

  constructor(private readonly dependencies: RoutingDependencies) {}

  get activeEngine(): EngineKind | null {
    return this.lastChoice;
  }

  async *translate(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk> {
    if (segments.length === 0 || options.signal.aborted) return;

    if (options.preview) {
      yield* this.preview(segments, options);
      return;
    }

    if (options.draft && this.dependencies.chrome && this.canDraft(options)) {
      this.lastChoice = 'plamo';
      yield* this.draft(segments, options);
      return;
    }

    const choice = await this.choose(segments, options);
    this.lastChoice = choice;

    let emitted = false;
    try {
      for await (const chunk of this.run(choice, segments, options)) {
        emitted = true;
        yield chunk;
      }
    } catch (error) {
      if (isAbortError(error) || options.signal.aborted) return;
      if (emitted) throw error;

      const fallback = await this.fallback(segments, options, choice);
      if (!fallback) throw error;
      this.lastChoice = fallback;
      yield* this.run(fallback, segments, options);
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

  private async *preview(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk> {
    const chrome = this.dependencies.chrome;
    if (!chrome) return;
    try {
      const support = await this.supportFor(segments, options);
      if (support !== 'available' || options.signal.aborted) return;
      for await (const chunk of chrome.translate(segments, options)) {
        if (chunk.final === undefined || options.signal.aborted) continue;
        yield chunkEngine(chunk, 'chrome');
      }
    } catch {
      // The preview is optional. PLaMo still translates the block in order.
    }
  }

  private canDraft(options: TranslateOptions): boolean {
    return (
      this.dependencies.plamoReady() && this.dependencies.plamoSupports(options.src, options.tgt)
    );
  }

  private supportFor(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): Promise<PairSupport> {
    const key = `${options.src ?? ''}\u0000${options.tgt}`;
    const cached = this.draftSupport.get(key);
    if (cached) return cached;
    const chrome = this.dependencies.chrome;
    const pending = (
      chrome
        ? this.dependencies.chromeSupport(segments, options.src, options.tgt)
        : Promise.resolve<PairSupport>('unavailable')
    ).then(
      (support) => {
        if (support !== 'available') this.draftSupport.delete(key);
        return support;
      },
      (error: unknown) => {
        this.draftSupport.delete(key);
        throw error;
      },
    );
    this.draftSupport.set(key, pending);
    return pending;
  }

  private async *draft(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk> {
    const chrome = this.dependencies.chrome;
    const stream = new ChunkStream<TranslationChunk>();
    const plamoAbort = new AbortController();
    const chromeAbort = new AbortController();
    const stop = (): void => {
      plamoAbort.abort();
      chromeAbort.abort();
    };
    if (options.signal.aborted) return;
    options.signal.addEventListener('abort', stop, { once: true });

    const plamoOptions: TranslateOptions = { ...options, signal: plamoAbort.signal };
    let plamoError: unknown = null;
    let sawChrome = false;

    const plamoTask = (async (): Promise<void> => {
      try {
        for await (const chunk of this.dependencies.plamo.translate(segments, plamoOptions)) {
          stream.push(chunkEngine(chunk, 'plamo'));
        }
      } catch (error) {
        if (!isAbortError(error) && !plamoAbort.signal.aborted) plamoError = error;
      }
    })();

    const chromeTask = (async (): Promise<void> => {
      if (!chrome) return;
      try {
        const support = await this.supportFor(segments, options);
        if (support !== 'available' || chromeAbort.signal.aborted) return;
        for await (const chunk of chrome.translate(segments, {
          ...options,
          signal: chromeAbort.signal,
        })) {
          if (chunk.final === undefined || chromeAbort.signal.aborted) continue;
          sawChrome = true;
          stream.push(chunkEngine({ ...chunk, engine: 'chrome' }, 'chrome'));
        }
      } catch {
        // The draft is optional. PLaMo still completes the block.
      }
    })();

    const finished = (async (): Promise<void> => {
      await plamoTask;
      if (options.signal.aborted || plamoAbort.signal.aborted || !plamoError) {
        chromeAbort.abort();
        stream.end();
        return;
      }
      await chromeTask;
      if (sawChrome) {
        this.lastChoice = 'chrome';
        stream.end();
      } else stream.fail(plamoError);
    })();

    try {
      yield* stream;
    } finally {
      options.signal.removeEventListener('abort', stop);
      chromeAbort.abort();
      plamoAbort.abort();
      await Promise.allSettled([plamoTask, chromeTask, finished]);
    }
  }

  private async choose(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): Promise<EngineKind> {
    const plamoSupports = this.dependencies.plamoSupports(options.src, options.tgt);
    if (plamoSupports && this.dependencies.plamoReady()) return 'plamo';

    const chromeSupport = await this.dependencies.chromeSupport(segments, options.src, options.tgt);
    const chromeUsable = chromeSupport === 'available';

    if (!plamoSupports) {
      if (chromeUsable) return 'chrome';
      throw new EngineError(
        'unsupported-language',
        'No available engine supports this language pair.',
      );
    }

    if (chromeUsable) return 'chrome';

    throw new EngineError('model-missing', 'The translation model is still being prepared.');
  }

  private async fallback(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
    failed: EngineKind,
  ): Promise<EngineKind | null> {
    if (failed === 'plamo') {
      if (!this.dependencies.chrome) return null;
      const support = await this.dependencies.chromeSupport(segments, options.src, options.tgt);
      return support === 'available' ? 'chrome' : null;
    }

    if (!this.dependencies.plamoReady()) return null;
    return this.dependencies.plamoSupports(options.src, options.tgt) ? 'plamo' : null;
  }
}
