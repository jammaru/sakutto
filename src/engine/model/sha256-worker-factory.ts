import Sha256Worker from './sha256-worker.ts?worker';

/** Kept in its own module so Node benchmarks can avoid the Vite-only worker import. */
export function createSha256Worker(): Worker {
  return new Sha256Worker();
}
