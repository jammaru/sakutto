import { isModelId, type ModelId } from './catalog';
import { isRecord } from '@/shared/object';
import type { ModelState } from '@/shared/engine-status';
import type { FolderPermission } from './shared-folder';

export type SharedFolderPermission = FolderPermission | 'unknown';

export type SharedFolderIntegrityKind = 'size' | 'digest';

export interface SharedFolderIntegrityIssue {
  modelId: ModelId;
  kind: SharedFolderIntegrityKind;
  file: string;
}

export interface SharedFolderStatus {
  supported: boolean;
  configured: boolean;
  permission: SharedFolderPermission;
  name?: string;
  /** Models still present in OPFS after a shared folder is set (migration leftovers). */
  opfsCopies: readonly ModelId[];
  integrityIssues: readonly SharedFolderIntegrityIssue[];
  /**
   * Official models last seen ready in this folder. Kept in IndexedDB so a missing
   * grant can still say the GGUF is on disk without reading it.
   */
  recordedModels?: readonly ModelId[];
}

export function sharedFolderNeedsPermission(
  folder: Pick<SharedFolderStatus, 'configured' | 'permission'> | null | undefined,
): boolean {
  return folder?.configured === true && folder.permission !== 'granted';
}

/**
 * True when deleting the Settings browser copy cannot remove the only known copy. With an
 * active folder grant the folder copy is verified. Without it, require that a previous
 * successful inspect recorded this model in the folder.
 */
export function canDeleteBrowserCopy(
  folder:
    Pick<SharedFolderStatus, 'configured' | 'permission' | 'recordedModels'> | null | undefined,
  modelId: ModelId,
): boolean {
  if (!folder?.configured) return true;
  if (folder.permission === 'granted') return true;
  return folder.recordedModels?.includes(modelId) === true;
}

/** True when a previous successful inspect recorded this model in the folder. */
export function folderRecordsModel(
  folder: Pick<SharedFolderStatus, 'recordedModels'> | null | undefined,
  modelId: ModelId | undefined,
): boolean {
  return Boolean(modelId && folder?.recordedModels?.includes(modelId));
}

/**
 * True when a model row may offer its Use control. A ready or loaded file always can. So
 * can a folder-only model while the folder needs its grant: the row cannot read the
 * folder, but the recorded copy is on disk, and the click-time `requestPermission` in a
 * settings tab (Brave reports `prompt` where Chrome kept the persisted grant) can bring
 * it back. Transfers and an already-running load keep their own controls.
 */
export function modelRowCanUse(
  folder:
    Pick<SharedFolderStatus, 'configured' | 'permission' | 'recordedModels'> | null | undefined,
  modelId: ModelId,
  state: ModelState,
): boolean {
  if (state === 'ready' || state === 'loaded') return true;
  if (
    state === 'loading' ||
    state === 'downloading' ||
    state === 'verifying' ||
    state === 'partial'
  ) {
    return false;
  }
  return sharedFolderNeedsPermission(folder) && folderRecordsModel(folder, modelId);
}

/**
 * True when a model row may offer its Delete control. Any locally present file can be
 * removed. While the folder needs its grant a model can also inspect as `absent` (its
 * only copy is in the unreadable folder), and the browser-copy delete is still offered
 * when that copy was recorded, because removing it cannot lose the folder file. Without
 * a record the control stays hidden so a stale surface cannot destroy the only copy.
 */
export function modelRowCanDelete(
  folder:
    Pick<SharedFolderStatus, 'configured' | 'permission' | 'recordedModels'> | null | undefined,
  modelId: ModelId,
  state: ModelState,
): boolean {
  if (!folder?.configured) return state !== 'absent';
  if (state === 'absent') {
    return sharedFolderNeedsPermission(folder) && canDeleteBrowserCopy(folder, modelId);
  }
  return canDeleteBrowserCopy(folder, modelId);
}

/** The persisted storage choice is independent of the folder's current permission grant. */
export function sharedFolderStorageChoice(
  folder: Pick<SharedFolderStatus, 'configured'> | null | undefined,
): 'browser' | 'folder' {
  return folder?.configured ? 'folder' : 'browser';
}

export function emptySharedFolderStatus(supported: boolean): SharedFolderStatus {
  return {
    supported,
    configured: false,
    permission: 'unknown',
    opfsCopies: [],
    integrityIssues: [],
  };
}

export function isSharedFolderPermission(value: unknown): value is SharedFolderPermission {
  return value === 'granted' || value === 'denied' || value === 'prompt' || value === 'unknown';
}

export function isSharedFolderIntegrityIssue(value: unknown): value is SharedFolderIntegrityIssue {
  if (!isRecord(value)) return false;
  if (!isModelId(value.modelId)) return false;
  if (value.kind !== 'size' && value.kind !== 'digest') return false;
  return typeof value.file === 'string' && value.file.length > 0;
}

export function isSharedFolderStatus(value: unknown): value is SharedFolderStatus {
  if (!isRecord(value)) return false;
  if (typeof value.supported !== 'boolean' || typeof value.configured !== 'boolean') return false;
  if (!isSharedFolderPermission(value.permission)) return false;
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length === 0)) {
    return false;
  }
  if (!Array.isArray(value.opfsCopies) || !value.opfsCopies.every((id) => isModelId(id))) {
    return false;
  }
  if (
    !Array.isArray(value.integrityIssues) ||
    !value.integrityIssues.every((issue) => isSharedFolderIntegrityIssue(issue))
  ) {
    return false;
  }
  if (value.recordedModels !== undefined) {
    if (
      !Array.isArray(value.recordedModels) ||
      !value.recordedModels.every((id) => isModelId(id))
    ) {
      return false;
    }
  }
  return true;
}
