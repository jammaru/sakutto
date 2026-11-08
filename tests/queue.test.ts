import { describe, expect, it, vi } from 'vitest';
import { PriorityQueue } from '@/engine/queue/priority-queue';
import { JobScheduler } from '@/engine/queue/scheduler';

describe('PriorityQueue', () => {
  it('returns lower priority values first and preserves FIFO order within a priority', () => {
    const queue = new PriorityQueue<string>();
    queue.enqueue('normal-1', 20);
    queue.enqueue('selection', 0);
    queue.enqueue('normal-2', 20);
    queue.enqueue('viewport', 10);

    expect([queue.dequeue(), queue.dequeue(), queue.dequeue(), queue.dequeue()]).toEqual([
      'selection',
      'viewport',
      'normal-1',
      'normal-2',
    ]);
    expect(queue.dequeue()).toBeUndefined();
  });

  it('removes matching entries without disturbing the remaining order', () => {
    const queue = new PriorityQueue<string>();
    queue.enqueue('a', 10);
    queue.enqueue('b', 10);
    queue.enqueue('c', 10);
    queue.enqueue('d', 5);

    expect(queue.remove((value) => value === 'b')).toBe(1);
    expect(queue.size).toBe(3);
    expect([queue.dequeue(), queue.dequeue(), queue.dequeue()]).toEqual(['d', 'a', 'c']);
  });

  it('exposes the next entry and clears in bulk', () => {
    const queue = new PriorityQueue<number>();
    queue.enqueue(1, 30);
    queue.enqueue(2, 10);

    expect(queue.peek()).toEqual({ value: 2, priority: 10 });
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.peek()).toBeUndefined();
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('JobScheduler', () => {
  it('starts waves together, ramps up the first ones, and holds the next until a wave ends', async () => {
    const scheduler = new JobScheduler(4, true);
    const releases: Array<() => void> = [];
    let running = 0;
    const started: number[] = [];
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

    for (let index = 0; index < 9; index += 1) {
      scheduler.schedule({
        priority: 10,
        run: () =>
          new Promise<void>((resolve) => {
            running += 1;
            started.push(index);
            releases.push(() => {
              running -= 1;
              resolve();
            });
          }),
      });
    }

    await tick();
    expect(running).toBe(1);
    releases.shift()?.();
    await tick();
    expect(running).toBe(4);
    expect(started).toEqual([0, 1, 2, 3, 4]);

    releases.shift()?.();
    await tick();
    expect(running).toBe(3);
    expect(started).toHaveLength(5);

    while (releases.length > 0) releases.shift()?.();
    await tick();
    expect(running).toBe(4);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

    while (releases.length > 0) releases.shift()?.();
    await scheduler.waitForIdle();
    expect(running).toBe(0);
  });

  it('runs no more jobs than the concurrency limit', async () => {
    const scheduler = new JobScheduler(2);
    let active = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred()];

    for (const gate of gates) {
      scheduler.schedule({
        priority: 10,
        run: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await gate.promise;
          active -= 1;
        },
      });
    }

    await tick();
    expect(scheduler.runningCount).toBe(2);
    expect(scheduler.pendingCount).toBe(1);

    gates[0]?.resolve();
    await tick();
    expect(scheduler.runningCount).toBe(2);

    gates[1]?.resolve();
    gates[2]?.resolve();
    await scheduler.waitForIdle();
    expect(peak).toBe(2);
  });

  it('starts higher priority jobs first when a slot frees up', async () => {
    const scheduler = new JobScheduler(1);
    const order: string[] = [];
    const gate = deferred();

    scheduler.schedule({
      priority: 10,
      run: async () => {
        order.push('blocker');
        await gate.promise;
      },
    });
    scheduler.schedule({ priority: 30, run: async () => void order.push('prefetch') });
    scheduler.schedule({ priority: 0, run: async () => void order.push('selection') });

    await tick();
    gate.resolve();
    await scheduler.waitForIdle();

    expect(order).toEqual(['blocker', 'selection', 'prefetch']);
  });

  it('does not run a job cancelled while queued', async () => {
    const scheduler = new JobScheduler(1);
    const gate = deferred();
    const run = vi.fn(async () => undefined);

    scheduler.schedule({ priority: 10, run: async () => gate.promise });
    const handle = scheduler.schedule({ priority: 10, run });

    handle.cancel();
    gate.resolve();
    await scheduler.waitForIdle();

    expect(run).not.toHaveBeenCalled();
  });

  it('asks a running job to cancel when its handle is cancelled', async () => {
    const scheduler = new JobScheduler(1);
    const cancel = vi.fn();
    const gate = deferred();

    const handle = scheduler.schedule({
      priority: 10,
      run: async () => gate.promise,
      cancel,
    });

    await tick();
    handle.cancel();
    expect(cancel).toHaveBeenCalledOnce();

    gate.resolve();
    await scheduler.waitForIdle();
  });

  it('lets the current job finish and runs a selection before queued page work', async () => {
    const scheduler = new JobScheduler(1);
    const order: string[] = [];
    const gate = deferred();

    scheduler.schedule({
      priority: 10,
      cancel: () => order.push('cancelled'),
      run: async () => {
        order.push('page');
        await gate.promise;
      },
    });
    scheduler.schedule({ priority: 30, run: async () => void order.push('later') });
    await tick();
    scheduler.schedule({ priority: 0, run: async () => void order.push('selection') });
    await tick();

    expect(order).toEqual(['page']);
    gate.resolve();
    await scheduler.waitForIdle();
    expect(order).toEqual(['page', 'selection', 'later']);
  });
});
