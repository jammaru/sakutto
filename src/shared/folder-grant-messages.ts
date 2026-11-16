import type { PageCommandName } from '@/shared/messages';

export interface FolderGrantNeededMessage {
  type: 'folder:grant-needed';
  command: PageCommandName;
}

export function isFolderGrantNeededMessage(value: unknown): value is FolderGrantNeededMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as FolderGrantNeededMessage).type === 'folder:grant-needed'
  );
}

export interface FolderGrantCompleteMessage {
  type: 'folder:grant-complete';
}

export function isFolderGrantCompleteMessage(value: unknown): value is FolderGrantCompleteMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as FolderGrantCompleteMessage).type === 'folder:grant-complete'
  );
}

export interface FolderResumePendingRequest {
  type: 'folder:resume-pending';
}

export function isFolderResumePendingRequest(value: unknown): value is FolderResumePendingRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as FolderResumePendingRequest).type === 'folder:resume-pending'
  );
}

export interface FolderArmCommandRequest {
  type: 'folder:arm-command';
  tabId: number;
  command: PageCommandName;
  frameId?: number | undefined;
}

export function isFolderArmCommandRequest(value: unknown): value is FolderArmCommandRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as FolderArmCommandRequest;
  return record.type === 'folder:arm-command' && typeof record.tabId === 'number';
}
