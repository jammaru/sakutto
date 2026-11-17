import { browser } from 'wxt/browser';
import type { PageCommandName } from '@/shared/messages';

export const FOLDER_GRANT_PENDING_KEY = 'folderGrantPending';

/** The PDF command is not a page action: resuming it opens the reader for the source tab. */
export const PDF_GRANT_COMMAND = 'translate-pdf' as const;

export type FolderGrantCommand = PageCommandName | typeof PDF_GRANT_COMMAND;

export interface FolderGrantPending {
  tabId: number;
  command: FolderGrantCommand;
  frameId?: number | undefined;
  createdAt: number;
}

const PENDING_TTL_MS = 5 * 60 * 1000;

function isPageCommand(value: unknown): value is PageCommandName {
  return (
    value === 'toggle' ||
    value === 'restore' ||
    value === 'bilingual' ||
    value === 'selection' ||
    value === 'compose'
  );
}

function isFolderGrantCommand(value: unknown): value is FolderGrantCommand {
  return isPageCommand(value) || value === PDF_GRANT_COMMAND;
}

export function parseFolderGrantPending(value: unknown): FolderGrantPending | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.tabId !== 'number' || !Number.isFinite(record.tabId)) return null;
  if (!isFolderGrantCommand(record.command)) return null;
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : 0;
  if (createdAt > 0 && Date.now() - createdAt > PENDING_TTL_MS) return null;
  const frameId = typeof record.frameId === 'number' ? record.frameId : undefined;
  return { tabId: record.tabId, command: record.command, frameId, createdAt };
}

export async function readFolderGrantPending(): Promise<FolderGrantPending | null> {
  const stored = await browser.storage.session
    .get(FOLDER_GRANT_PENDING_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  return parseFolderGrantPending(stored[FOLDER_GRANT_PENDING_KEY]);
}

export async function saveFolderGrantPending(
  input: Omit<FolderGrantPending, 'createdAt'>,
): Promise<void> {
  const payload: FolderGrantPending = { ...input, createdAt: Date.now() };
  await browser.storage.session.set({ [FOLDER_GRANT_PENDING_KEY]: payload }).catch(() => undefined);
}

export async function clearFolderGrantPending(): Promise<void> {
  await browser.storage.session.remove(FOLDER_GRANT_PENDING_KEY).catch(() => undefined);
}
