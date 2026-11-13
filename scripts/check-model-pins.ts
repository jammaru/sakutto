import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MODEL_CATALOG, type ModelEntry } from '../src/engine/model/catalog.ts';

export interface ModelPinTarget {
  id: string;
  url: string;
  size: number;
}

export class ModelPinError extends Error {
  override readonly name = 'ModelPinError';
}

export interface CheckModelPinOptions {
  /** Extra attempts after the first. 429, 5xx, and network errors retry. */
  retries?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_DELAY_MS = 400;

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function reportedSize(response: Response): number | null {
  const range = response.headers.get('content-range');
  if (range) {
    const match = /\/(\d+)\s*$/.exec(range);
    if (match?.[1]) return Number(match[1]);
  }

  if (response.status === 200) {
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length)) return Number(length);
  }

  return null;
}

export async function checkModelPin(
  target: ModelPinTarget,
  fetchImpl: typeof fetch,
  options: CheckModelPinOptions = {},
): Promise<void> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(target.url, {
        headers: { Range: 'bytes=0-0' },
        redirect: 'follow',
        cache: 'no-store',
      });
      await response.body?.cancel().catch(() => undefined);

      if (isTransientStatus(response.status) && attempt < retries) {
        await sleep(delayMs * 2 ** attempt);
        continue;
      }

      if (response.status !== 206 && response.status !== 200) {
        throw new ModelPinError(
          `${target.id} returned HTTP ${String(response.status)} for ${target.url}`,
        );
      }

      const total = reportedSize(response);
      if (total === null) {
        throw new ModelPinError(`${target.id} did not report a total size for ${target.url}`);
      }
      if (total !== target.size) {
        throw new ModelPinError(
          `${target.id} is ${String(total)} bytes, pinned size is ${String(target.size)}`,
        );
      }
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof ModelPinError || attempt >= retries) throw error;
      await sleep(delayMs * 2 ** attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new ModelPinError(String(lastError));
}

export async function checkModelPins(
  targets: readonly ModelPinTarget[],
  fetchImpl: typeof fetch,
  options: CheckModelPinOptions = {},
): Promise<void> {
  const failures: string[] = [];

  for (const target of targets) {
    try {
      await checkModelPin(target, fetchImpl, options);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (failures.length > 0) throw new ModelPinError(failures.join('\n'));
}

export function pinnedModelTargets(): ModelPinTarget[] {
  return Object.values(MODEL_CATALOG).map((entry: ModelEntry) => ({
    id: entry.id,
    url: entry.url,
    size: entry.size,
  }));
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(realpathSync(entry)).href;
}

if (isDirectRun()) {
  const targets = pinnedModelTargets();
  checkModelPins(targets, fetch)
    .then(() => {
      for (const target of targets) {
        process.stdout.write(`${target.id} ${String(target.size)} ${target.url}\n`);
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
