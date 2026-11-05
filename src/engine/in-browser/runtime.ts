import { abortError, EngineError, isAbortError } from '../errors';
import { TRANSLATION_STOP_TOKENS } from '../prompt/pfml3';
import { createWllama } from '../wllama';
import type { BackendKind, BackendSelection } from './backend';

export interface CompletionRequest {
  prompt: string;
  maxTokens: number;
  signal: AbortSignal;
  onToken: (text: string) => void;
}

export interface LlamaRuntime {
  readonly backend: BackendKind;
  readonly threads: number;
  readonly parallel: number;
  complete(request: CompletionRequest): Promise<void>;
  dispose(): Promise<void>;
}

export type RuntimeFactory = (file: Blob, selection: BackendSelection) => Promise<LlamaRuntime>;

/**
 * A cancelled completion is left to finish. Aborting the WASM call wedges the
 * pthread, so the slot stays busy until that generation ends and then opens
 * for the next request. Width matches `n_parallel`: one slot on CPU, and the
 * WebGPU slots that were previously queued behind a single lock.
 */
export class CompletionGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit = 1) {}

  async exclusive(task: () => Promise<void>): Promise<void> {
    await this.acquire();
    try {
      await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < Math.max(1, this.limit)) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

/** Drops tokens that arrive after the page has restored or navigated away. */
export function forwardCompletionToken(
  signal: AbortSignal,
  text: string | undefined,
  onToken: (text: string) => void,
): void {
  if (signal.aborted || !text) return;
  onToken(text);
}

const silentLogger = {
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const createWllamaRuntime: RuntimeFactory = async (file, selection) => {
  const wllama = await createWllama({ suppressNativeLog: true, logger: silentLogger });

  try {
    await wllama.loadModel([file], {
      n_ctx: selection.nCtx,
      n_threads: selection.nThreads,
      n_gpu_layers: selection.nGpuLayers,
      n_parallel: selection.nParallel,
      ...(selection.nParallel > 1 ? { cont_batching: true } : {}),
      ctx_shift: false,
    });
  } catch (error) {
    await wllama.exit().catch(() => undefined);
    throw new EngineError('model-load-failed', 'The translation model could not be loaded.', {
      cause: error,
    });
  }

  const gate = new CompletionGate(selection.nParallel);

  return {
    backend: selection.backend,
    threads: selection.nThreads,
    parallel: selection.nParallel,
    async complete(request: CompletionRequest): Promise<void> {
      await gate.exclusive(async () => {
        if (request.signal.aborted) throw abortError();
        try {
          await wllama.createCompletion({
            prompt: request.prompt,
            max_tokens: request.maxTokens,
            temperature: 0,
            cache_prompt: true,
            stop: [...TRANSLATION_STOP_TOKENS],
            stream: true,
            onData: (chunk) => {
              forwardCompletionToken(request.signal, chunk.choices?.[0]?.text, request.onToken);
            },
          });
          if (request.signal.aborted) throw abortError();
        } catch (error) {
          if (isAbortError(error) || request.signal.aborted) throw abortError();
          throw new EngineError('model-load-failed', 'The translation request failed.', {
            cause: error,
          });
        }
      });
    },
    async dispose(): Promise<void> {
      await wllama.exit();
    },
  };
};
