import { abortError } from '../errors';
import type { BackendSelection } from '../in-browser/backend';
import type { LlamaRuntime } from '../in-browser/runtime';
import type { LoadedModel } from '../model/manager';
import type { ModelId } from '../model/catalog';

/**
 * True when the loaded runtime can retry a collapsed piece itself. A second
 * wllama instance is only created while WebGPU is still the live backend.
 */
export function canReuseLoadedRuntimeForRetry(
  loaded: LoadedModel | null,
  activeModelId: ModelId,
): boolean {
  return loaded !== null && loaded.id === activeModelId && loaded.runtime.backend !== 'webgpu';
}

export interface CpuRetryRuntimeSlotOptions {
  create: (blob: Blob, selection: BackendSelection) => Promise<LlamaRuntime>;
  modelBlob: (modelId: ModelId) => Promise<Blob>;
  activeModelId: () => ModelId;
  loaded: () => LoadedModel | null;
  cpuSelection: () => BackendSelection | null;
}

/**
 * Extra CPU wllama copy for a collapsed WebGPU piece. Loads are tagged with a
 * generation and the model id they started with: a model-set or idle dispose
 * bumps the generation and returns immediately, and a load that finishes late
 * disposes itself instead of writing the old weights into the live slot.
 */
export class CpuRetryRuntimeSlot {
  private runtime: LlamaRuntime | null = null;
  private task: Promise<LlamaRuntime | null> | null = null;
  private generation = 0;

  constructor(private readonly options: CpuRetryRuntimeSlotOptions) {}

  async load(signal: AbortSignal): Promise<LlamaRuntime | null> {
    const loaded = this.options.loaded();
    if (canReuseLoadedRuntimeForRetry(loaded, this.options.activeModelId()) && loaded) {
      return loaded.runtime;
    }
    if (this.runtime) return this.runtime;
    const cpu = this.options.cpuSelection();
    if (!cpu) return null;
    if (signal.aborted) throw abortError();

    if (!this.task) {
      const generation = this.generation;
      const modelId = this.options.activeModelId();
      const task = this.startLoad(generation, modelId, cpu).finally(() => {
        if (this.task === task) this.task = null;
      });
      this.task = task;
    }
    return this.awaitLoad(this.task, signal);
  }

  /**
   * Drop the live copy without waiting for an in-flight load. Cancel and
   * model-set must not block on `createWllamaRuntime`.
   */
  dispose(): void {
    this.generation += 1;
    const runtime = this.runtime;
    this.runtime = null;
    this.task = null;
    if (runtime) void runtime.dispose().catch(() => undefined);
  }

  private async startLoad(
    generation: number,
    modelId: ModelId,
    cpu: BackendSelection,
  ): Promise<LlamaRuntime | null> {
    const blob = await this.options.modelBlob(modelId);
    if (this.stale(generation, modelId)) throw abortError();
    const runtime = await this.options.create(blob, cpu);
    if (this.stale(generation, modelId)) {
      await runtime.dispose().catch(() => undefined);
      throw abortError();
    }
    this.runtime = runtime;
    if (this.stale(generation, modelId)) {
      if (this.runtime === runtime) this.runtime = null;
      await runtime.dispose().catch(() => undefined);
      throw abortError();
    }
    return runtime;
  }

  private stale(generation: number, modelId: ModelId): boolean {
    return generation !== this.generation || modelId !== this.options.activeModelId();
  }

  private awaitLoad(
    task: Promise<LlamaRuntime | null>,
    signal: AbortSignal,
  ): Promise<LlamaRuntime | null> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<LlamaRuntime | null>((resolve, reject) => {
      const onAbort = (): void => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      task.then(
        (runtime) => {
          signal.removeEventListener('abort', onAbort);
          if (signal.aborted) {
            reject(abortError());
            return;
          }
          resolve(runtime);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }
}
