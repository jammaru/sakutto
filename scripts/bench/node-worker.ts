import { Worker as NodeWorkerThread } from 'node:worker_threads';

import type { HasherWorkerResponse } from '../../src/engine/model/sha256-worker-core.ts';

interface WorkerUrl {
  toString(): string;
}

/**
 * The browser downloader hashes in a dedicated Web Worker. Node has no global Worker, so the
 * benchmark supplies this small adapter over `node:worker_threads` to measure the same
 * off-transfer-path design.
 */
class NodeWorkerShim {
  onmessage: ((event: MessageEvent<HasherWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private readonly worker: NodeWorkerThread;

  constructor(url: WorkerUrl, options?: { type?: string }) {
    void url;
    void options;
    this.worker = new NodeWorkerThread(new URL('./sha256-worker-node.ts', import.meta.url));
    this.worker.on('message', (data: HasherWorkerResponse) => {
      this.onmessage?.({ data } as MessageEvent<HasherWorkerResponse>);
    });
    this.worker.on('error', (error: Error) => {
      this.onerror?.({ message: error.message, error } as ErrorEvent);
    });
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.worker.postMessage(message, transfer as never);
  }

  terminate(): void {
    void this.worker.terminate();
  }
}

export function installWorkerShim(): void {
  if (typeof globalThis.Worker !== 'undefined') return;
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: NodeWorkerShim,
  });
}
