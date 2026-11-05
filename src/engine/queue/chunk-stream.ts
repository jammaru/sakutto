type StreamEntry<T> = { kind: 'value'; value: T } | { kind: 'error'; error: unknown };

export class ChunkStream<T> implements AsyncIterable<T> {
  private entries: StreamEntry<T>[] = [];
  private waiters: Array<(entry: StreamEntry<T> | null) => void> = [];
  private finished = false;

  push(value: T): void {
    if (this.finished) return;
    this.deliver({ kind: 'value', value });
  }

  fail(error: unknown): void {
    if (this.finished) return;
    this.deliver({ kind: 'error', error });
    this.end();
  }

  end(): void {
    if (this.finished) return;
    this.finished = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(null);
  }

  next(): Promise<IteratorResult<T>> {
    return this.shift().then((entry) => {
      if (entry === null) return { done: true, value: undefined };
      if (entry.kind === 'error') throw entry.error;
      return { done: false, value: entry.value };
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }

  private deliver(entry: StreamEntry<T>): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(entry);
      return;
    }
    this.entries.push(entry);
  }

  private shift(): Promise<StreamEntry<T> | null> {
    const entry = this.entries.shift();
    if (entry) return Promise.resolve(entry);
    if (this.finished) return Promise.resolve(null);

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
