interface QueueEntry<T> {
  priority: number;
  sequence: number;
  value: T;
}

function precedes<T>(left: QueueEntry<T>, right: QueueEntry<T>): boolean {
  if (left.priority !== right.priority) return left.priority < right.priority;
  return left.sequence < right.sequence;
}

export class PriorityQueue<T> {
  private readonly entries: QueueEntry<T>[] = [];
  private sequence = 0;

  get size(): number {
    return this.entries.length;
  }

  enqueue(value: T, priority: number): void {
    const entry: QueueEntry<T> = { priority, sequence: this.sequence, value };
    this.sequence += 1;
    this.entries.push(entry);
    this.bubbleUp(this.entries.length - 1);
  }

  dequeue(): T | undefined {
    if (this.entries.length === 0) return undefined;

    const first = this.entries[0];
    const last = this.entries.pop();
    if (first === undefined || last === undefined) return undefined;

    if (this.entries.length > 0) {
      this.entries[0] = last;
      this.sinkDown(0);
    }

    return first.value;
  }

  peek(): { value: T; priority: number } | undefined {
    const entry = this.entries[0];
    return entry ? { value: entry.value, priority: entry.priority } : undefined;
  }

  remove(predicate: (value: T) => boolean): number {
    const kept = this.entries.filter((entry) => !predicate(entry.value));
    const removed = this.entries.length - kept.length;
    if (removed === 0) return 0;

    this.entries.length = 0;
    for (const entry of kept.sort((left, right) => left.sequence - right.sequence)) {
      this.enqueue(entry.value, entry.priority);
    }
    return removed;
  }

  clear(): void {
    this.entries.length = 0;
  }

  private bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const entry = this.entries[index];
      const parentEntry = this.entries[parent];
      if (!entry || !parentEntry || !precedes(entry, parentEntry)) break;
      this.entries[parent] = entry;
      this.entries[index] = parentEntry;
      index = parent;
    }
  }

  private sinkDown(start: number): void {
    let index = start;
    const length = this.entries.length;

    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;

      const current = this.entries[smallest];
      const leftEntry = left < length ? this.entries[left] : undefined;
      const rightEntry = right < length ? this.entries[right] : undefined;
      if (!current) return;
      if (leftEntry && precedes(leftEntry, current)) smallest = left;
      const smallestEntry = this.entries[smallest];
      if (smallestEntry && rightEntry && precedes(rightEntry, smallestEntry)) smallest = right;
      if (smallest === index) return;

      const swap = this.entries[smallest];
      if (!swap) return;
      this.entries[smallest] = this.entries[index] as QueueEntry<T>;
      this.entries[index] = swap;
      index = smallest;
    }
  }
}
