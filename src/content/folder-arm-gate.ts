import { browser } from 'wxt/browser';
import type { FolderArmCommandRequest } from '@/shared/folder-grant-messages';
import type { PageCommandName } from '@/shared/messages';
import { readRuntimeLastError } from '@/shared/runtime-last-error';

export type FolderArmOutcome = 'continue' | 'deferred';

export type FolderArmSender = (
  message: Pick<FolderArmCommandRequest, 'type' | 'command'>,
) => Promise<unknown>;

/**
 * Content scripts cannot call the tabs API. Let the background derive the tab and frame from
 * the message sender, and use the reply only to decide whether the page command is deferred.
 */
export async function armFolderCommand(
  command: PageCommandName,
  sendMessage: FolderArmSender = (message) => browser.runtime.sendMessage(message),
): Promise<FolderArmOutcome> {
  try {
    const armed = await sendMessage({ type: 'folder:arm-command', command });
    return armed === 'deferred' ? 'deferred' : 'continue';
  } catch {
    readRuntimeLastError();
    return 'continue';
  }
}
