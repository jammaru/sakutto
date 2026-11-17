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

export interface FolderEnableTokenRequest {
  type: 'folder:enable-token';
}

export function isFolderEnableTokenRequest(value: unknown): value is FolderEnableTokenRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as FolderEnableTokenRequest).type === 'folder:enable-token'
  );
}

export interface FolderEnableValidateRequest {
  type: 'folder:enable-validate';
  token: string;
}

export function isFolderEnableValidateRequest(
  value: unknown,
): value is FolderEnableValidateRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as FolderEnableValidateRequest).type === 'folder:enable-validate' &&
    typeof (value as FolderEnableValidateRequest).token === 'string' &&
    (value as FolderEnableValidateRequest).token.length > 0
  );
}

export interface FolderEnableConfirmMessage {
  type: 'folder:enable-confirm';
  token: string;
}

export function isFolderEnableConfirmMessage(value: unknown): value is FolderEnableConfirmMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as FolderEnableConfirmMessage).type === 'folder:enable-confirm' &&
    typeof (value as FolderEnableConfirmMessage).token === 'string' &&
    (value as FolderEnableConfirmMessage).token.length > 0
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
