import { abortError, EngineError, isAbortError } from '../errors';
import { TRANSLATION_STOP_TOKENS } from '../prompt/pfml3';
import { createWllama } from '../wllama';
import type { WllamaConfig } from '../wllama/module';
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
 * for the next request. Width matches `n_parallel`.
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

export type GpuEvidence = 'engaged' | 'missing' | 'unknown';

/**
 * Reads llama.cpp's own load log to tell whether the model really landed on the GPU.
 *
 * Asking for `n_gpu_layers` does not guarantee a GPU: when ggml-webgpu cannot get an adapter
 * or a device inside the worker, llama.cpp registers no GPU and quietly runs every layer on
 * the CPU, with the popup still saying WebGPU. "missing" is only returned on positive evidence (a WebGPU failure, zero
 * offloaded layers, or a tensor load that never names a GPU), so a log format this code
 * does not recognise leaves the GPU path alone instead of forcing a working GPU onto the CPU.
 */
export function gpuEvidence(lines: readonly string[]): GpuEvidence {
  let loadedTensors = false;
  for (const line of lines) {
    if (/using device WebGPU/iu.test(line)) return 'engaged';
    const offloaded = /offloaded (\d+)\/\d+ layers to GPU/iu.exec(line);
    if (offloaded) return Number(offloaded[1]) > 0 ? 'engaged' : 'missing';
    if (/ggml_webgpu: Failed to get (?:an adapter|a device)/iu.test(line)) return 'missing';
    if (/load_tensors:/u.test(line)) loadedTensors = true;
  }
  return loadedTensors ? 'missing' : 'unknown';
}

/** The load log is a few hundred lines; anything past this is not about the device. */
const LOAD_LOG_LINES = 2000;
/** llama.cpp's INFO level, which is where the device and offload lines are printed. */
const LOG_LEVEL_INFO = 2;

function loadLog(): { lines: string[]; logger: Required<WllamaConfig>['logger']; stop(): void } {
  const lines: string[] = [];
  let open = true;
  const note = (...data: unknown[]): void => {
    if (!open || lines.length >= LOAD_LOG_LINES) return;
    lines.push(data.map((value) => String(value)).join(' '));
  };
  return {
    lines,
    logger: { debug: note, log: note, warn: note, error: note },
    stop: () => {
      open = false;
    },
  };
}

export const createWllamaRuntime: RuntimeFactory = async (file, selection) => {
  const log = loadLog();
  const wllama = await createWllama({ suppressNativeLog: false, logger: log.logger });

  try {
    await wllama.loadModel([file], {
      n_ctx: selection.nCtx,
      n_threads: selection.nThreads,
      n_gpu_layers: selection.nGpuLayers,
      n_parallel: selection.nParallel,
      ...(selection.nParallel > 1 ? { cont_batching: true } : {}),
      ctx_shift: false,
      log_level: LOG_LEVEL_INFO,
    });
  } catch (error) {
    log.stop();
    await wllama.exit().catch(() => undefined);
    throw new EngineError('model-load-failed', 'The translation model could not be loaded.', {
      cause: error,
    });
  }
  log.stop();

  if (selection.backend === 'webgpu' && gpuEvidence(log.lines) === 'missing') {
    await wllama.exit().catch(() => undefined);
    throw new EngineError(
      'gpu-unavailable',
      'WebGPU was requested but llama.cpp did not place the model on a GPU.',
    );
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
