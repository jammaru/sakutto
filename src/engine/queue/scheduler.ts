import { PriorityQueue } from './priority-queue';

export interface SchedulerJob {
  priority: number;
  run: () => Promise<void>;
  cancel?: () => void;
}

export interface ScheduledHandle {
  cancel(): void;
}

type JobState = 'queued' | 'running' | 'finished';

interface QueuedJob {
  job: SchedulerJob;
  state: JobState;
}

export class JobScheduler {
  private readonly queue = new PriorityQueue<QueuedJob>();
  private readonly active = new Set<QueuedJob>();
  private running = 0;
  private limit: number;
  private idleWaiters: Array<() => void> = [];

  constructor(concurrency = 1) {
    this.limit = Math.max(1, Math.floor(concurrency));
  }

  get pendingCount(): number {
    return this.queue.size;
  }

  get runningCount(): number {
    return this.running;
  }

  get concurrency(): number {
    return this.limit;
  }

  setConcurrency(concurrency: number): void {
    this.limit = Math.max(1, Math.floor(concurrency));
    this.pump();
  }

  schedule(job: SchedulerJob): ScheduledHandle {
    const entry: QueuedJob = { job, state: 'queued' };
    this.queue.enqueue(entry, job.priority);
    this.pump();

    return {
      cancel: () => {
        if (entry.state === 'queued') {
          this.queue.remove((candidate) => candidate === entry);
          entry.state = 'finished';
          this.notifyIdle();
        } else if (entry.state === 'running') {
          entry.job.cancel?.();
        }
      },
    };
  }

  waitForIdle(): Promise<void> {
    if (this.running === 0 && this.queue.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private pump(): void {
    while (this.running < this.limit) {
      const entry = this.queue.dequeue();
      if (!entry) break;
      if (entry.state !== 'queued') continue;

      entry.state = 'running';
      this.running += 1;
      this.active.add(entry);
      void this.run(entry);
    }

    this.notifyIdle();
  }

  private async run(entry: QueuedJob): Promise<void> {
    try {
      await entry.job.run();
    } catch {
      // Jobs report their own failures; the scheduler only tracks slots.
    } finally {
      this.active.delete(entry);
      entry.state = 'finished';
      this.running -= 1;
      this.pump();
    }
  }

  private notifyIdle(): void {
    if (this.running > 0 || this.queue.size > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
