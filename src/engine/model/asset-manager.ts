import { abortError, EngineError, isAbortError } from '../errors';
import type { AssetBundle, AssetFile, AssetStatus } from './asset';
import { copyModelFile } from './copy';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_SEGMENT_BYTES,
  downloadModel,
  type DownloadProgress,
} from './download';
import type { ModelFileStore } from './file-store';
import { decideIntegrity, digestMatchesPin, type IntegrityManifest } from './integrity';
import { sha256OfBlob, type HashOptions } from './sha256';

const FREE_SPACE_MARGIN = 64 * 1024 * 1024;
const TEXT_ENCODER = new TextEncoder();

export interface AssetManifest {
  id: string;
  verifiedAt: number;
  files: Array<IntegrityManifest & { path: string }>;
}

export interface AssetManagerOptions<Id extends string> {
  store: ModelFileStore;
  bundles: Readonly<Record<Id, AssetBundle<Id>>>;
  fetchImpl?: typeof fetch;
  hashBlob?: (blob: Blob, options?: HashOptions) => Promise<string>;
  onStatus?: (status: AssetStatus<Id>) => void;
  /** The same user-consent gate used before translation-model network access. */
  hasConsent?: () => boolean;
  stallTimeoutMs?: number;
}

export interface AssetDownloadOptions<Id extends string> {
  signal: AbortSignal;
  onProgress?: (progress: DownloadProgress & { path: string }) => void;
  onStatus?: (status: AssetStatus<Id>) => void;
}

interface Inspection<Id extends string> {
  status: AssetStatus<Id>;
  needsHash: boolean;
  /** Every pinned final exists at its expected size; parts never count here. */
  allFinalsPresent: boolean;
}

function missingAssetMessage(id: string): string {
  return `Asset ${id} is not downloaded yet.`;
}

/** A missing final is a resumable state, never a verification failure to cache. */
class MissingFinalError extends EngineError {
  constructor(id: string) {
    super('model-missing', missingAssetMessage(id));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntegrityManifest(value: unknown): value is IntegrityManifest {
  return (
    isRecord(value) &&
    typeof value.sha256 === 'string' &&
    typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) &&
    typeof value.commit === 'string' &&
    (value.lastModified === undefined || typeof value.lastModified === 'number')
  );
}

/** Strictly parses the bundle sidecar; malformed or stale metadata simply forces hashing. */
export function parseAssetManifest(value: unknown, id?: string): AssetManifest | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.files)) return null;
  if (id !== undefined && value.id !== id) return null;
  if (typeof value.verifiedAt !== 'number' || !Number.isFinite(value.verifiedAt)) return null;
  const files: AssetManifest['files'] = [];
  for (const entry of value.files) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !isIntegrityManifest(entry)) {
      return null;
    }
    files.push({
      path: entry.path,
      sha256: entry.sha256,
      size: entry.size,
      commit: entry.commit,
      ...(entry.lastModified !== undefined ? { lastModified: entry.lastModified } : {}),
    });
  }
  return { id: value.id, verifiedAt: value.verifiedAt, files };
}

/**
 * Multi-file counterpart of ModelManager's transfer semantics. Both implementations use the
 * same pinned ranged downloader, SHA-256 primitives and ModelFileStore, so an OCR bundle is
 * not a second network/storage stack. A bundle is ready only when every file is verified.
 */
export class AssetManager<Id extends string> {
  private readonly store: ModelFileStore;
  private readonly bundles: Readonly<Record<Id, AssetBundle<Id>>>;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly hashBlob: ((blob: Blob, options?: HashOptions) => Promise<string>) | undefined;
  private readonly onStatus: ((status: AssetStatus<Id>) => void) | undefined;
  private readonly hasConsent: (() => boolean) | undefined;
  private readonly stallTimeoutMs: number | undefined;
  private readonly downloads = new Map<
    Id,
    { operation: Promise<void>; controller: AbortController }
  >();
  private readonly verifies = new Map<
    Id,
    { operation: Promise<void>; controller: AbortController }
  >();
  private readonly generations = new Map<Id, number>();
  private readonly live = new Map<Id, AssetStatus<Id>>();
  private readonly errors = new Map<Id, string>();

  constructor(options: AssetManagerOptions<Id>) {
    this.store = options.store;
    this.bundles = options.bundles;
    this.fetchImpl = options.fetchImpl;
    this.hashBlob = options.hashBlob;
    this.onStatus = options.onStatus;
    this.hasConsent = options.hasConsent;
    this.stallTimeoutMs = options.stallTimeoutMs;
  }

  async status(id: Id): Promise<AssetStatus<Id>> {
    const active = this.live.get(id);
    if (active && (this.downloads.has(id) || this.verifies.has(id))) return active;

    const generation = this.generation(id);
    const inspected = await this.inspect(id);
    // An inspection that overlapped deletion must not start verification for removed files.
    if (generation !== this.generation(id)) return this.status(id);
    // A bundle missing a final is partial and resumable. Starting verification here would
    // make verifyBundle() reject on the absent file and cache a sticky error for this tier.
    if (inspected.needsHash && inspected.allFinalsPresent && !this.errors.has(id)) {
      this.kickVerify(id);
      return { ...inspected.status, state: 'verifying' };
    }
    return inspected.status;
  }

  async download(id: Id, options: AssetDownloadOptions<Id>): Promise<void> {
    const existing = this.downloads.get(id);
    if (existing) return existing.operation;
    if (this.hasConsent && !this.hasConsent()) {
      throw new EngineError('invalid-input', 'Asset download requires user consent.', {
        retryable: false,
      });
    }

    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, controller.signal]);
    const operation = this.runDownload(id, signal, options).finally(() => {
      this.downloads.delete(id);
      this.live.delete(id);
    });
    this.downloads.set(id, { operation, controller });
    return operation;
  }

  cancel(id: Id): void {
    this.downloads.get(id)?.controller.abort();
    this.verifies.get(id)?.controller.abort();
  }

  async delete(id: Id): Promise<void> {
    this.generations.set(id, this.generation(id) + 1);
    const active = this.downloads.get(id);
    const verifying = this.verifies.get(id);
    active?.controller.abort();
    verifying?.controller.abort();
    if (active) await active.operation.catch(() => undefined);
    // A custom hasher may settle after abort, so wait before removing the directory.
    if (verifying) await verifying.operation.catch(() => undefined);
    this.errors.delete(id);
    this.live.delete(id);
    await this.store.removeDirectory(this.directory(id));
    this.notify({ id, state: 'absent', received: 0, total: this.bundles[id].size, progress: 0 });
  }

  /** Reads a verified bundle member, hashing correctly-sized legacy files when necessary. */
  async readFile(id: Id, path: string, signal?: AbortSignal): Promise<Blob> {
    const file = this.bundles[id].files.find((candidate) => candidate.path === path);
    if (!file)
      throw new EngineError('invalid-input', `Unknown asset file: ${path}`, {
        retryable: false,
      });
    await this.ensureVerified(id, signal ?? new AbortController().signal);
    return this.store.read(this.finalPath(id, file));
  }

  /** The store this manager is bound to, for migrating bundles when storage changes. */
  get fileStore(): ModelFileStore {
    return this.store;
  }

  /**
   * Copies one verified bundle into another store through the same pinned copy helper as
   * PLaMo models, with no network request. A target that is already verified is left alone;
   * the source tier is removed only after the copy is complete and verified, so a failed
   * move never leaves the user without a loadable bundle. Used when a shared folder is
   * adopted (move) or left in place (copy back to browser storage).
   */
  async copyToStore(
    id: Id,
    target: ModelFileStore,
    options: { removeSource?: boolean; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const signal = options.signal ?? new AbortController().signal;
    let source = await this.inspect(id);
    if (source.needsHash) {
      // Hashing a final cannot repair a missing sibling; leave the source untouched.
      if (!source.allFinalsPresent) return false;
      await this.ensureVerified(id, signal);
      source = await this.inspect(id);
    }
    if (source.status.state !== 'ready') return false;

    // Nothing to transfer into the same store, and deleting "the source" would delete the
    // only verified copy. A target holding resumable .part bytes is not a verified
    // destination either, so keep the source there even after the copy succeeds.
    if (target === this.store) return true;
    const targetState = (await this.inspect(id, target)).status.state;
    const targetWasReady = targetState === 'ready';
    const canRemoveSource = targetState === 'absent' || targetWasReady;
    if (!targetWasReady) {
      for (const file of this.bundles[id].files) {
        if (signal.aborted) throw abortError();
        await copyModelFile({
          blob: await this.store.read(this.finalPath(id, file)),
          store: target,
          partPath: this.partPath(id, file),
          finalPath: this.finalPath(id, file),
          size: file.size,
          sha256: file.sha256,
          signal,
          ...(this.hashBlob ? { hashBlob: this.hashBlob } : {}),
        });
      }
      // Reuse the normal sidecar writer so the target is verified on the next load without
      // hashing several hundred MB again.
      await this.writeManifest(id, undefined, target);
    }

    if (options.removeSource && canRemoveSource) {
      await this.store.removeDirectory(this.directory(id));
    }
    return true;
  }

  private async runDownload(
    id: Id,
    signal: AbortSignal,
    options: AssetDownloadOptions<Id>,
  ): Promise<void> {
    const bundle = this.bundles[id];
    this.errors.delete(id);
    let completed = 0;

    try {
      const manifest = await this.readManifest(id);
      for (const file of bundle.files) {
        if (signal.aborted) throw abortError();
        const stat = await this.store.stat(this.finalPath(id, file));
        const decision = decideIntegrity(file, stat, this.manifestFile(manifest, file.path));
        if (decision === 'verified') {
          completed += file.size;
          continue;
        }
        if (decision === 'reject-size') {
          throw new EngineError('model-integrity', `Unexpected size for ${file.path}.`, {
            retryable: false,
          });
        }
        if (decision === 'needs-hash') {
          this.emit(id, 'verifying', completed + file.size, options);
          await this.verifyFile(id, file, signal);
          completed += file.size;
          continue;
        }

        const partPath = this.partPath(id, file);
        await this.ensureSpace(id, file, partPath);
        const resumed = await this.store.size(partPath);
        this.emit(id, 'downloading', completed + resumed, options);
        await downloadModel({
          source: file,
          store: this.store,
          partPath,
          finalPath: this.finalPath(id, file),
          signal,
          attempts: 3,
          segmentBytes: DEFAULT_SEGMENT_BYTES,
          concurrency: DEFAULT_CONCURRENCY,
          ...(this.stallTimeoutMs !== undefined ? { stallTimeoutMs: this.stallTimeoutMs } : {}),
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
          ...(this.hashBlob ? { hashBlob: this.hashBlob } : {}),
          onProgress: (progress) => {
            const aggregate = {
              ...progress,
              received: Math.min(bundle.size, completed + progress.received),
              total: bundle.size,
              ratio: bundle.size > 0 ? (completed + progress.received) / bundle.size : 1,
              path: file.path,
            };
            this.emit(
              id,
              progress.phase === 'verify' ? 'verifying' : 'downloading',
              aggregate.received,
              options,
            );
            options.onProgress?.(aggregate);
          },
        });
        completed += file.size;
      }

      await this.writeManifest(id);
      this.errors.delete(id);
      this.notify({ id, state: 'ready', received: bundle.size, total: bundle.size, progress: 1 });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw abortError();
      const message = error instanceof Error ? error.message : String(error);
      this.errors.set(id, message);
      const inspected = await this.inspect(id).catch(() => null);
      this.notify({
        id,
        state: 'error',
        received: inspected?.status.received ?? completed,
        total: bundle.size,
        progress: bundle.size > 0 ? (inspected?.status.received ?? completed) / bundle.size : 0,
        error: message,
      });
      throw error;
    }
  }

  private async inspect(id: Id, store: ModelFileStore = this.store): Promise<Inspection<Id>> {
    const bundle = this.bundles[id];
    const manifest = await this.readManifest(id, store);
    let received = 0;
    let needsHash = false;
    let present = false;
    let allFinalsPresent = true;
    let verifiedFinals = 0;

    for (const file of bundle.files) {
      const stat = await store.stat(this.finalPath(id, file));
      const decision = decideIntegrity(file, stat, this.manifestFile(manifest, file.path));
      if (decision === 'reject-size') {
        const error = `Unexpected size for ${file.path}.`;
        this.errors.set(id, error);
        return {
          needsHash: false,
          allFinalsPresent: false,
          status: {
            id,
            state: 'error',
            received: stat?.size ?? 0,
            total: bundle.size,
            progress: 0,
            error,
          },
        };
      }
      if (decision === 'needs-hash') needsHash = true;
      if (decision === 'verified' || decision === 'needs-hash') {
        received += file.size;
        present = true;
        if (decision === 'verified') verifiedFinals += 1;
      } else {
        // A complete .part is resumable bytes, not a final file: it must never make the
        // bundle ready or authorize deleting the only store that has real finals.
        allFinalsPresent = false;
        const partial = await store.size(this.partPath(id, file));
        received += Math.min(partial, file.size);
        if (partial > 0) present = true;
      }
    }

    // A previous verification could have cached "not downloaded" while a final was
    // temporarily missing. A fresh inspection that no longer supports that error clears it.
    if (this.errors.get(id) === missingAssetMessage(id)) this.errors.delete(id);
    const failure = this.errors.get(id);
    const state = failure
      ? 'error'
      : verifiedFinals === bundle.files.length && !needsHash
        ? 'ready'
        : present || received > 0
          ? 'partial'
          : 'absent';
    return {
      needsHash,
      allFinalsPresent,
      status: {
        id,
        state,
        received,
        total: bundle.size,
        progress: bundle.size > 0 ? Math.min(1, received / bundle.size) : 1,
        ...(failure ? { error: failure } : {}),
      },
    };
  }

  private kickVerify(id: Id): void {
    if (this.verifies.has(id) || this.downloads.has(id)) return;
    const controller = new AbortController();
    const generation = this.generation(id);
    const operation = this.verifyBundle(id, controller.signal, generation)
      .then(() => {
        if (!this.verificationIsCurrent(id, controller.signal, generation)) return;
        const bundle = this.bundles[id];
        this.notify({
          id,
          state: 'ready',
          received: bundle.size,
          total: bundle.size,
          progress: 1,
        });
      })
      .catch(async (error: unknown) => {
        if (isAbortError(error) || !this.verificationIsCurrent(id, controller.signal, generation)) {
          return;
        }
        if (error instanceof MissingFinalError) {
          // A final disappeared while verification was starting: report the resumable state
          // instead of caching a "not downloaded" error for every later status() call.
          this.errors.delete(id);
          const inspected = await this.inspect(id).catch(() => null);
          this.notify(
            inspected?.status ?? {
              id,
              state: 'partial',
              received: 0,
              total: this.bundles[id].size,
              progress: 0,
            },
          );
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.errors.set(id, message);
        this.notify({
          id,
          state: 'error',
          received: this.bundles[id].size,
          total: this.bundles[id].size,
          progress: 0,
          error: message,
        });
      })
      .finally(() => {
        if (this.verifies.get(id)?.operation === operation) this.verifies.delete(id);
      });
    this.verifies.set(id, { operation, controller });
  }

  private async ensureVerified(id: Id, signal: AbortSignal): Promise<void> {
    const existing = this.verifies.get(id);
    if (existing) return existing.operation;
    const controller = new AbortController();
    const combinedSignal = AbortSignal.any([signal, controller.signal]);
    const generation = this.generation(id);
    const operation = this.verifyBundle(id, combinedSignal, generation).finally(() => {
      if (this.verifies.get(id)?.operation === operation) this.verifies.delete(id);
    });
    this.verifies.set(id, { operation, controller });
    return operation;
  }

  private async verifyBundle(id: Id, signal: AbortSignal, generation: number): Promise<void> {
    const bundle = this.bundles[id];
    this.assertVerificationCurrent(id, signal, generation);
    const manifest = await this.readManifest(id);
    // Never hash a half-downloaded bundle. Verify only when every final is on disk; readers
    // that explicitly request hashing still get a model-missing error for an absent file.
    for (const file of bundle.files) {
      this.assertVerificationCurrent(id, signal, generation);
      const stat = await this.store.stat(this.finalPath(id, file));
      this.assertVerificationCurrent(id, signal, generation);
      if (!stat || stat.size === 0) throw new MissingFinalError(id);
    }
    let completed = 0;
    for (const file of bundle.files) {
      this.assertVerificationCurrent(id, signal, generation);
      const stat = await this.store.stat(this.finalPath(id, file));
      this.assertVerificationCurrent(id, signal, generation);
      const decision = decideIntegrity(file, stat, this.manifestFile(manifest, file.path));
      if (decision === 'missing') {
        throw new MissingFinalError(id);
      }
      if (decision === 'reject-size') {
        throw new EngineError('model-integrity', `Unexpected size for ${file.path}.`, {
          retryable: false,
        });
      }
      this.emit(id, 'verifying', completed + file.size);
      if (decision === 'needs-hash') await this.verifyFile(id, file, signal, generation);
      completed += file.size;
    }
    await this.writeManifest(id, { signal, generation });
  }

  private async verifyFile(
    id: Id,
    file: AssetFile,
    signal: AbortSignal,
    generation?: number,
  ): Promise<void> {
    if (signal.aborted) throw abortError();
    const blob = await this.store.read(this.finalPath(id, file));
    if (generation !== undefined) this.assertVerificationCurrent(id, signal, generation);
    const digest = this.hashBlob
      ? await this.hashBlob(blob, { signal })
      : await sha256OfBlob(blob, { signal });
    if (generation !== undefined) this.assertVerificationCurrent(id, signal, generation);
    if (signal.aborted) throw abortError();
    if (!digestMatchesPin(digest, file)) {
      throw new EngineError('model-integrity', `SHA-256 mismatch for ${file.path}.`, {
        retryable: false,
      });
    }
  }

  private async ensureSpace(id: Id, file: AssetFile, partPath: string): Promise<void> {
    const estimate = await this.store.estimate();
    if (estimate.quota <= 0) return;
    const partial = await this.store.size(partPath);
    const required = Math.max(0, file.size - partial) + FREE_SPACE_MARGIN;
    if (estimate.usage + required > estimate.quota) {
      throw new EngineError('storage-insufficient', `Not enough free storage for ${id}.`, {
        retryable: false,
      });
    }
  }

  private async readManifest(
    id: Id,
    store: ModelFileStore = this.store,
  ): Promise<AssetManifest | null> {
    try {
      const text = await (await store.read(this.manifestPath(id))).text();
      return parseAssetManifest(JSON.parse(text) as unknown, id);
    } catch {
      return null;
    }
  }

  private manifestFile(manifest: AssetManifest | null, path: string): IntegrityManifest | null {
    return manifest?.files.find((file) => file.path === path) ?? null;
  }

  private async writeManifest(
    id: Id,
    verification?: { signal: AbortSignal; generation: number },
    store: ModelFileStore = this.store,
  ): Promise<void> {
    const assertCurrent = () => {
      if (verification) {
        this.assertVerificationCurrent(id, verification.signal, verification.generation);
      }
    };
    assertCurrent();
    const files: AssetManifest['files'] = [];
    for (const file of this.bundles[id].files) {
      const stat = await store.stat(this.finalPath(id, file));
      assertCurrent();
      if (!stat || stat.size !== file.size) {
        throw new EngineError('model-integrity', `Asset ${file.path} is incomplete.`);
      }
      files.push({ ...file, path: file.path, lastModified: stat.lastModified });
    }
    const manifest: AssetManifest = { id, verifiedAt: Date.now(), files };
    const bytes = TEXT_ENCODER.encode(JSON.stringify(manifest));
    assertCurrent();
    await store.append(this.manifestPath(id), bytes, 0);
    assertCurrent();
    // append() preserves bytes after a shorter rewrite, so replace through a fresh temp file.
    const remaining = await store.size(this.manifestPath(id));
    assertCurrent();
    if (remaining !== bytes.length) {
      await store.remove(this.manifestPath(id));
      assertCurrent();
      await store.append(this.manifestPath(id), bytes, 0);
    }
  }

  private generation(id: Id): number {
    return this.generations.get(id) ?? 0;
  }

  private verificationIsCurrent(id: Id, signal: AbortSignal, generation: number): boolean {
    return !signal.aborted && generation === this.generation(id);
  }

  private assertVerificationCurrent(id: Id, signal: AbortSignal, generation: number): void {
    if (!this.verificationIsCurrent(id, signal, generation)) throw abortError();
  }

  private emit(
    id: Id,
    state: AssetStatus<Id>['state'],
    received: number,
    options?: AssetDownloadOptions<Id>,
  ): void {
    const total = this.bundles[id].size;
    const status = {
      id,
      state,
      received: Math.min(received, total),
      total,
      progress: total > 0 ? Math.min(1, received / total) : 1,
    } satisfies AssetStatus<Id>;
    this.live.set(id, status);
    this.onStatus?.(status);
    options?.onStatus?.(status);
  }

  private notify(status: AssetStatus<Id>): void {
    this.live.set(status.id, status);
    this.onStatus?.(status);
  }

  private directory(id: Id): string {
    return `models/ocr-${id}`;
  }

  private finalPath(id: Id, file: AssetFile): string {
    return `${this.directory(id)}/${file.path}`;
  }

  private partPath(id: Id, file: AssetFile): string {
    return `${this.finalPath(id, file)}.part`;
  }

  private manifestPath(id: Id): string {
    return `${this.directory(id)}/asset.json`;
  }
}
