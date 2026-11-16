import {
  takeFolderEnableToken,
  type FolderEnableToken,
  type FolderEnableTokenMap,
} from '@/shared/folder-enable-token';
import type { FolderEnableConfirmMessage } from '@/shared/folder-grant-messages';

export type FolderEnableConfirmSender = (
  tabId: number,
  message: FolderEnableConfirmMessage,
  options: { frameId: number },
) => Promise<unknown>;

export async function confirmWithContentScript(
  record: FolderEnableToken,
  token: string,
  sendMessage: FolderEnableConfirmSender,
): Promise<boolean> {
  try {
    return (
      (await sendMessage(
        record.tabId,
        { type: 'folder:enable-confirm', token },
        { frameId: record.frameId ?? 0 },
      )) === true
    );
  } catch {
    return false;
  }
}

/**
 * Validate against one token-map snapshot. The matching entry is always removed first, so a
 * wrong tab, expired token, or failed frame confirmation cannot be replayed.
 */
export async function validateFolderEnableTokenMap(
  tokens: FolderEnableTokenMap,
  token: string,
  tabId: number | undefined,
  sendMessage: FolderEnableConfirmSender,
  now = Date.now(),
): Promise<{ tokens: FolderEnableTokenMap; valid: boolean }> {
  const taken = takeFolderEnableToken(tokens, token, tabId, now);
  if (!taken.record) return { tokens: taken.tokens, valid: false };
  return {
    tokens: taken.tokens,
    valid: await confirmWithContentScript(taken.record, token, sendMessage),
  };
}
