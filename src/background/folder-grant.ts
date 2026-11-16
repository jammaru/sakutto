import { browser } from 'wxt/browser';
import type { EngineClient } from '@/background/engine-client';
import { sharedFolderNeedsUserAction } from '@/shared/engine-status';
import {
  clearFolderGrantPending,
  readFolderGrantPending,
  saveFolderGrantPending,
} from '@/shared/folder-grant-pending';
import type { PageCommandName } from '@/shared/messages';
import { requestPageCommand } from '@/shared/messages';
import { ensureContentScript } from '@/shared/page-bridge';

import { type FolderGrantNeededMessage } from '@/shared/folder-grant-messages';

async function notifyGrantNeeded(tabId: number, command: PageCommandName): Promise<void> {
  const message: FolderGrantNeededMessage = { type: 'folder:grant-needed', command };
  await browser.tabs.sendMessage(tabId, message).catch(() => undefined);
}

async function tryOpenPopup(): Promise<void> {
  const openPopup = browser.action?.openPopup;
  if (!openPopup) return;
  try {
    await openPopup();
  } catch {
    // No focused window or API unavailable — the in-page iframe still offers one click.
  }
}

/**
 * When the shared folder grant is dormant, defer the page command and surface a one-click
 * grant in the page (iframe) and optionally the toolbar popup.
 */
export async function gatePageCommand(
  client: EngineClient,
  tabId: number,
  command: PageCommandName,
  frameId?: number,
): Promise<'ran' | 'deferred'> {
  const status = await client.status().catch(() => null);
  if (!status || !sharedFolderNeedsUserAction(status)) return 'ran';
  await saveFolderGrantPending({ tabId, command, frameId });
  await notifyGrantNeeded(tabId, command);
  void tryOpenPopup();
  return 'deferred';
}

export async function runGatedPageCommand(
  client: EngineClient,
  tabId: number,
  command: PageCommandName,
  frameId?: number,
): Promise<void> {
  const allFrames = command === 'compose';
  if (!(await ensureContentScript(tabId, { allFrames }))) return;
  const gate = await gatePageCommand(client, tabId, command, frameId);
  if (gate === 'deferred') return;
  await requestPageCommand(tabId, command, frameId);
}

let resumeQueue: Promise<void> = Promise.resolve();

/**
 * Concurrent grants (for example two tabs finishing together) must not both run the one
 * pending command. Queue each read/check/clear cycle so the first success clears the slot
 * before the next caller can read it.
 */
export async function resumeFolderGrantPending(client: EngineClient): Promise<boolean> {
  const run = resumeQueue.then(
    () => resumeFolderGrantPendingNow(client),
    () => resumeFolderGrantPendingNow(client),
  );
  resumeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function resumeFolderGrantPendingNow(client: EngineClient): Promise<boolean> {
  const pending = await readFolderGrantPending();
  if (!pending) return false;
  const status = await client.status().catch(() => null);
  if (!status || sharedFolderNeedsUserAction(status)) return false;
  const allFrames = pending.command === 'compose';
  if (!(await ensureContentScript(pending.tabId, { allFrames }))) return false;
  // Keep the pending command until the page has actually accepted it. A missing tab or a
  // content script that cannot answer must not destroy the reader's deferred action.
  const state = await requestPageCommand(pending.tabId, pending.command, pending.frameId);
  if (!state) return false;
  await clearFolderGrantPending();
  return true;
}
