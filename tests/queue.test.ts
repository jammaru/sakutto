import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translationPriority } from '@/dom/priority';
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
    const scheduler = new JobScheduler(4, 'wave');
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

  it('starts every free slot at once when waves are off', async () => {
    const scheduler = new JobScheduler(4, 'pool');
    const gates = [deferred(), deferred(), deferred(), deferred()];
    for (const gate of gates) {
      scheduler.schedule({
        priority: 10,
        run: () => gate.promise,
      });
    }
    expect(scheduler.runningCount).toBe(4);
    for (const gate of gates) gate.resolve();
    await scheduler.waitForIdle();
    expect(scheduler.runningCount).toBe(0);
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

  it('cancels a running worse-priority job when a live caption preempts', async () => {
    const scheduler = new JobScheduler(1);
    const order: string[] = [];
    const pageGate = deferred();

    scheduler.schedule({
      priority: 10,
      cancel: () => pageGate.resolve(),
      run: async () => {
        order.push('page-start');
        await pageGate.promise;
        order.push('page-end');
      },
    });
    await tick();
    expect(order).toEqual(['page-start']);

    scheduler.schedule({
      priority: 2,
      preempt: true,
      run: async () => {
        order.push('live');
      },
    });
    await scheduler.waitForIdle();
    expect(order).toEqual(['page-start', 'page-end', 'live']);
  });
});

const SCREEN_PROSE = translationPriority('visible', 0, 'prose');
const LAST_SCREEN_PROSE = translationPriority('visible', 2000, 'prose');
const NEAR_PROSE = translationPriority('near', 0, 'prose');
const SCREEN_MENU = translationPriority('visible', 0, 'chrome');

/** Under the fake timers of the staged tests: lets finished jobs hand their slots on. */
const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

/** Jobs that run until the test ends them, in the order the scheduler started them. */
function heldJobs(scheduler: JobScheduler): {
  started: string[];
  add: (name: string, priority: number) => void;
  produce: (...names: string[]) => void;
  produceRunning: () => void;
  end: (...names: string[]) => Promise<void>;
  endAll: () => Promise<void>;
} {
  const started: string[] = [];
  const open = new Map<string, { produce: () => void; end: () => void }>();
  const end = async (...names: string[]): Promise<void> => {
    for (const name of names) {
      open.get(name)?.end();
      open.delete(name);
    }
    await settle();
  };
  return {
    started,
    add: (name, priority) => {
      scheduler.schedule({
        priority,
        run: (producing) =>
          new Promise<void>((resolve) => {
            started.push(name);
            open.set(name, { produce: producing, end: resolve });
          }),
      });
    },
    produce: (...names) => {
      for (const name of names) open.get(name)?.produce();
    },
    // Only the jobs that are running now: a job this starts has produced nothing yet.
    produceRunning: () => {
      for (const job of [...open.values()]) job.produce();
    },
    end,
    endAll: async () => {
      while (open.size > 0) await end(...open.keys());
      await scheduler.waitForIdle();
    },
  };
}

describe('JobScheduler in staged mode', () => {
  // The stage timeout must not move a start on while a test is waiting.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts one job, then four, then every slot as the running jobs produce output', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const jobs = heldJobs(scheduler);
    for (let index = 0; index < 20; index += 1) jobs.add(`near-${index}`, NEAR_PROSE);

    expect(jobs.started).toEqual(['near-0']);
    jobs.produce('near-0');
    expect(scheduler.runningCount).toBe(4);
    jobs.produce('near-1', 'near-2');
    expect(scheduler.runningCount).toBe(4);
    jobs.produce('near-3');
    expect(scheduler.runningCount).toBe(16);

    await jobs.endAll();
  });

  it('waits for the jobs that joined, however much the first one goes on to produce', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const jobs = heldJobs(scheduler);
    for (let index = 0; index < 20; index += 1) jobs.add(`near-${index}`, NEAR_PROSE);

    for (let token = 0; token < 10; token += 1) jobs.produce('near-0');
    expect(scheduler.runningCount).toBe(4);

    jobs.produce('near-1', 'near-2', 'near-3');
    expect(scheduler.runningCount).toBe(16);

    await jobs.endAll();
  });

  it('goes through the stages at once when every job produces as it starts', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const ends: Array<() => void> = [];
    let peak = 0;
    for (let index = 0; index < 20; index += 1) {
      scheduler.schedule({
        priority: NEAR_PROSE,
        run: (producing) => {
          producing();
          peak = Math.max(peak, scheduler.runningCount);
          return new Promise<void>((resolve) => {
            ends.push(resolve);
          });
        },
      });
    }
    expect(scheduler.runningCount).toBe(16);
    expect(peak).toBe(16);

    while (ends.length > 0) {
      for (const end of ends.splice(0)) end();
      await settle();
    }
    expect(scheduler.runningCount).toBe(0);
  });

  it('gives a free slot to the next job without waiting for the others to finish', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const jobs = heldJobs(scheduler);
    for (let index = 0; index < 20; index += 1) jobs.add(`near-${index}`, NEAR_PROSE);
    jobs.produceRunning();
    jobs.produceRunning();
    expect(jobs.started).toHaveLength(16);

    await jobs.end('near-3');
    expect(scheduler.runningCount).toBe(16);
    expect(jobs.started.at(-1)).toBe('near-16');

    await jobs.endAll();
  });

  it('does not keep a stage open for a job that ended without output', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const jobs = heldJobs(scheduler);
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) jobs.add(name, NEAR_PROSE);

    await jobs.end('a');
    expect(jobs.started).toEqual(['a', 'b']);

    jobs.produce('b');
    expect(jobs.started).toEqual(['a', 'b', 'c', 'd', 'e']);
    jobs.produce('c', 'd');
    expect(jobs.started).toHaveLength(5);

    await jobs.end('e');
    expect(jobs.started).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

    await jobs.endAll();
  });

  it('ends a stage two seconds after it began when a job produces nothing', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const jobs = heldJobs(scheduler);
    for (let index = 0; index < 6; index += 1) jobs.add(`near-${index}`, NEAR_PROSE);

    expect(jobs.started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(jobs.started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(jobs.started).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(jobs.started).toHaveLength(6);

    await jobs.endAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes a small first screen before the rest of the page starts', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const jobs = heldJobs(scheduler);
    for (let index = 0; index < 4; index += 1) jobs.add(`screen-${index}`, SCREEN_PROSE);
    jobs.add('screen-4', LAST_SCREEN_PROSE);
    for (let index = 0; index < 6; index += 1) jobs.add(`near-${index}`, NEAR_PROSE);
    jobs.add('menu', SCREEN_MENU);

    jobs.produceRunning();
    jobs.produceRunning();
    expect(jobs.started).toEqual(['screen-0', 'screen-1', 'screen-2', 'screen-3', 'screen-4']);

    await jobs.end('screen-0', 'screen-1', 'screen-2', 'screen-3');
    expect(jobs.started).toHaveLength(5);

    await jobs.end('screen-4');
    expect(scheduler.runningCount).toBe(7);

    await jobs.endAll();
  });

  it('fills the first four starts a small first screen left, but not a slot it frees', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const jobs = heldJobs(scheduler);
    for (let index = 0; index < 3; index += 1) jobs.add(`screen-${index}`, SCREEN_PROSE);
    for (let index = 0; index < 4; index += 1) jobs.add(`near-${index}`, NEAR_PROSE);

    jobs.produceRunning();
    jobs.produceRunning();
    expect(jobs.started).toEqual(['screen-0', 'screen-1', 'screen-2', 'near-0']);

    await jobs.end('screen-0');
    expect(jobs.started).toHaveLength(4);

    await jobs.end('screen-1', 'screen-2');
    expect(jobs.started).toEqual([
      'screen-0',
      'screen-1',
      'screen-2',
      'near-0',
      'near-1',
      'near-2',
      'near-3',
    ]);

    await jobs.endAll();
  });

  it('lets the rest of the page join a large first screen after the staged start', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const jobs = heldJobs(scheduler);
    for (let index = 0; index < 8; index += 1) jobs.add(`screen-${index}`, SCREEN_PROSE);
    for (let index = 0; index < 10; index += 1) jobs.add(`near-${index}`, NEAR_PROSE);

    jobs.produceRunning();
    expect(jobs.started).toEqual(['screen-0', 'screen-1', 'screen-2', 'screen-3']);
    jobs.produceRunning();
    expect(scheduler.runningCount).toBe(16);
    expect(jobs.started).toContain('near-7');

    await jobs.endAll();
  });

  it('keeps a small first screen apart when background work was running first', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const jobs = heldJobs(scheduler);
    jobs.add('warm', 99);
    for (let index = 0; index < 2; index += 1) jobs.add(`screen-${index}`, SCREEN_PROSE);
    for (let index = 0; index < 6; index += 1) jobs.add(`near-${index}`, NEAR_PROSE);

    jobs.produceRunning();
    jobs.produceRunning();
    expect(jobs.started).toEqual(['warm', 'screen-0', 'screen-1', 'near-0']);

    await jobs.end('screen-0', 'screen-1');
    expect(jobs.started).toHaveLength(9);

    await jobs.endAll();
  });

  it('starts no more background work while a foreground job that came later runs', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const jobs = heldJobs(scheduler);
    for (let index = 0; index < 8; index += 1) jobs.add(`near-${index}`, NEAR_PROSE);
    jobs.produceRunning();
    jobs.produceRunning();
    expect(scheduler.runningCount).toBe(8);

    // It joins the eight that are running. What is new waits for it.
    jobs.add('selection', 0);
    jobs.add('near-8', NEAR_PROSE);
    expect(jobs.started.at(-1)).toBe('selection');
    await jobs.end('near-0');
    expect(jobs.started.at(-1)).toBe('selection');

    await jobs.end('selection');
    expect(jobs.started.at(-1)).toBe('near-8');

    await jobs.endAll();
  });

  it('does not hold the page again for a late job once the first screen is done', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const jobs = heldJobs(scheduler);
    for (let index = 0; index < 2; index += 1) jobs.add(`screen-${index}`, SCREEN_PROSE);
    for (let index = 0; index < 6; index += 1) jobs.add(`near-${index}`, NEAR_PROSE);
    jobs.produceRunning();
    jobs.produceRunning();
    await jobs.end('screen-0', 'screen-1');
    expect(scheduler.runningCount).toBe(6);

    jobs.add('late', SCREEN_PROSE);
    jobs.add('near-6', NEAR_PROSE);
    expect(jobs.started.slice(-2)).toEqual(['late', 'near-6']);

    await jobs.endAll();
  });

  it('starts in stages again once it has been idle', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const jobs = heldJobs(scheduler);
    for (let index = 0; index < 6; index += 1) jobs.add(`first-${index}`, NEAR_PROSE);
    jobs.produceRunning();
    jobs.produceRunning();
    expect(scheduler.runningCount).toBe(6);
    await jobs.endAll();

    for (let index = 0; index < 3; index += 1) jobs.add(`screen-${index}`, SCREEN_PROSE);
    for (let index = 0; index < 3; index += 1) jobs.add(`second-${index}`, NEAR_PROSE);
    expect(scheduler.runningCount).toBe(1);
    jobs.produceRunning();
    jobs.produceRunning();
    expect(jobs.started.slice(6)).toEqual(['screen-0', 'screen-1', 'screen-2', 'second-0']);

    await jobs.endAll();
  });

  it('follows a new slot count', async () => {
    const scheduler = new JobScheduler(2, 'staged');
    const jobs = heldJobs(scheduler);
    for (let index = 0; index < 6; index += 1) jobs.add(`near-${index}`, NEAR_PROSE);
    jobs.produceRunning();
    jobs.produceRunning();
    expect(scheduler.runningCount).toBe(2);

    scheduler.setConcurrency(16);
    expect(scheduler.runningCount).toBe(6);

    await jobs.endAll();
  });

  /** Page jobs that end when they are cancelled, and a live caption that preempts them. */
  function preemptedPage(scheduler: JobScheduler): {
    started: string[];
    cancelled: () => number;
    produceFirst: () => void;
    produceAll: () => void;
    live: () => void;
    endAll: () => void;
  } {
    const started: string[] = [];
    const produces: Array<() => void> = [];
    const gates: Array<{ resolve: () => void }> = [];
    let cancelled = 0;
    for (let index = 0; index < 6; index += 1) {
      const gate = deferred();
      gates.push(gate);
      scheduler.schedule({
        priority: NEAR_PROSE,
        cancel: () => {
          cancelled += 1;
          gate.resolve();
        },
        run: async (producing) => {
          started.push(`page-${index}`);
          produces.push(producing);
          await gate.promise;
        },
      });
    }
    return {
      started,
      cancelled: () => cancelled,
      produceFirst: () => produces[0]?.(),
      produceAll: () => {
        for (const produce of [...produces]) produce();
      },
      live: () => {
        scheduler.schedule({
          priority: 1,
          preempt: true,
          run: async () => void started.push('live'),
        });
      },
      endAll: () => {
        for (const gate of gates) gate.resolve();
      },
    };
  }

  it('lets a live caption cancel the running page jobs and take a free slot at once', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const page = preemptedPage(scheduler);
    page.produceAll();
    page.produceAll();
    expect(page.started).toHaveLength(6);

    page.live();
    expect(page.cancelled()).toBe(6);
    expect(page.started.at(-1)).toBe('live');

    await scheduler.waitForIdle();
  });

  it('starts a live caption ahead of the page once a full stage has been cancelled', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const page = preemptedPage(scheduler);
    page.produceFirst();
    expect(page.started).toHaveLength(4);

    page.live();
    expect(page.cancelled()).toBe(4);
    expect(page.started).toHaveLength(4);

    await settle();
    expect(page.started[4]).toBe('live');

    page.endAll();
    await settle();
    expect(scheduler.runningCount).toBe(0);
  });

  it('is idle with no timer left after its waiting jobs are cancelled', async () => {
    const scheduler = new JobScheduler(16, 'staged');
    const gate = deferred();
    scheduler.schedule({ priority: NEAR_PROSE, run: () => gate.promise });
    const waiting = [1, 2].map(() =>
      scheduler.schedule({ priority: NEAR_PROSE, run: async () => undefined }),
    );
    expect(vi.getTimerCount()).toBe(1);

    for (const handle of waiting) handle.cancel();
    gate.resolve();
    await settle();
    expect(scheduler.runningCount).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the other modes alone when a job produces output', async () => {
    const scheduler = new JobScheduler(4, 'pool');
    const gate = deferred();
    scheduler.schedule({
      priority: NEAR_PROSE,
      run: (producing) => {
        producing();
        return gate.promise;
      },
    });
    expect(vi.getTimerCount()).toBe(0);

    gate.resolve();
    await settle();
    expect(scheduler.runningCount).toBe(0);
  });
});
