import { createSha256, type Sha256Hasher } from './sha256';
import type { HasherWorkerRequest, HasherWorkerResponse } from './sha256-worker-core';

const DEFAULT_QUEUE_BYTES = 32 * 1024 * 1024;

export interface OrderedSha256Hasher {
  /**
   * Enqueues an ordered chunk. Large buffers are transferred to the worker, which detaches
   * their backing `ArrayBuffer`s. Capture `data.byteLength` before calling this method and do
   * not read the buffer or reuse it afterwards.
   */
  update(data: Uint8Array): void;
  /** Resolves once the worker queue has drained below its bound. */
  waitForCapacity(): Promise<void>;
  reset(): void;
  digest(): Promise<{ hex: string; bytes: number }>;
  dispose(): void;
}

interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<HasherWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface CreateOrderedSha256Options {
  preferWasm?: boolean;
  /** Tests and the Node benchmark provide their own worker implementation. */
  workerFactory?: () => WorkerLike;
  maxQueueBytes?: number;
}

interface CapacityWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface DigestWaiter {
  resolve: (result: { hex: string; bytes: number }) => void;
  reject: (error: unknown) => void;
}

function bufferFor(data: Uint8Array): ArrayBuffer {
  if (
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength &&
    data.buffer instanceof ArrayBuffer
  ) {
    return data.buffer;
  }
  const copy = data.slice();
  return copy.buffer as ArrayBuffer;
}

class WorkerOrderedSha256 implements OrderedSha256Hasher {
  private readonly capacityWaiters = new Set<CapacityWaiter>();
  private readonly digestWaiters = new Map<number, DigestWaiter>();
  private readonly worker: WorkerLike;
  private readonly maxQueueBytes: number;
  private inFlightBytes = 0;
  private nextDigestId = 0;
  private fatal: Error | null = null;
  private ready: { resolve: () => void; reject: (error: unknown) => void } | null = null;

  private constructor(worker: WorkerLike, maxQueueBytes: number) {
    this.worker = worker;
    this.maxQueueBytes = maxQueueBytes;
  }

  static async create(
    factory: () => WorkerLike,
    preferWasm: boolean,
    maxQueueBytes: number,
  ): Promise<WorkerOrderedSha256> {
    const client = new WorkerOrderedSha256(factory(), maxQueueBytes);
    try {
      await client.initialize(preferWasm);
      return client;
    } catch (error) {
      client.dispose();
      throw error;
    }
  }

  update(data: Uint8Array): void {
    if (this.fatal) throw this.fatal;
    if (data.byteLength === 0) return;

    const buffer = bufferFor(data);
    this.inFlightBytes += data.byteLength;
    try {
      this.worker.postMessage({ type: 'update', data: buffer } satisfies HasherWorkerRequest, [
        buffer,
      ]);
    } catch (error) {
      this.inFlightBytes -= data.byteLength;
      this.fail(error);
      throw error;
    }
  }

  async waitForCapacity(): Promise<void> {
    while (this.inFlightBytes > this.maxQueueBytes) await this.waitForWake();
  }

  reset(): void {
    if (this.fatal) throw this.fatal;
    this.worker.postMessage({ type: 'reset' } satisfies HasherWorkerRequest);
  }

  async digest(): Promise<{ hex: string; bytes: number }> {
    while (this.inFlightBytes > 0) await this.waitForWake();
    if (this.fatal) throw this.fatal;

    const id = this.nextDigestId;
    this.nextDigestId += 1;
    return new Promise((resolve, reject) => {
      this.digestWaiters.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ type: 'digest', id } satisfies HasherWorkerRequest);
      } catch (error) {
        this.digestWaiters.delete(id);
        this.fail(error);
        reject(error);
      }
    });
  }

  dispose(): void {
    this.shutdown(new Error('The SHA-256 worker was disposed.'));
  }

  private initialize(preferWasm: boolean): Promise<void> {
    this.worker.onmessage = (event) => this.handle(event.data);
    this.worker.onerror = (event) => {
      this.fail(new Error(event.message || 'The SHA-256 worker failed.'));
    };

    return new Promise((resolve, reject) => {
      this.ready = { resolve, reject };
      try {
        this.worker.postMessage({ type: 'init', preferWasm } satisfies HasherWorkerRequest);
      } catch (error) {
        this.ready = null;
        this.fail(error);
        reject(error);
      }
    });
  }

  private handle(message: HasherWorkerResponse): void {
    switch (message.type) {
      case 'ready': {
        const ready = this.ready;
        this.ready = null;
        ready?.resolve();
        return;
      }
      case 'ack':
        this.inFlightBytes = Math.max(0, this.inFlightBytes - message.bytes);
        this.wakeCapacityWaiters();
        return;
      case 'digest': {
        const waiter = this.digestWaiters.get(message.id);
        this.digestWaiters.delete(message.id);
        waiter?.resolve({ hex: message.hex, bytes: message.bytes });
        return;
      }
      case 'error':
        this.fail(new Error(message.message));
        return;
    }
  }

  private async waitForWake(): Promise<void> {
    if (this.fatal) throw this.fatal;
    await new Promise<void>((resolve, reject) => {
      this.capacityWaiters.add({ resolve, reject });
    });
    if (this.fatal) throw this.fatal;
  }

  private wakeCapacityWaiters(): void {
    const waiters = [...this.capacityWaiters];
    this.capacityWaiters.clear();
    for (const waiter of waiters) waiter.resolve();
  }

  private fail(error: unknown): void {
    this.shutdown(error instanceof Error ? error : new Error(String(error)));
  }

  private shutdown(error: Error): void {
    if (this.fatal) return;
    this.fatal = error;

    const ready = this.ready;
    this.ready = null;
    ready?.reject(error);

    const capacityWaiters = [...this.capacityWaiters];
    this.capacityWaiters.clear();
    for (const waiter of capacityWaiters) waiter.reject(error);

    const digestWaiters = [...this.digestWaiters.values()];
    this.digestWaiters.clear();
    for (const waiter of digestWaiters) waiter.reject(error);

    this.worker.terminate();
  }
}

class InlineOrderedSha256 implements OrderedSha256Hasher {
  private readonly hasher: Sha256Hasher;
  private readonly maxQueueBytes: number;
  private readonly capacityWaiters = new Set<CapacityWaiter>();
  private chain: Promise<void> = Promise.resolve();
  private inFlightBytes = 0;
  private bytesHashed = 0;
  private fatal: Error | null = null;

  private constructor(hasher: Sha256Hasher, maxQueueBytes: number) {
    this.hasher = hasher;
    this.maxQueueBytes = maxQueueBytes;
  }

  static async create(preferWasm: boolean, maxQueueBytes: number): Promise<InlineOrderedSha256> {
    return new InlineOrderedSha256(await createSha256({ preferWasm }), maxQueueBytes);
  }

  update(data: Uint8Array): void {
    if (this.fatal) throw this.fatal;
    if (data.byteLength === 0) return;

    const chunk = data.slice();
    this.inFlightBytes += chunk.byteLength;
    this.enqueue(() => {
      this.hasher.update(chunk);
      this.bytesHashed += chunk.byteLength;
      this.inFlightBytes -= chunk.byteLength;
      this.wakeCapacityWaiters();
    });
  }

  async waitForCapacity(): Promise<void> {
    while (this.inFlightBytes > this.maxQueueBytes) await this.waitForWake();
  }

  reset(): void {
    this.enqueue(() => {
      this.hasher.reset();
      this.bytesHashed = 0;
    });
  }

  async digest(): Promise<{ hex: string; bytes: number }> {
    await this.chain;
    if (this.fatal) throw this.fatal;
    return { hex: this.hasher.hex(), bytes: this.bytesHashed };
  }

  dispose(): void {
    this.fatal ??= new Error('The SHA-256 hasher was disposed.');
    this.wakeCapacityWaiters();
  }

  private enqueue(task: () => void): void {
    this.chain = this.chain
      .then(() => {
        if (!this.fatal) task();
      })
      .catch((error: unknown) => {
        this.fatal = error instanceof Error ? error : new Error(String(error));
        this.wakeCapacityWaiters();
      });
  }

  private async waitForWake(): Promise<void> {
    if (this.fatal) throw this.fatal;
    await new Promise<void>((resolve, reject) => {
      this.capacityWaiters.add({ resolve, reject });
    });
    if (this.fatal) throw this.fatal;
  }

  private wakeCapacityWaiters(): void {
    const waiters = [...this.capacityWaiters];
    this.capacityWaiters.clear();
    for (const waiter of waiters) waiter.resolve();
  }
}

/**
 * Creates an ordered streaming hasher. In the extension the chunks are hashed in a dedicated
 * worker; Node tests and any runtime without `Worker` fall back to an inline queue so callers
 * still get an asynchronous, backpressured interface.
 */
export async function createOrderedSha256(
  options: CreateOrderedSha256Options = {},
): Promise<OrderedSha256Hasher> {
  const preferWasm = options.preferWasm ?? true;
  const maxQueueBytes = options.maxQueueBytes ?? DEFAULT_QUEUE_BYTES;
  let factory = options.workerFactory;

  if (!factory && typeof Worker !== 'undefined') {
    try {
      const module = await import('./sha256-worker-factory');
      factory = () => module.createSha256Worker() as unknown as WorkerLike;
    } catch {
      // Keep the inline fallback if the bundled worker module cannot load.
    }
  }

  if (factory) {
    try {
      return await WorkerOrderedSha256.create(factory, preferWasm, maxQueueBytes);
    } catch {
      // A CSP-blocked or failed worker must not break the download; hash inline instead.
    }
  }

  return InlineOrderedSha256.create(preferWasm, maxQueueBytes);
}
