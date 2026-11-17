import { SELECTABLE_MODEL_IDS, type ModelId } from './catalog';
import type { ModelFileStore } from './file-store';
import {
  folderAccessNeedsRestore,
  folderPermissionForStatus,
  resolveFolderAccessState,
} from './folder-permission';
import {
  emptySharedFolderStatus,
  type SharedFolderIntegrityIssue,
  type SharedFolderStatus,
} from './folder-status';
import type { ModelManager } from './manager';
import {
  folderPermissionOverrideActive,
  loadStoredSharedFolder,
  queryFolderPermission,
  rememberSharedFolderPresentModels,
  sharedFolderSupported,
  type StoredSharedFolder,
} from './shared-folder';
import { SharedFolderModelFileStore } from './shared-store';

const PERMISSION_CHECK_TTL_MS = 500;

/**
 * Resolves the stored directory handle for the engine host.
 *
 * The picker and `requestPermission` run in a page with UI (a settings/onboarding
 * tab for the first grant, popup or settings for a later restore). This session
 * only calls `queryPermission` and tries to open the handle. Chrome may report
 * `prompt` while the handle still reads (an extension page still holds the grant).
 * When the open fails, the host does not treat that as a missing file and does
 * not download again. See `docs/design/fsa-permission-lifetime.md`.
 */
export class SharedFolderSession {
  private snapshot: SharedFolderStatus = emptySharedFolderStatus(sharedFolderSupported());
  private stored: StoredSharedFolder | null = null;
  private permissionCheckedAt = 0;

  constructor(
    private readonly opfs: ModelFileStore,
    private readonly manager: ModelManager,
  ) {}

  status(): SharedFolderStatus {
    return this.snapshot;
  }

  /**
   * Cheap status-poll check for a grant that Chrome revoked after the last extension
   * page closed. It only queries the stored handle and updates the snapshot; it never
   * opens the folder or copies/verifies model files. A short TTL keeps rapid status
   * polls from calling `queryPermission` repeatedly.
   */
  async refreshPermissionSnapshot(options: { force?: boolean } = {}): Promise<SharedFolderStatus> {
    if (!this.snapshot.configured || !this.snapshot.name) return this.snapshot;
    if (this.snapshot.permission !== 'granted') return this.snapshot;

    const now = Date.now();
    if (!options.force && now - this.permissionCheckedAt < PERMISSION_CHECK_TTL_MS) {
      return this.snapshot;
    }
    this.permissionCheckedAt = now;

    const stored = this.stored ?? (await loadStoredSharedFolder());
    if (!stored) return this.snapshot;
    this.stored = stored;

    let queried: Awaited<ReturnType<typeof queryFolderPermission>>;
    try {
      queried = await queryFolderPermission(stored.handle);
    } catch {
      return this.snapshot;
    }
    if (queried === 'granted') return this.snapshot;

    this.snapshot = {
      ...this.snapshot,
      permission: queried,
      name: stored.name,
      opfsCopies: await this.opfsCopies(),
      integrityIssues: [],
      recordedModels: this.snapshot.recordedModels ?? stored.presentModels ?? [],
    };
    return this.snapshot;
  }

  async refresh(): Promise<SharedFolderStatus> {
    if (!this.snapshot.configured || !this.snapshot.name) return this.snapshot;
    const stored = await loadStoredSharedFolder();
    if (!stored) {
      this.stored = null;
      this.manager.setStores(this.opfs);
      this.snapshot = emptySharedFolderStatus(true);
      return this.snapshot;
    }
    this.stored = stored;
    const queried = await queryFolderPermission(stored.handle);
    if (this.snapshot.permission === 'granted' && queried === 'granted') {
      this.snapshot = await this.collect(stored.name, 'granted');
      return this.snapshot;
    }
    return this.apply();
  }

  async apply(options: { moveOpfs?: boolean } = {}): Promise<SharedFolderStatus> {
    if (!sharedFolderSupported()) {
      this.manager.setStores(this.opfs);
      this.snapshot = emptySharedFolderStatus(false);
      return this.snapshot;
    }

    const stored = await loadStoredSharedFolder();
    if (!stored) {
      this.stored = null;
      this.manager.setStores(this.opfs);
      this.snapshot = emptySharedFolderStatus(true);
      return this.snapshot;
    }
    this.stored = stored;

    const queried = await queryFolderPermission(stored.handle);
    const opened = await SharedFolderModelFileStore.open(stored.handle)
      .then((store) => store)
      .catch((error: unknown) => error);

    const openError = opened instanceof SharedFolderModelFileStore ? undefined : opened;
    const store = opened instanceof SharedFolderModelFileStore ? opened : null;
    const access = resolveFolderAccessState({
      configured: true,
      queried,
      opened: store !== null,
      ...(openError !== undefined ? { readError: openError } : {}),
      queryAuthoritative: await folderPermissionOverrideActive(),
    });
    const permission = folderPermissionForStatus(access);

    if (store && !folderAccessNeedsRestore(access)) {
      this.manager.setStores(store, this.opfs);
      if (options.moveOpfs) await this.manager.adoptPresentModelsAndRemoveOpfs();
      else await this.manager.adoptPresentModels();
      this.snapshot = await this.collect(stored.name, permission);
      return this.snapshot;
    }

    // The folder could not be opened, so the OPFS store is now primary. Keep it marked as
    // the browser copy so Settings' "Delete browser copy" control still works in this mode.
    this.manager.setStores(this.opfs, undefined, { primaryIsBrowserCopy: true });
    // Report the verified browser copies that can actually serve a load instead of an empty
    // snapshot that sends the UI looking for a download.
    this.snapshot = {
      supported: true,
      configured: true,
      permission,
      name: stored.name,
      opfsCopies: await this.opfsCopies(),
      integrityIssues: [],
      recordedModels: stored.presentModels ?? [],
    };
    return this.snapshot;
  }

  /** Browser (OPFS) copies, independent of whether OPFS is primary or the fallback. */
  private async opfsCopies(): Promise<ModelId[]> {
    const opfsIsPrimary = this.manager.primaryStore === this.opfs;
    const copies: ModelId[] = [];
    for (const modelId of SELECTABLE_MODEL_IDS) {
      const present = opfsIsPrimary
        ? await this.manager.primaryReady(modelId)
        : await this.manager.fallbackCopyPresent(modelId);
      if (present) copies.push(modelId);
    }
    return copies;
  }

  private async collect(
    name: string,
    permission: SharedFolderStatus['permission'],
  ): Promise<SharedFolderStatus> {
    const opfsCopies: ModelId[] = [];
    const recordedModels: ModelId[] = [];
    const integrityIssues: SharedFolderIntegrityIssue[] = [];
    for (const modelId of SELECTABLE_MODEL_IDS) {
      const issue = await this.manager.sharedIntegrityIssue(modelId);
      if (issue) integrityIssues.push({ modelId, kind: issue.kind, file: issue.file });
      if (await this.manager.fallbackCopyPresent(modelId)) opfsCopies.push(modelId);
      if (await this.manager.primaryReady(modelId)) recordedModels.push(modelId);
    }
    await rememberSharedFolderPresentModels(recordedModels);
    this.permissionCheckedAt = Date.now();
    return {
      supported: true,
      configured: true,
      permission,
      name,
      opfsCopies,
      integrityIssues,
      recordedModels,
    };
  }
}
