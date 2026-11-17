import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineClient } from '@/background/engine-client';
import type { EngineStatus } from '@/shared/engine-status';
import { FOLDER_GRANT_PENDING_KEY, saveFolderGrantPending } from '@/shared/folder-grant-pending';

const mocks = vi.hoisted(() => {
  const session = new Map<string, unknown>();
  return {
    session,
    status: vi.fn<() => Promise<EngineStatus>>(),
    tabsGet: vi.fn<(tabId: number) => Promise<{ id?: number; url?: string } | null>>(
      async () => null,
    ),
    tabsSendMessage: vi.fn<(tabId: number, message: unknown, options?: unknown) => Promise<void>>(
      async () => undefined,
    ),
    requestPageCommand: vi.fn<
      (tabId: number, command: string, frameId?: number) => Promise<{ active: boolean }>
    >(async () => ({ active: true })),
    ensureContentScript: vi.fn<
      (tabId: number, options?: { allFrames?: boolean }) => Promise<boolean>
    >(async () => true),
    queryStoredFolderPermission: vi.fn(
      async (): Promise<'granted' | 'prompt' | 'denied' | null> => null,
    ),
    sharedFolderSupported: vi.fn(() => true),
    openPdfForTab: vi.fn<(tab?: { id?: number; url?: string }) => Promise<boolean>>(
      async () => true,
    ),
  };
});

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension',
      get lastError() {
        return undefined;
      },
    },
    tabs: {
      get: (tabId: number) => mocks.tabsGet(tabId),
      sendMessage: (tabId: number, message: unknown, options?: unknown) =>
        mocks.tabsSendMessage(tabId, message, options),
    },
    storage: {
      session: {
        get: async (key: string) =>
          mocks.session.has(key) ? { [key]: mocks.session.get(key) } : {},
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) mocks.session.set(key, value);
        },
        remove: async (key: string) => {
          mocks.session.delete(key);
        },
      },
    },
  },
}));

vi.mock('@/shared/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/messages')>();
  return {
    ...actual,
    requestPageCommand: (tabId: number, command: string, frameId?: number) =>
      mocks.requestPageCommand(tabId, command, frameId),
  };
});

vi.mock('@/shared/page-bridge', () => ({
  ensureContentScript: (tabId: number, options?: { allFrames?: boolean }) =>
    mocks.ensureContentScript(tabId, options),
}));

vi.mock('@/engine/model/shared-folder', () => ({
  queryStoredFolderPermission: () => mocks.queryStoredFolderPermission(),
  sharedFolderSupported: () => mocks.sharedFolderSupported(),
}));

vi.mock('@/background/pdf-actions', () => ({
  openPdfForTab: (tab?: { id?: number; url?: string }) => mocks.openPdfForTab(tab),
}));

const { resumeFolderGrantPending } = await import('@/background/folder-grant');

function statusWith(
  permission: 'granted' | 'prompt' | 'denied',
  modelState: 'error' | 'loaded' = 'error',
): EngineStatus {
  return {
    model: {
      id: 'plamo-3-translate-0.8b-q4_k_m',
      state: modelState,
      received: 0,
      total: 1,
      progress: 0,
    },
    backend: null,
    tier: null,
    threads: null,
    parallel: null,
    plamoReady: false,
    chromeSupported: true,
    active: null,
    sharedFolder: {
      supported: true,
      configured: true,
      permission,
      opfsCopies: [],
      integrityIssues: [],
    },
  };
}

function client(): EngineClient {
  return { status: mocks.status } as unknown as EngineClient;
}

beforeEach(() => {
  mocks.session.clear();
  mocks.status.mockReset();
  mocks.tabsGet.mockReset();
  mocks.tabsSendMessage.mockClear();
  mocks.requestPageCommand.mockClear();
  mocks.ensureContentScript.mockClear();
  mocks.queryStoredFolderPermission.mockReset();
  mocks.queryStoredFolderPermission.mockResolvedValue(null);
  mocks.sharedFolderSupported.mockReset();
  mocks.sharedFolderSupported.mockReturnValue(true);
  mocks.openPdfForTab.mockReset();
  mocks.openPdfForTab.mockResolvedValue(true);
  mocks.tabsSendMessage.mockResolvedValue(undefined);
});

describe('resumeFolderGrantPending', () => {
  it('retries a failed status poll before resuming the deferred page command', async () => {
    mocks.status
      .mockRejectedValueOnce(new Error('offscreen is still starting'))
      .mockResolvedValueOnce(statusWith('granted'));
    await saveFolderGrantPending({ tabId: 12, command: 'toggle' });

    await expect(resumeFolderGrantPending(client())).resolves.toBe(true);

    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(mocks.requestPageCommand).toHaveBeenCalledWith(12, 'toggle', undefined);
    expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toBeUndefined();
    expect(mocks.tabsSendMessage).toHaveBeenCalledWith(12, { type: 'folder:grant-complete' }, {});
  });

  it('keeps the pending command while every status poll still needs a grant', async () => {
    mocks.status.mockResolvedValue(statusWith('prompt'));
    await saveFolderGrantPending({ tabId: 12, command: 'toggle' });

    await expect(resumeFolderGrantPending(client())).resolves.toBe(false);

    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.requestPageCommand).not.toHaveBeenCalled();
    expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toBeDefined();
  });

  it('resumes when status stays unavailable but the stored permission is granted', async () => {
    mocks.status.mockRejectedValue(new Error('offscreen is still starting'));
    mocks.queryStoredFolderPermission.mockResolvedValue('granted');
    await saveFolderGrantPending({ tabId: 12, command: 'selection', frameId: 3 });

    await expect(resumeFolderGrantPending(client())).resolves.toBe(true);

    expect(mocks.requestPageCommand).toHaveBeenCalledWith(12, 'selection', 3);
    expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toBeUndefined();
  });

  it('keeps the pending command when status is unavailable and permission is still prompt', async () => {
    mocks.status.mockRejectedValue(new Error('offscreen is still starting'));
    mocks.queryStoredFolderPermission.mockResolvedValue('prompt');
    await saveFolderGrantPending({ tabId: 12, command: 'toggle' });

    await expect(resumeFolderGrantPending(client())).resolves.toBe(false);

    expect(mocks.requestPageCommand).not.toHaveBeenCalled();
    expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toBeDefined();
  });

  it('resumes a deferred PDF by opening the reader for the source tab', async () => {
    mocks.status.mockResolvedValue(statusWith('granted'));
    mocks.tabsGet.mockResolvedValue({
      id: 12,
      url: 'http://127.0.0.1:4173/sample.pdf',
    });
    await saveFolderGrantPending({ tabId: 12, command: 'translate-pdf' });

    await expect(resumeFolderGrantPending(client())).resolves.toBe(true);

    expect(mocks.openPdfForTab).toHaveBeenCalledWith({
      id: 12,
      url: 'http://127.0.0.1:4173/sample.pdf',
    });
    expect(mocks.ensureContentScript).not.toHaveBeenCalled();
    expect(mocks.requestPageCommand).not.toHaveBeenCalled();
    expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toBeUndefined();
  });

  it('keeps a deferred PDF pending when the reader cannot be opened', async () => {
    mocks.status.mockResolvedValue(statusWith('granted'));
    mocks.tabsGet.mockResolvedValue({ id: 12, url: 'http://127.0.0.1:4173/sample.pdf' });
    mocks.openPdfForTab.mockResolvedValue(false);
    await saveFolderGrantPending({ tabId: 12, command: 'translate-pdf' });

    await expect(resumeFolderGrantPending(client())).resolves.toBe(false);

    expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toBeDefined();
  });
});
