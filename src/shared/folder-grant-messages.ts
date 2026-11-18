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

/** Notifies Settings/onboarding after a tab grant so they refresh without a full reload. */
export interface FolderStorageRefreshedMessage {
  type: 'folder:storage-refreshed';
}

export function isFolderStorageRefreshedMessage(
  value: unknown,
): value is FolderStorageRefreshedMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as FolderStorageRefreshedMessage).type === 'folder:storage-refreshed'
  );
}

export interface FolderOpenEnableRequest {
  type: 'folder:open-enable';
}

export function isFolderOpenEnableRequest(value: unknown): value is FolderOpenEnableRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as FolderOpenEnableRequest).type === 'folder:open-enable'
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
  command: PageCommandName;
  /** Privileged contexts may name the tab; content scripts leave it to the background. */
  tabId?: number | undefined;
  frameId?: number | undefined;
}

function isPageCommand(value: unknown): value is PageCommandName {
  return (
    value === 'toggle' ||
    value === 'restore' ||
    value === 'bilingual' ||
    value === 'selection' ||
    value === 'compose'
  );
}

export function isFolderArmCommandRequest(value: unknown): value is FolderArmCommandRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as FolderArmCommandRequest;
  return (
    record.type === 'folder:arm-command' &&
    isPageCommand(record.command) &&
    (record.tabId === undefined || typeof record.tabId === 'number') &&
    (record.frameId === undefined || typeof record.frameId === 'number')
  );
}
