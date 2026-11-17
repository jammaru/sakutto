import type { FolderArmCommandRequest } from '@/shared/folder-grant-messages';
import type { PageCommandName } from '@/shared/messages';

export interface FolderArmSender {
  tab?: { id?: number | undefined } | undefined;
  frameId?: number | undefined;
}

export interface FolderArmTarget {
  tabId: number;
  command: PageCommandName;
  frameId?: number | undefined;
}

/** Content scripts omit the tab; privileged callers may set it explicitly. */
export function resolveFolderArmCommandTarget(
  message: Pick<FolderArmCommandRequest, 'type' | 'command' | 'tabId' | 'frameId'>,
  sender: FolderArmSender,
): FolderArmTarget | null {
  const senderTabId = sender.tab?.id;
  const fromContent = senderTabId !== undefined;
  const tabId = fromContent ? senderTabId : message.tabId;
  if (tabId === undefined) return null;
  return {
    tabId,
    command: message.command,
    frameId: fromContent ? sender.frameId : message.frameId,
  };
}
