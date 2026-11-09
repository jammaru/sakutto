import { abortError, EngineError, isAbortError } from '../errors';
import { gpuFailureExcerpt } from '@/shared/gpu-diagnostic';
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

/**
 * ggml aborts the WASM module when the GPU device goes away. The request running at that moment
 * rejects with wllama's RuntimeError, and every later call rejects with the plain string its
 * worker posts back. A failure the model itself reports is a typed WllamaError instead, and
 * leaves the runtime usable.
 */
export function isRuntimeDead(error: unknown): boolean {
  if (typeof error === 'string') return true;
  return error instanceof Error && error.name === 'RuntimeError';
}

export type GpuEvidence = 'engaged' | 'missing' | 'unknown';

let lastWebGpuLines: string[] = [];

/** llama.cpp WebGPU lines from the most recent model load. Used by the settings diagnostic. */
export function lastWebGpuLoadLog(): readonly string[] {
  return lastWebGpuLines;
}

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
  let sawDeviceReady = false;
  let sawFinalFailure = false;
  let offloaded: GpuEvidence | null = null;
  for (const line of lines) {
    if (/using device WebGPU/iu.test(line)) return 'engaged';
    if (/ggml_webgpu: device ready/iu.test(line)) sawDeviceReady = true;
    const match = /offloaded (\d+)\/\d+ layers to GPU/iu.exec(line);
    if (match) offloaded = Number(match[1]) > 0 ? 'engaged' : 'missing';
    if (
      /ggml_webgpu: Failed to get an adapter/iu.test(line) ||
      /ggml_webgpu: adapter lacks shader-f16/iu.test(line) ||
      /ggml_webgpu: no adapter with shader-f16/iu.test(line) ||
      /ggml_webgpu: giving up on WebGPU/iu.test(line) ||
      /ggml_webgpu: Failed to get a device after retries/iu.test(line) ||
      /ggml_webgpu: correctness probe failed/iu.test(line) ||
      /ggml_webgpu: .*WebGPU backend disabled/iu.test(line)
    ) {
      sawFinalFailure = true;
    }
    if (/load_tensors:/u.test(line)) loadedTensors = true;
  }
  if (offloaded) return offloaded;
  // A probe failure is logged after `device ready`, then the device is dropped.
  // Treating ready as success here left status at WebGPU/16-parallel while the
  // model actually ran on the CPU.
  if (sawFinalFailure) return 'missing';
  if (sawDeviceReady) return 'unknown';
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

  lastWebGpuLines = [];
  try {
    await wllama.loadModel([file], {
      n_ctx: selection.nCtx,
      n_threads: selection.nThreads,
      n_gpu_layers: selection.nGpuLayers,
      n_parallel: selection.nParallel,
      /**
       * Ask llama.cpp for its full-size SWA cache.
       *
       * PLaMo 3 declares `attention.sliding_window: 2048`, so by default llama.cpp sizes the
       * SWA half of the attention cache to that window. The flag is kept for the measured
       * speed, not for the allocation: long-article fixture, `pnpm bench:live`, 4
       * interleaved rounds on an RTX 4070 Ti SUPER, first visible paragraph 813 ms -> 326 ms
       * and full page 19489 ms -> 15863 ms. Twenty-four paragraphs back to back: 15560 ms ->
       * 11088 ms.
       *
       * The gain is in prompt processing, not decode: a fixed 50-token prompt on the shipped
       * options went from a 155 ms median to 52 ms while predicted time did not move, and the
       * effect also appears on a single sequence with `n_gpu_layers` 0.
       *
       * What this is not: at this tier's options — `n_ctx` 4096 over two sequences, so
       * `n_ctx_seq` 2048 — llama.cpp reports the same SWA cache either way, 2048 cells and a
       * 28 MiB WebGPU buffer, because it already sizes the window as
       * `min(n_ctx_seq, n_swa + n_ubatch)`. Do not describe the gain as the rotation
       * disappearing: the allocation is identical, and the saving upstream's `--swa-full`
       * gives other models is not what is being measured here. The window the model can see
       * is unchanged either way, since every token a sequence could reach was already inside
       * it.
       */
      swa_full: true,
      ...(selection.nParallel > 1 ? { cont_batching: true } : {}),
      ctx_shift: false,
      log_level: LOG_LEVEL_INFO,
    });
  } catch (error) {
    log.stop();
    lastWebGpuLines = log.lines.slice();
    await wllama.exit().catch(() => undefined);
    throw new EngineError('model-load-failed', 'The translation model could not be loaded.', {
      cause: error,
      detail:
        gpuFailureExcerpt(log.lines) ?? (error instanceof Error ? error.message : String(error)),
    });
  }
  log.stop();
  lastWebGpuLines = log.lines.slice();

  if (selection.backend === 'webgpu' && gpuEvidence(log.lines) === 'missing') {
    await wllama.exit().catch(() => undefined);
    const detail = gpuFailureExcerpt(log.lines);
    throw new EngineError(
      'gpu-unavailable',
      'WebGPU was requested but llama.cpp did not place the model on a GPU.',
      detail ? { detail } : undefined,
    );
  }

  const gate = new CompletionGate(selection.nParallel);
  // The first request to see the abort fails the others too: reloading terminates the worker,
  // and a request still waiting on it would never settle.
  let reportLoss: (error: unknown) => void = () => undefined;
  const lost = new Promise<never>((_resolve, reject) => {
    reportLoss = reject;
  });
  lost.catch(() => undefined);

  return {
    backend: selection.backend,
    threads: selection.nThreads,
    parallel: selection.nParallel,
    async complete(request: CompletionRequest): Promise<void> {
      await gate.exclusive(async () => {
        if (request.signal.aborted) throw abortError();
        try {
          await Promise.race([
            lost,
            wllama.createCompletion({
              prompt: request.prompt,
              max_tokens: request.maxTokens,
              temperature: 0,
              // A finished request that asks for no reuse gives back its cells (patch 0005); cells
              // left by idle slots would widen every attention step of the requests still running.
              cache_prompt: selection.nParallel === 1,
              stop: [...TRANSLATION_STOP_TOKENS],
              stream: true,
              onData: (chunk) => {
                forwardCompletionToken(request.signal, chunk.choices?.[0]?.text, request.onToken);
              },
            }),
          ]);
          if (request.signal.aborted) throw abortError();
        } catch (error) {
          if (isAbortError(error) || request.signal.aborted) throw abortError();
          if (selection.backend === 'webgpu' && isRuntimeDead(error)) {
            reportLoss(error);
            throw new EngineError('gpu-lost', 'The GPU stopped working.', { cause: error });
          }
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
