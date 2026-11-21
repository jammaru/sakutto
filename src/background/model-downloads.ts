import type { EngineClient } from '@/background/engine-client';
import { shouldWarmDownloadedModel } from '@/background/progress-broadcast';
import { getModel, type ModelId } from '@/engine/model/catalog';
import type { ModelStatus } from '@/shared/engine-status';
import type { ModelProgressMessage } from '@/shared/messages';

interface DownloadHandle {
  controller: AbortController;
  attachOnly: boolean;
  initial: Promise<ModelStatus | null>;
  initialPending: boolean;
  settleInitial: (status: ModelStatus | null) => void;
  lastStatus: ModelStatus | null;
}

/** Own the service-worker side of model downloads across attach, cancel, and resume. */
export class ModelDownloads {
  private readonly downloads = new Map<ModelId, DownloadHandle>();

  constructor(
    private readonly client: EngineClient,
    private readonly broadcast: (message: ModelProgressMessage) => Promise<void>,
  ) {}

  start(modelId: ModelId, options: { attachOnly?: boolean } = {}): boolean {
    this.getOrStart(modelId, options);
    return true;
  }

  attach(modelId: ModelId): Promise<ModelStatus | null> {
    const existing = this.downloads.get(modelId);
    if (existing?.initialPending && existing.attachOnly) return existing.initial;
    if (existing) return this.client.modelStatus(modelId);
    return this.getOrStart(modelId, { attachOnly: true }).initial;
  }

  async cancel(modelId: ModelId): Promise<void> {
    const cancellation = this.client.cancelModel(modelId).catch(() => undefined);
    const download = this.downloads.get(modelId);
    if (download) {
      this.downloads.delete(modelId);
      download.controller.abort();
      download.settleInitial(null);
      if (download.lastStatus) {
        await this.broadcast({
          type: 'model:progress',
          status: { ...download.lastStatus, state: 'partial' },
        });
      }
    }
    await cancellation;
  }

  /** Model deletion has its own host request; only detach the local transfer here. */
  abort(modelId: ModelId): void {
    const download = this.downloads.get(modelId);
    if (!download) return;
    this.downloads.delete(modelId);
    download.controller.abort();
    download.settleInitial(null);
  }

  private getOrStart(modelId: ModelId, options: { attachOnly?: boolean }): DownloadHandle {
    const existing = this.downloads.get(modelId);
    if (existing && (options.attachOnly || !existing.attachOnly)) return existing;
    if (existing) {
      // An explicit Download upgrades a read-only attach without cancelling the host's live
      // operation. The new request attaches to that operation or starts one if none exists.
      this.downloads.delete(modelId);
      existing.controller.abort();
      existing.settleInitial(null);
    }

    const controller = new AbortController();
    let settleInitial!: (status: ModelStatus | null) => void;
    const initial = new Promise<ModelStatus | null>((resolve) => {
      settleInitial = resolve;
    });
    const download: DownloadHandle = {
      controller,
      attachOnly: options.attachOnly === true,
      initial,
      initialPending: true,
      settleInitial: (status) => {
        if (!download.initialPending) return;
        download.initialPending = false;
        settleInitial(status);
      },
      lastStatus: null,
    };
    this.downloads.set(modelId, download);
    void this.run(modelId, download, options);
    return download;
  }

  private isCurrent(modelId: ModelId, download: DownloadHandle): boolean {
    return this.downloads.get(modelId) === download && !download.controller.signal.aborted;
  }

  private async run(
    modelId: ModelId,
    download: DownloadHandle,
    options: { attachOnly?: boolean },
  ): Promise<void> {
    const { controller } = download;
    const total = getModel(modelId).size;
    let received = 0;

    try {
      const status = await this.client.downloadModel(modelId, {
        signal: controller.signal,
        ...(options.attachOnly ? { attachOnly: true } : {}),
        onProgress: (progress) => {
          if (!this.isCurrent(modelId, download)) return;
          received = progress.received;
          download.lastStatus = progress;
          download.settleInitial(progress);
          void this.broadcast({ type: 'model:progress', status: progress });
        },
      });
      if (!this.isCurrent(modelId, download)) return;
      download.lastStatus = status;
      download.settleInitial(status);
      await this.broadcast({ type: 'model:progress', status });
      if (!this.isCurrent(modelId, download)) return;
      const current = await this.client.status().catch(() => null);
      if (!this.isCurrent(modelId, download)) return;
      if (shouldWarmDownloadedModel(status, current?.model ?? null)) {
        const warmed = await this.client.warmModel().catch(() => null);
        if (warmed && this.isCurrent(modelId, download)) {
          await this.broadcast({ type: 'model:progress', status: warmed });
        }
      }
    } catch (error) {
      download.settleInitial(null);
      if (!this.isCurrent(modelId, download)) return;
      await this.broadcast({
        type: 'model:progress',
        status: {
          id: modelId,
          state: 'error',
          received,
          total,
          progress: Math.min(1, received / total),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      download.settleInitial(null);
      if (this.downloads.get(modelId) === download) this.downloads.delete(modelId);
    }
  }
}
