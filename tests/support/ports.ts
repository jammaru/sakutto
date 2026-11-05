import type { Browser } from 'wxt/browser';

export interface FakePortOptions {
  name?: string;
  sender?: { id?: string; tab?: unknown };
}

export class FakePort {
  readonly name: string;
  readonly sender: { id?: string; tab?: unknown };
  readonly sent: unknown[] = [];
  private readonly messageListeners: Array<(message: unknown, port: Browser.runtime.Port) => void> =
    [];
  private readonly disconnectListeners: Array<() => void> = [];
  private connected = true;

  constructor(options: FakePortOptions = {}) {
    this.name = options.name ?? 'sakutto:engine-host';
    this.sender = options.sender ?? { id: 'test-extension' };
  }

  readonly onMessage = {
    addListener: (listener: (message: unknown, port: Browser.runtime.Port) => void): void => {
      this.messageListeners.push(listener);
    },
  };

  readonly onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectListeners.push(listener);
    },
  };

  postMessage(message: unknown): void {
    if (!this.connected) throw new Error('Port is disconnected.');
    this.sent.push(message);
  }

  emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message, this.port);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const listener of this.disconnectListeners) listener();
  }

  messagesOfType(type: string): unknown[] {
    return this.sent.filter(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === type,
    );
  }

  get port(): Browser.runtime.Port {
    return this as unknown as Browser.runtime.Port;
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function flushTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
