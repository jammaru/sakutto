/**
 * A deadline that a loader can keep alive while it makes observable progress.
 *
 * A slow iGPU can spend minutes compiling shaders and uploading tensors, so a single fixed
 * deadline cannot tell it apart from a wedged driver. The stall timer is reset by
 * `progress()`, while the absolute cap still bounds a load that keeps logging but never
 * finishes.
 */
export type ProgressTimeoutKind = 'stall' | 'max';

export interface ProgressTimeoutOptions {
  /** Reject when this long passes without a `progress()` call. */
  stallMs: number;
  /** Reject even when progress keeps arriving after this long. */
  maxMs: number;
  onTimeout: (kind: ProgressTimeoutKind) => Error;
}

export interface ProgressTimeout {
  /** Rejects with `onTimeout(kind)` unless the caller wins and calls `stop()`. */
  readonly expired: Promise<never>;
  /** Reset the stall timer. Cheap enough to call for every loader log line. */
  progress(): void;
  stop(): void;
}

export function createProgressTimeout(options: ProgressTimeoutOptions): ProgressTimeout {
  const stallMs = Math.max(1, options.stallMs);
  const maxMs = Math.max(stallMs, options.maxMs);

  let rejected = false;
  let settleExpired: (error: Error) => void = () => undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    settleExpired = reject;
  });
  // The race may already have settled on the loader side; do not turn the late timeout
  // rejection into an unhandled rejection.
  expired.catch(() => undefined);

  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;

  const clear = (): void => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    if (maxTimer !== undefined) clearTimeout(maxTimer);
    stallTimer = undefined;
    maxTimer = undefined;
  };

  const expire = (kind: ProgressTimeoutKind): void => {
    if (rejected) return;
    rejected = true;
    clear();
    settleExpired(options.onTimeout(kind));
  };

  const progress = (): void => {
    if (rejected) return;
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => expire('stall'), stallMs);
  };

  progress();
  maxTimer = setTimeout(() => expire('max'), maxMs);

  return {
    expired,
    progress,
    stop: () => {
      rejected = true;
      clear();
    },
  };
}
