import { EngineError } from '../errors';

/** Bound one pending read/write, never the whole model transfer. */
export const DEFAULT_STALL_TIMEOUT_MS = 30_000;

/** Unlike a caller abort, an inactivity timeout is safe for the download loop to retry. */
export class DownloadStallError extends EngineError {
  constructor(readonly writer = false) {
    super('download-failed', 'The model download stopped making progress.', { retryable: true });
  }
}

export function stallTimeoutOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_STALL_TIMEOUT_MS;
  }
  return value;
}

export async function withinStall<T>(
  task: Promise<T>,
  milliseconds: number,
  onTimeout?: () => void,
  writer = false,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new DownloadStallError(writer));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
