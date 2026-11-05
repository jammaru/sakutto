import { browser, type Browser } from 'wxt/browser';
import { abortError, EngineError, isAbortError } from '@/engine/errors';
import type { ModelId } from '@/engine/model/catalog';
import {
  ENGINE_HOST_PORT,
  errorFromPayload,
  isEngineHostMessage,
  serializeTranslateOptions,
  type EngineHostRequest,
  type BenchmarkRequest,
  type CacheClearRequest,
  type ModelDeleteRequest,
  type ModelDownloadRequest,
  type ModelStatusRequest,
  type ModelUseRequest,
  type ModelWarmRequest,
  type PingRequest,
  type StatusRequest,
  type TierSetRequest,
  type TranslateRequest,
} from '@/engine/offscreen/protocol';
import { ChunkStream } from '@/engine/queue/chunk-stream';
import type { TranslateOptions, TranslateSegment, TranslationChunk } from '@/engine/types';
import { advanceModelStatus } from '@/shared/model-progress';
import {
  isEngineStatus,
  isModelStatus,
  type EngineStatus,
  type ModelStatus,
} from '@/shared/engine-status';
import type { TierPreference } from '@/shared/settings';
import type { OffscreenController } from './offscreen-lifecycle';

type RequestWithoutId =
  | Omit<StatusRequest, 'requestId'>
  | Omit<PingRequest, 'requestId'>
  | Omit<ModelDownloadRequest, 'requestId'>
  | Omit<ModelDeleteRequest, 'requestId'>
  | Omit<ModelUseRequest, 'requestId'>
  | Omit<ModelWarmRequest, 'requestId'>
  | Omit<ModelStatusRequest, 'requestId'>
  | Omit<CacheClearRequest, 'requestId'>
  | Omit<TierSetRequest, 'requestId'>
  | Omit<BenchmarkRequest, 'requestId'>;

const DOWNLOAD_ATTACH_ATTEMPTS = 3;
const DOWNLOAD_ATTACH_DELAY_MS = 500;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RequestOptions {
  timeoutMs?: number;
  retry?: boolean;
  /** Recreate the offscreen document when a host-gone response leaves attempts unused. */
  recover?: boolean;
}

function createRequestId(): string {
  return crypto.randomUUID();
}

function isMilliseconds(value: unknown): value is { milliseconds: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'milliseconds' in value &&
    typeof value.milliseconds === 'number' &&
    Number.isFinite(value.milliseconds)
  );
}

function hostError(message: string, cause?: unknown): EngineError {
  return new EngineError(
    'offscreen-unavailable',
    message,
    cause === undefined ? undefined : { cause },
  );
}

export class EngineClient {
  private port: Browser.runtime.Port | null = null;
  private connecting: Promise<Browser.runtime.Port> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly streams = new Map<string, ChunkStream<TranslationChunk>>();
  private readonly progress = new Map<string, (status: ModelStatus) => void>();
  private readonly modelMarks = new Map<string, ModelStatus>();

  constructor(private readonly controller: OffscreenController) {}

  async status(): Promise<EngineStatus> {
    const value = await this.request({ type: 'status' }, { timeoutMs: 15_000 });
    if (!isEngineStatus(value)) throw hostError('The engine host returned an invalid status.');
    return value;
  }

  async ensureHost(): Promise<void> {
    await this.controller.ensure();
  }

  async ping(): Promise<void> {
    await this.request({ type: 'ping' }, { timeoutMs: 2_000, retry: false, recover: false });
  }

  async deleteModel(modelId: ModelId): Promise<ModelStatus> {
    const value = await this.request({ type: 'model-delete', modelId }, { timeoutMs: 30_000 });
    if (!isModelStatus(value)) throw hostError('The engine host returned an invalid status.');
    return value;
  }

  async useModel(modelId: ModelId): Promise<ModelStatus> {
    const value = await this.request({ type: 'model-use', modelId }, { timeoutMs: 30_000 });
    if (!isModelStatus(value)) throw hostError('The engine host returned an invalid status.');
    return value;
  }

  async warmModel(): Promise<ModelStatus> {
    const value = await this.request({ type: 'model-warm' }, { timeoutMs: 120_000, retry: false });
    if (!isModelStatus(value)) throw hostError('The engine host returned an invalid status.');
    return value;
  }

  async modelStatus(modelId: ModelId): Promise<ModelStatus> {
    const value = await this.request({ type: 'model-status', modelId }, { timeoutMs: 15_000 });
    if (!isModelStatus(value)) throw hostError('The engine host returned an invalid status.');
    return value;
  }

  async clearCache(): Promise<void> {
    await this.request({ type: 'cache-clear' }, { timeoutMs: 15_000 });
  }

  async setTier(tier: TierPreference): Promise<void> {
    await this.request({ type: 'tier-set', tier }, { timeoutMs: 30_000 });
  }

  async benchmark(): Promise<number | null> {
    const value: unknown = await this.request(
      { type: 'benchmark' },
      { timeoutMs: 60_000, retry: false },
    );
    if (value === null) return null;
    if (!isMilliseconds(value)) throw hostError('The engine host returned an invalid benchmark.');
    return value.milliseconds;
  }

  async downloadModel(
    modelId: ModelId,
    options: { signal: AbortSignal; onProgress?: (status: ModelStatus) => void },
  ): Promise<ModelStatus> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= DOWNLOAD_ATTACH_ATTEMPTS; attempt += 1) {
      const requestId = createRequestId();
      if (options.onProgress) this.progress.set(requestId, options.onProgress);

      const cancel = (): void => {
        this.sendRaw({ type: 'model-cancel', requestId });
      };
      options.signal.addEventListener('abort', cancel, { once: true });

      try {
        const port = await this.connect();
        if (options.signal.aborted) throw abortError();
        const value = await this.roundTrip(port, { type: 'model-download', requestId, modelId }, 0);
        if (!isModelStatus(value)) throw hostError('The engine host returned an invalid status.');
        return value;
      } catch (error) {
        if (options.signal.aborted || isAbortError(error)) throw abortError();
        lastError = error;

        if (!isHostGone(error) || attempt === DOWNLOAD_ATTACH_ATTEMPTS) {
          throw error instanceof EngineError
            ? error
            : hostError('The model download failed.', error);
        }

        // The download keeps running in the offscreen document; reconnect and attach again.
        this.dropPort();
        await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_ATTACH_DELAY_MS));
      } finally {
        options.signal.removeEventListener('abort', cancel);
        this.progress.delete(requestId);
      }
    }

    throw lastError instanceof EngineError
      ? lastError
      : hostError('The model download failed.', lastError);
  }

  async *translate(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncGenerator<TranslationChunk> {
    const requestId = createRequestId();
    const stream = new ChunkStream<TranslationChunk>();
    this.streams.set(requestId, stream);

    let cancelled = false;
    const cancel = (): void => {
      cancelled = true;
      this.sendRaw({ type: 'cancel', requestId });
      stream.end();
    };
    options.signal.addEventListener('abort', cancel, { once: true });

    try {
      const port = await this.connect();
      if (cancelled || options.signal.aborted) return;

      port.postMessage({
        type: 'translate',
        requestId,
        segments: segments.map((segment) => ({ ...segment })),
        options: serializeTranslateOptions(options),
      } satisfies TranslateRequest);

      for await (const chunk of stream) yield chunk;
    } catch (error) {
      if (cancelled || options.signal.aborted || isAbortError(error)) return;
      throw error instanceof EngineError ? error : hostError('The translation host failed.', error);
    } finally {
      options.signal.removeEventListener('abort', cancel);
      this.streams.delete(requestId);
      this.sendRaw({ type: 'cancel', requestId });
    }
  }

  private async request<T>(message: RequestWithoutId, options: RequestOptions = {}): Promise<T> {
    const attempts = options.retry === false ? 1 : 2;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const requestId = createRequestId();

      try {
        const port = await this.connect();
        return (await this.roundTrip(
          port,
          { ...message, requestId } as EngineHostRequest,
          options.timeoutMs ?? 10_000,
        )) as T;
      } catch (error) {
        lastError = error;
        if (!isHostGone(error)) throw error;

        this.dropPort();
        if (attempt + 1 >= attempts) throw error;
        if (options.recover !== false) await this.controller.recreate();
      }
    }

    throw lastError instanceof Error ? lastError : hostError('The translation host failed.');
  }

  private connect(): Promise<Browser.runtime.Port> {
    if (this.port) return Promise.resolve(this.port);

    this.connecting ??= (async () => {
      await this.controller.ensure();

      let port: Browser.runtime.Port;
      try {
        port = browser.runtime.connect({ name: ENGINE_HOST_PORT });
      } catch (error) {
        throw hostError('The translation host could not be opened.', error);
      }

      port.onMessage.addListener((message: unknown) => this.handleMessage(message));
      port.onDisconnect.addListener(() => {
        if (this.port === port) this.handleDisconnect();
      });
      this.port = port;
      return port;
    })().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private roundTrip(
    port: Browser.runtime.Port,
    message: EngineHostRequest,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(message.requestId);
              reject(hostError('The translation host did not respond in time.'));
            }, timeoutMs)
          : null;

      this.pending.set(message.requestId, { resolve, reject, timer });

      try {
        port.postMessage(message);
      } catch (error) {
        this.pending.delete(message.requestId);
        if (timer) clearTimeout(timer);
        reject(hostError('The translation host is not reachable.', error));
      }
    });
  }

  private handleMessage(message: unknown): void {
    if (!isEngineHostMessage(message)) return;

    switch (message.type) {
      case 'chunk': {
        this.streams.get(message.requestId)?.push(message.chunk);
        return;
      }
      case 'done': {
        const stream = this.streams.get(message.requestId);
        if (stream) {
          this.streams.delete(message.requestId);
          stream.end();
        }
        return;
      }
      case 'error': {
        const stream = this.streams.get(message.requestId);
        if (stream) {
          this.streams.delete(message.requestId);
          stream.fail(errorFromPayload(message.error));
        }
        return;
      }
      case 'model-progress': {
        const next = advanceModelStatus(
          this.modelMarks.get(message.status.id) ?? null,
          message.status,
        );
        this.modelMarks.set(next.id, next);
        this.progress.get(message.requestId)?.(next);
        return;
      }
      case 'response': {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(errorFromPayload(message.error));
        return;
      }
    }
  }

  private handleDisconnect(): void {
    this.port = null;
    this.failAll(hostError('The translation host was closed.'));
  }

  private dropPort(): void {
    const port = this.port;
    this.port = null;
    try {
      port?.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  private failAll(error: EngineError): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();

    for (const stream of this.streams.values()) stream.fail(error);
    this.streams.clear();
    this.progress.clear();
  }

  private sendRaw(message: EngineHostRequest): void {
    try {
      this.port?.postMessage(message);
    } catch {
      // The port is gone; the disconnect handler settles the streams.
    }
  }
}

function isHostGone(error: unknown): boolean {
  return error instanceof EngineError && error.code === 'offscreen-unavailable';
}
