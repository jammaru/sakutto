import { isModelId, type ModelId } from './catalog';
import { isRecord } from '@/shared/object';
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

/** True when a previous successful inspect recorded this model in the folder. */
export function folderRecordsModel(
  folder: Pick<SharedFolderStatus, 'recordedModels'> | null | undefined,
  modelId: ModelId | undefined,
): boolean {
  return Boolean(modelId && folder?.recordedModels?.includes(modelId));
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
