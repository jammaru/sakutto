export const FOLDER_ENABLE_TOKEN_KEY = 'folderEnableToken';
export const FOLDER_ENABLE_TOKEN_TTL_MS = 2 * 60 * 1000;

export interface FolderEnableToken {
  token: string;
  tabId: number;
  frameId?: number | undefined;
  expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createFolderEnableToken(
  tabId: number,
  frameId: number | undefined,
  now = Date.now(),
  token: string = crypto.randomUUID(),
): FolderEnableToken {
  return {
    token,
    tabId,
    ...(frameId === undefined ? {} : { frameId }),
    expiresAt: now + FOLDER_ENABLE_TOKEN_TTL_MS,
  };
}

export function parseFolderEnableToken(value: unknown, now = Date.now()): FolderEnableToken | null {
  if (!isRecord(value)) return null;
  if (typeof value.token !== 'string' || value.token.length === 0) return null;
  if (typeof value.tabId !== 'number' || !Number.isInteger(value.tabId)) return null;
  if (
    value.frameId !== undefined &&
    (typeof value.frameId !== 'number' || !Number.isInteger(value.frameId))
  ) {
    return null;
  }
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return null;
  if (value.expiresAt <= now) return null;
  return {
    token: value.token,
    tabId: value.tabId,
    ...(value.frameId === undefined ? {} : { frameId: value.frameId }),
    expiresAt: value.expiresAt,
  };
}

export function folderEnableTokenMatches(
  record: FolderEnableToken | null,
  token: string,
  tabId: number | undefined,
  now = Date.now(),
): boolean {
  return Boolean(
    record &&
    typeof tabId === 'number' &&
    record.token === token &&
    record.tabId === tabId &&
    record.expiresAt > now,
  );
}
