/**
 * Checks that Hugging Face's current official GGUF blobs are all known to the catalog.
 *
 * For every catalog model this queries the *moving* `resolve/main` URL with a one-byte Range
 * request and `redirect: manual`. The redirect from huggingface.co carries `X-Linked-Size` and
 * `X-Linked-ETag` (the LFS sha256, quoted); the final CDN response only reports its own Xet
 * blob hash, so it must not be followed. The script strips the quotes and fails when the
 * upstream size or hash is not in the model's known-revision list. Downloads still use the
 * revision-pinned URL in
 * the catalog, so a new upstream revision never silently changes what new installs receive.
 * Add the new revision to `src/engine/model/catalog.ts` to make this check pass again.
 *
 *   node scripts/check-model-pins.ts
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  knownRevisions,
  latestUrl,
  MODEL_CATALOG,
  type ModelEntry,
} from '../src/engine/model/catalog.ts';

export interface ModelPinTarget {
  id: string;
  url: string;
  size: number;
  sha256?: string;
  /** Known official revisions. Absent for legacy single-pin callers and unit tests. */
  revisions?: readonly { size: number; sha256: string }[];
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
  const linked = response.headers.get('x-linked-size');
  if (linked && /^\d+$/.test(linked.trim())) return Number(linked.trim());

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

function reportedSha256(response: Response): string | null {
  const etag = response.headers.get('x-linked-etag') ?? response.headers.get('etag');
  const sha256 = etag?.trim().replace(/^"|"$/g, '').toLowerCase() ?? '';
  return /^[a-f0-9]{64}$/.test(sha256) ? sha256 : null;
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
      // Stay on huggingface.co: the redirect's headers carry the LFS sha256 in
      // X-Linked-ETag. The final CDN response only exposes its own Xet blob hash.
      const response = await fetchImpl(target.url, {
        headers: { Range: 'bytes=0-0' },
        redirect: 'manual',
        cache: 'no-store',
      });
      await response.body?.cancel().catch(() => undefined);

      if (isTransientStatus(response.status) && attempt < retries) {
        await sleep(delayMs * 2 ** attempt);
        continue;
      }

      const linkedRedirect =
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.has('x-linked-etag') &&
        response.headers.has('x-linked-size');
      if (!linkedRedirect && response.status !== 206 && response.status !== 200) {
        throw new ModelPinError(
          `${target.id} returned HTTP ${String(response.status)} for ${target.url}`,
        );
      }

      const total = reportedSize(response);
      const sha256 = reportedSha256(response);
      if (total === null) {
        throw new ModelPinError(`${target.id} did not report a total size for ${target.url}`);
      }
      const revisions = target.revisions?.length
        ? target.revisions
        : [{ size: target.size, sha256: target.sha256 ?? '' }];
      const sizeMatches = revisions.filter((revision) => revision.size === total);
      if (sizeMatches.length === 0) {
        throw new ModelPinError(
          `${target.id} is ${String(total)} bytes, pinned size is ${String(target.size)}`,
        );
      }
      if (target.revisions?.length && sha256 === null) {
        throw new ModelPinError(`${target.id} did not report X-Linked-ETag for ${target.url}`);
      }
      if (sha256 && !sizeMatches.some((revision) => revision.sha256 === sha256)) {
        throw new ModelPinError(
          `${target.id} upstream ${sha256} (${String(total)} bytes) is not in the catalog's known revisions; update the model pins`,
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
    url: latestUrl(entry),
    size: entry.size,
    revisions: knownRevisions(entry),
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
