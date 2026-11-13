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
} from './shared-folder';
import { SharedFolderModelFileStore } from './shared-store';

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

  constructor(
    private readonly opfs: ModelFileStore,
    private readonly manager: ModelManager,
  ) {}

  status(): SharedFolderStatus {
    return this.snapshot;
  }

  async refresh(): Promise<SharedFolderStatus> {
    if (!this.snapshot.configured || !this.snapshot.name) return this.snapshot;
    const stored = await loadStoredSharedFolder();
    if (!stored) {
      this.manager.setStores(this.opfs);
      this.snapshot = emptySharedFolderStatus(true);
      return this.snapshot;
    }
    const queried = await queryFolderPermission(stored.handle);
    if (this.snapshot.permission === 'granted' && queried === 'granted') {
      this.snapshot = await this.collect(stored.name, 'granted');
      return this.snapshot;
    }
    return this.apply();
  }

  async apply(): Promise<SharedFolderStatus> {
    if (!sharedFolderSupported()) {
      this.manager.setStores(this.opfs);
      this.snapshot = emptySharedFolderStatus(false);
      return this.snapshot;
    }

    const stored = await loadStoredSharedFolder();
    if (!stored) {
      this.manager.setStores(this.opfs);
      this.snapshot = emptySharedFolderStatus(true);
      return this.snapshot;
    }

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
      await this.manager.adoptPresentModels();
      this.snapshot = await this.collect(stored.name, permission);
      return this.snapshot;
    }

    this.manager.setStores(this.opfs);
    this.snapshot = {
      supported: true,
      configured: true,
      permission,
      name: stored.name,
      opfsCopies: [],
      integrityIssues: [],
      recordedModels: stored.presentModels ?? [],
    };
    return this.snapshot;
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
      if (await this.manager.primaryReady(modelId)) recordedModels.push(modelId);
      if (recordedModels.includes(modelId) && (await this.manager.fallbackCopyPresent(modelId))) {
        opfsCopies.push(modelId);
      }
    }
    await rememberSharedFolderPresentModels(recordedModels);
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
