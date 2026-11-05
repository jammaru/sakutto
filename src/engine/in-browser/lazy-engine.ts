import { abortError } from '../errors';
import type {
  IdentifiedEngine,
  TranslateOptions,
  TranslateSegment,
  TranslationChunk,
} from '../types';
import type { BackendSelection } from './backend';
import { InBrowserEngine, type InBrowserEngineOptions } from './engine';
import type { LlamaRuntime } from './runtime';

export interface LoadedRuntime {
  runtime: LlamaRuntime;
  selection: BackendSelection;
}

export interface LazyInBrowserEngineOptions {
  loadRuntime: (signal: AbortSignal) => Promise<LoadedRuntime>;
  config?: InBrowserEngineOptions['config'];
}

export class LazyInBrowserEngine implements IdentifiedEngine {
  readonly kind = 'plamo' as const;

  private engine: InBrowserEngine | null = null;
  private engineTask: Promise<InBrowserEngine> | null = null;
  private loadController: AbortController | null = null;
  private generation = 0;
  private waiting = 0;

  constructor(private readonly options: LazyInBrowserEngineOptions) {}

  /** Drops the engine after the runtime is released so the next request loads a fresh one. */
  reset(): void {
    this.generation += 1;
    this.loadController?.abort();
    this.loadController = null;
    this.engine = null;
    this.engineTask = null;
  }

  async *translate(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk> {
    const engine = await this.getEngine(options);
    yield* engine.translate(segments, options);
  }

  private getEngine(options: TranslateOptions): Promise<InBrowserEngine> {
    if (this.engine) return Promise.resolve(this.engine);

    if (!this.engineTask) {
      const generation = this.generation;
      const controller = new AbortController();
      this.loadController = controller;

      const task = this.createEngine(controller.signal)
        .then((engine) => {
          if (this.generation === generation) this.engine = engine;
          return engine;
        })
        .finally(() => {
          if (this.engineTask === task) this.engineTask = null;
          if (this.loadController === controller) this.loadController = null;
        });

      this.engineTask = task;
    }

    return this.waitFor(this.engineTask, options.signal);
  }

  /**
   * Races the shared load against the caller's signal so one caller giving up does not tear
   * down a load that later callers still need.
   */
  private async waitFor(
    task: Promise<InBrowserEngine>,
    signal: AbortSignal,
  ): Promise<InBrowserEngine> {
    if (signal.aborted) throw abortError();

    this.waiting += 1;
    try {
      return await new Promise<InBrowserEngine>((resolve, reject) => {
        const onAbort = (): void => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });

        task.then(
          (engine) => {
            signal.removeEventListener('abort', onAbort);
            resolve(engine);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    } finally {
      this.waiting -= 1;
      if (this.waiting === 0 && this.engineTask) this.loadController?.abort();
    }
  }

  private async createEngine(signal: AbortSignal): Promise<InBrowserEngine> {
    const loaded = await this.options.loadRuntime(signal);

    return new InBrowserEngine(loaded.runtime, {
      contextTokens: Math.floor(loaded.selection.nCtx / Math.max(1, loaded.selection.nParallel)),
      ...(this.options.config ? { config: this.options.config } : {}),
    });
  }
}
