import { PriorityQueue } from './priority-queue';

export interface SchedulerJob {
  priority: number;
  /** When true, running worse-priority jobs are cancelled so this one can start. */
  preempt?: boolean;
  /** A job calls `producing` once its output has begun. The staged start waits for that. */
  run: (producing: () => void) => Promise<void>;
  cancel?: () => void;
}

export interface ScheduledHandle {
  cancel(): void;
}

/**
 * How jobs take the slots.
 *
 * `pool`: a free slot takes the next job at once.
 *
 * `wave`: a group of jobs starts together and the next group waits until the whole group has
 * finished. A job that joined mid-group would put its prompt through every decode step of the
 * jobs already generating, which is far slower than a batch of single tokens on the WebGPU
 * backend.
 *
 * `staged`: for a runtime where a prompt can join the jobs that are generating at the cost of
 * about one step. The first jobs start in stages, and after that a free slot takes the next
 * job without waiting for the others to finish; a wave runs at the pace of its longest job,
 * with the slots of the shorter ones empty. While a few foreground jobs are running, other
 * jobs do not take the slots that come free, see `mayStartNext`.
 */
export type SchedulerMode = 'pool' | 'wave' | 'staged';

type JobState = 'queued' | 'running' | 'finished';

interface QueuedJob {
  job: SchedulerJob;
  state: JobState;
  producing: boolean;
}

/**
 * The first text a reader waits for shares its prompt with few others: one job, then four,
 * then every slot. In wave mode these are the first two waves. In staged mode they are the
 * stages of the start, and a stage is over once every running job is producing output.
 */
const START_WIDTHS: readonly number[] = [1, 4];
/**
 * Staged mode: a stage ends this long after it began even when a running job has produced
 * nothing. This is a safety net and not the pace of the start: a slow GPU, or one that has
 * been idle, takes long over its first prompt, and the others should still wait for it.
 */
const STAGE_TIMEOUT_MS = 2000;
/**
 * Priorities below this count as foreground: a selection or typed text (0), the caption at
 * the playhead and the live one (1 and 2), prose inside the viewport (from 10). It is the
 * value `translationPriority` gives the first prose block that is off the screen. Menu text
 * on the screen starts at 50 and is not foreground.
 */
const FOREGROUND_END = 22;
/**
 * More foreground jobs than this are not kept apart. Holding the rest of the page behind
 * fifteen of them left the other slots empty for as long as the first screen took.
 */
const SMALL_FOREGROUND = 5;
/** While the foreground is kept apart, other jobs only fill what it left of the first four starts. */
const HELD_STARTS = 4;

function isForeground(priority: number): boolean {
  return priority < FOREGROUND_END;
}

export class JobScheduler {
  private readonly queue = new PriorityQueue<QueuedJob>();
  private readonly active = new Set<QueuedJob>();
  private running = 0;
  private limit: number;
  private gathering = false;
  private waveIndex = 0;
  private idleWaiters: Array<() => void> = [];
  /** Staged mode: where the start is. This and the fields below start over when idle. */
  private stage = 0;
  private stageTimer: ReturnType<typeof setTimeout> | null = null;
  /** Jobs started since the scheduler was idle, and how many of them were foreground. */
  private started = 0;
  private foregroundStarted = 0;
  private holding = true;

  constructor(
    concurrency = 1,
    private readonly mode: SchedulerMode = 'pool',
  ) {
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
    const entry: QueuedJob = { job, state: 'queued', producing: false };
    if (job.preempt === true) this.preemptWorse(job.priority);
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

  private preemptWorse(priority: number): void {
    for (const running of this.active) {
      if (running.job.priority > priority) running.job.cancel?.();
    }
  }

  private pump(): void {
    if (this.mode === 'wave') {
      if (this.running === 0 && this.queue.size > 0 && !this.gathering) {
        // Jobs scheduled in the same turn join this wave.
        this.gathering = true;
        setTimeout(() => {
          this.gathering = false;
          this.startJobs();
        }, 0);
      }
      this.notifyIdle();
      return;
    }
    this.startJobs();
  }

  private startJobs(): void {
    // The first text a reader waits for should not share its prompt with a full wave.
    const limit =
      this.mode === 'wave'
        ? Math.min(this.limit, START_WIDTHS[this.waveIndex++] ?? this.limit)
        : this.limit;
    while (this.running < limit) {
      if (this.mode === 'staged' && !this.mayStartNext()) break;
      const entry = this.queue.dequeue();
      if (!entry) break;
      if (entry.state !== 'queued') continue;

      if (this.mode === 'staged') this.noteStart(entry.job.priority);
      entry.state = 'running';
      this.running += 1;
      this.active.add(entry);
      void this.run(entry);
    }

    this.notifyIdle();
  }

  /**
   * Staged mode: whether the job at the head of the queue may take a free slot now. It also
   * lifts the hold on background jobs for the rest of the busy period once it has served.
   */
  private mayStartNext(): boolean {
    const width = START_WIDTHS[this.stage];
    if (width !== undefined && this.running >= width) return false;

    const next = this.queue.peek();
    if (!this.holding || !next || isForeground(next.value.job.priority)) return true;

    // A few foreground jobs finish at the pace of a narrow batch. Every prompt that joined
    // them would cost each one a slow step, and the reader is waiting for exactly these.
    // With many of them the rest of the page joins after the staged start.
    const staging = width !== undefined;
    const small = this.foregroundStarted <= SMALL_FOREGROUND;
    if (this.foregroundRunning() === 0 || !(staging || small)) {
      // Once per busy period: foreground work that arrives after this joins the others.
      // Background work that ran before any foreground job has not used the hold up.
      if (this.foregroundStarted > 0) this.holding = false;
      return true;
    }
    // Counting starts, not running jobs: a slot the foreground never used may be filled,
    // but not one that a finished foreground job has just left.
    return this.started < HELD_STARTS;
  }

  private foregroundRunning(): number {
    let count = 0;
    for (const entry of this.active) {
      if (isForeground(entry.job.priority)) count += 1;
    }
    return count;
  }

  private staging(): boolean {
    return this.stage < START_WIDTHS.length;
  }

  private noteStart(priority: number): void {
    if (this.started === 0) this.armStageTimer();
    this.started += 1;
    if (isForeground(priority)) this.foregroundStarted += 1;
  }

  private noteProducing(entry: QueuedJob): void {
    if (entry.producing || entry.state !== 'running') return;
    entry.producing = true;
    this.endStageWhenProducing();
  }

  /**
   * Staged mode: the stage is over once every running job is producing. It is counted per
   * job and not per token: the first job goes on producing while the jobs that joined it are
   * still on their way to the model, and its tokens alone would open the next stage before
   * their prompts had been read.
   */
  private endStageWhenProducing(): void {
    if (this.mode !== 'staged' || this.running === 0 || !this.staging()) return;
    for (const entry of this.active) {
      if (!entry.producing) return;
    }
    this.nextStage();
  }

  private nextStage(): void {
    this.clearStageTimer();
    if (!this.staging()) return;
    this.stage += 1;
    if (this.staging()) this.armStageTimer();
    this.pump();
  }

  private armStageTimer(): void {
    this.clearStageTimer();
    this.stageTimer = setTimeout(() => this.nextStage(), STAGE_TIMEOUT_MS);
  }

  private clearStageTimer(): void {
    if (this.stageTimer !== null) clearTimeout(this.stageTimer);
    this.stageTimer = null;
  }

  private async run(entry: QueuedJob): Promise<void> {
    try {
      await entry.job.run(() => this.noteProducing(entry));
    } catch {
      // Jobs report their own failures; the scheduler only tracks slots.
    } finally {
      this.active.delete(entry);
      entry.state = 'finished';
      this.running -= 1;
      // A job that ended without output no longer keeps the stage open.
      this.endStageWhenProducing();
      this.pump();
    }
  }

  private notifyIdle(): void {
    if (this.running > 0 || this.queue.size > 0 || this.gathering) return;
    this.waveIndex = 0;
    this.clearStageTimer();
    this.stage = 0;
    this.started = 0;
    this.foregroundStarted = 0;
    this.holding = true;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
