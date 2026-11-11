import { SELECTABLE_MODEL_IDS, type ModelId } from './catalog';
import type { ModelFileStore } from './file-store';
import {
  emptySharedFolderStatus,
  type SharedFolderIntegrityIssue,
  type SharedFolderStatus,
} from './folder-status';
import type { ModelManager } from './manager';
import {
  loadStoredSharedFolder,
  queryFolderPermission,
  sharedFolderSupported,
} from './shared-folder';
import { SharedFolderModelFileStore } from './shared-store';

/**
 * Resolves the stored directory handle for the engine host.
 *
 * The picker and `requestPermission` run in a page with UI. This session only calls
 * `queryPermission`. Offscreen then tries to open the stored handle anyway: Chrome may
 * report `prompt` in that document while the handle still reads. When the open fails,
 * the host points at OPFS (empty after a verified move) and the UI asks to re-grant.
 * See `docs/design/fsa-permission-lifetime.md`.
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
    if (
      !this.snapshot.configured ||
      this.snapshot.permission !== 'granted' ||
      !this.snapshot.name
    ) {
      return this.snapshot;
    }
    this.snapshot = await this.collect(this.snapshot.name, this.snapshot.permission);
    return this.snapshot;
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

    const permission = await queryFolderPermission(stored.handle);
    const shared = await SharedFolderModelFileStore.open(stored.handle).catch(() => null);
    if (!shared) {
      this.manager.setStores(this.opfs);
      this.snapshot = {
        supported: true,
        configured: true,
        permission,
        name: stored.name,
        opfsCopies: [],
        integrityIssues: [],
      };
      return this.snapshot;
    }

    this.manager.setStores(shared, this.opfs);
    await this.manager.adoptPresentModels();
    this.snapshot = await this.collect(stored.name, permission);
    return this.snapshot;
  }

  private async collect(
    name: string,
    permission: SharedFolderStatus['permission'],
  ): Promise<SharedFolderStatus> {
    const opfsCopies: ModelId[] = [];
    const integrityIssues: SharedFolderIntegrityIssue[] = [];
    for (const modelId of SELECTABLE_MODEL_IDS) {
      const issue = await this.manager.sharedIntegrityIssue(modelId);
      if (issue) integrityIssues.push({ modelId, kind: issue.kind, file: issue.file });
      if (
        (await this.manager.primaryReady(modelId)) &&
        (await this.manager.fallbackCopyPresent(modelId))
      ) {
        opfsCopies.push(modelId);
      }
    }
    return {
      supported: true,
      configured: true,
      permission,
      name,
      opfsCopies,
      integrityIssues,
    };
  }
}
