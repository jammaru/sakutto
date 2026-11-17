import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineClient } from '@/background/engine-client';
import type { EngineStatus } from '@/shared/engine-status';
import { FOLDER_GRANT_PENDING_KEY } from '@/shared/folder-grant-pending';
import { defaultShortcutEnabled } from '@/shared/shortcuts';

type CommandListener = (command: string, tab?: { id?: number; url?: string }) => void;
type MenuListener = (info: { menuItemId: string }, tab?: { id?: number; url?: string }) => void;

const mocks = vi.hoisted(() => {
  const session = new Map<string, unknown>();
  return {
    session,
    commandListeners: [] as CommandListener[],
    menuListeners: [] as MenuListener[],
    tabsQuery: vi.fn(),
    tabsCreate: vi.fn(),
    tabsUpdate: vi.fn(),
    windowsUpdate: vi.fn(),
    tabsSendMessage: vi.fn(),
    requestPageCommand: vi.fn<
      (tabId: number, command: string, frameId?: number) => Promise<{ active: boolean }>
    >(async () => ({ active: true })),
    ensureContentScript: vi.fn<
      (tabId: number, options?: { allFrames?: boolean }) => Promise<boolean>
    >(async () => true),
    loadSettings: vi.fn(async () => ({ shortcutsEnabled: defaultShortcutEnabled() })),
    noteShortcutCommandAssigned: vi.fn<(command: string) => Promise<void>>(async () => undefined),
    queryStoredFolderPermission: vi.fn(
      async (): Promise<'granted' | 'prompt' | 'denied' | null> => null,
    ),
    sharedFolderSupported: vi.fn(() => true),
    openPdfForTab: vi.fn<(tab?: { id?: number; url?: string }) => Promise<boolean>>(
      async () => true,
    ),
    getURL: vi.fn((path: string) => `chrome-extension://test${path}`),
  };
});

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension',
      getURL: mocks.getURL,
      get lastError() {
        return undefined;
      },
    },
    commands: {
      onCommand: {
        addListener: (listener: CommandListener) => mocks.commandListeners.push(listener),
      },
    },
    contextMenus: {
      onClicked: {
        addListener: (listener: MenuListener) => mocks.menuListeners.push(listener),
      },
      removeAll: (callback: () => void) => callback(),
      create: (_properties: unknown, callback: () => void) => callback(),
    },
    i18n: { getMessage: (key: string) => key },
    tabs: {
      query: (...args: unknown[]) => mocks.tabsQuery(...args),
      create: (...args: unknown[]) => mocks.tabsCreate(...args),
      update: (...args: unknown[]) => mocks.tabsUpdate(...args),
      sendMessage: (...args: unknown[]) => mocks.tabsSendMessage(...args),
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    windows: {
      update: (...args: unknown[]) => mocks.windowsUpdate(...args),
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

vi.mock('@/shared/page-bridge', () => ({
  ensureContentScript: (tabId: number, options?: { allFrames?: boolean }) =>
    mocks.ensureContentScript(tabId, options),
}));

vi.mock('@/shared/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/messages')>();
  return {
    ...actual,
    requestPageCommand: (tabId: number, command: string, frameId?: number) =>
      mocks.requestPageCommand(tabId, command, frameId),
  };
});

vi.mock('@/shared/storage', () => ({
  loadSettings: () => mocks.loadSettings(),
}));

vi.mock('@/shared/shortcut-assignment', () => ({
  noteShortcutCommandAssigned: (command: string) => mocks.noteShortcutCommandAssigned(command),
}));

vi.mock('@/engine/model/shared-folder', () => ({
  queryStoredFolderPermission: () => mocks.queryStoredFolderPermission(),
  sharedFolderSupported: () => mocks.sharedFolderSupported(),
}));

vi.mock('@/background/pdf-actions', () => ({
  openActivePdf: async () => true,
  openPdfForTab: (tab?: { id?: number; url?: string }) => mocks.openPdfForTab(tab),
  openPdfForTabReason: async () => null,
}));

const { installPageActionListeners, installPageActions } =
  await import('@/background/page-actions');

function promptStatus(): EngineStatus {
  return {
    model: {
      id: 'plamo-3-translate-0.8b-q4_k_m',
      state: 'error',
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
      permission: 'prompt',
      opfsCopies: [],
      integrityIssues: [],
    },
  };
}

function clientWith(status: () => Promise<EngineStatus>): EngineClient {
  return { status } as unknown as EngineClient;
}

async function invokeCommand(listener: CommandListener, tabId = 12): Promise<void> {
  listener('translate-page', { id: tabId });
}

function invokePdfCommand(listener: CommandListener, tabId = 13): void {
  listener('translate-pdf', { id: tabId, url: 'http://127.0.0.1:4173/sample.pdf' });
}

beforeEach(() => {
  mocks.session.clear();
  mocks.tabsQuery.mockReset();
  mocks.tabsCreate.mockReset();
  mocks.tabsUpdate.mockReset();
  mocks.windowsUpdate.mockReset();
  mocks.tabsSendMessage.mockReset();
  mocks.requestPageCommand.mockClear();
  mocks.ensureContentScript.mockClear();
  mocks.loadSettings.mockClear();
  mocks.noteShortcutCommandAssigned.mockClear();
  mocks.queryStoredFolderPermission.mockReset();
  mocks.queryStoredFolderPermission.mockResolvedValue(null);
  mocks.sharedFolderSupported.mockReset();
  mocks.sharedFolderSupported.mockReturnValue(true);
  mocks.openPdfForTab.mockClear();
  mocks.openPdfForTab.mockResolvedValue(true);
  mocks.tabsQuery.mockImplementation(async () =>
    mocks.tabsCreate.mock.calls.length > 0 ? [{ id: 70, windowId: 1 }] : [],
  );
  mocks.tabsCreate.mockResolvedValue({ id: 70 });
  mocks.tabsUpdate.mockResolvedValue({});
  mocks.windowsUpdate.mockResolvedValue({});
  mocks.tabsSendMessage.mockResolvedValue(undefined);
});

describe('page command listener at service-worker startup', () => {
  it('registers without the engine and defers the first prompt command after a cold start', async () => {
    // The listener is installed in the first startup turn, before the background callback
    // has created its translation broker.
    installPageActionListeners();
    expect(mocks.commandListeners).toHaveLength(1);
    expect(mocks.menuListeners).toHaveLength(1);
    const listener = mocks.commandListeners[0];
    if (!listener) throw new Error('command listener was not installed');

    installPageActions(
      undefined,
      clientWith(async () => promptStatus()),
    );
    const opened = vi.fn();
    mocks.tabsCreate.mockImplementationOnce(async (properties: { url: string }) => {
      opened(properties);
      return { id: 70 };
    });

    await invokeCommand(listener);

    await vi.waitFor(() => {
      expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toMatchObject({
        tabId: 12,
        command: 'toggle',
      });
    });
    expect(opened).toHaveBeenCalledWith({
      url: 'chrome-extension://test/folder-enable.html',
    });
    expect(mocks.tabsCreate).toHaveBeenCalledTimes(1);
    expect(mocks.requestPageCommand).not.toHaveBeenCalled();
    expect(mocks.tabsSendMessage).toHaveBeenCalledWith(12, {
      type: 'folder:grant-needed',
      command: 'toggle',
    });
  });

  it('defers a context-menu page command through the same gate', async () => {
    installPageActionListeners();
    installPageActions(
      undefined,
      clientWith(async () => promptStatus()),
    );
    const listener = mocks.menuListeners[0];
    if (!listener) throw new Error('context menu listener was not installed');

    listener({ menuItemId: 'translate-page' }, { id: 21 });

    await vi.waitFor(() => {
      expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toMatchObject({
        tabId: 21,
        command: 'toggle',
      });
    });
    expect(mocks.tabsCreate).toHaveBeenCalledTimes(1);
    expect(mocks.requestPageCommand).not.toHaveBeenCalled();
  });

  it('opens the grant tab once when the command and the in-page hint race', async () => {
    installPageActionListeners();
    installPageActions(
      undefined,
      clientWith(async () => promptStatus()),
    );
    const listener = mocks.commandListeners[0];
    if (!listener) throw new Error('command listener was not installed');

    await Promise.all([invokeCommand(listener, 12), invokeCommand(listener, 12)]);

    await vi.waitFor(() => {
      expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toMatchObject({ tabId: 12 });
    });
    expect(mocks.tabsCreate).toHaveBeenCalledTimes(1);
  });

  it('defers when status is unavailable and the stored permission still needs a grant', async () => {
    mocks.queryStoredFolderPermission.mockResolvedValue('prompt');
    installPageActionListeners();
    installPageActions(
      undefined,
      clientWith(async () => {
        throw new Error('offscreen is still starting');
      }),
    );
    const listener = mocks.commandListeners[0];
    if (!listener) throw new Error('command listener was not installed');

    await invokeCommand(listener);

    await vi.waitFor(() => {
      expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toMatchObject({
        tabId: 12,
        command: 'toggle',
      });
    });
    expect(mocks.queryStoredFolderPermission).toHaveBeenCalled();
    expect(mocks.tabsCreate).toHaveBeenCalledTimes(1);
    expect(mocks.requestPageCommand).not.toHaveBeenCalled();
  });

  it('runs without opening a grant tab when status is unavailable but permission is granted', async () => {
    mocks.queryStoredFolderPermission.mockResolvedValue('granted');
    installPageActionListeners();
    installPageActions(
      undefined,
      clientWith(async () => {
        throw new Error('offscreen is still starting');
      }),
    );
    const listener = mocks.commandListeners[0];
    if (!listener) throw new Error('command listener was not installed');

    await invokeCommand(listener);

    await vi.waitFor(() => {
      expect(mocks.requestPageCommand).toHaveBeenCalledWith(12, 'toggle', undefined);
    });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toBeUndefined();
  });

  it('runs the command when status fails and no folder is stored', async () => {
    installPageActionListeners();
    installPageActions(
      undefined,
      clientWith(async () => {
        throw new Error('offscreen is still starting');
      }),
    );
    const listener = mocks.commandListeners[0];
    if (!listener) throw new Error('command listener was not installed');

    await invokeCommand(listener);

    await vi.waitFor(() => {
      expect(mocks.requestPageCommand).toHaveBeenCalledWith(12, 'toggle', undefined);
    });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toBeUndefined();
  });

  it('skips the stored-folder lookup on builds without shared-folder support', async () => {
    mocks.sharedFolderSupported.mockReturnValue(false);
    installPageActionListeners();
    installPageActions(
      undefined,
      clientWith(async () => {
        throw new Error('offscreen is still starting');
      }),
    );
    const listener = mocks.commandListeners[0];
    if (!listener) throw new Error('command listener was not installed');

    await invokeCommand(listener);

    await vi.waitFor(() => {
      expect(mocks.requestPageCommand).toHaveBeenCalledWith(12, 'toggle', undefined);
    });
    expect(mocks.queryStoredFolderPermission).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('does not defer or open a tab when the folder permission is already granted', async () => {
    const status = promptStatus();
    status.sharedFolder = { ...status.sharedFolder!, permission: 'granted' };
    installPageActionListeners();
    installPageActions(
      undefined,
      clientWith(async () => status),
    );
    const listener = mocks.commandListeners[0];
    if (!listener) throw new Error('command listener was not installed');

    await invokeCommand(listener);

    await vi.waitFor(() => {
      expect(mocks.requestPageCommand).toHaveBeenCalledWith(12, 'toggle', undefined);
    });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toBeUndefined();
  });

  it('defers a PDF command through the folder gate before fetching the document', async () => {
    installPageActionListeners();
    installPageActions(
      undefined,
      clientWith(async () => promptStatus()),
    );
    const listener = mocks.commandListeners[0];
    if (!listener) throw new Error('command listener was not installed');

    invokePdfCommand(listener);

    await vi.waitFor(() => {
      expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toMatchObject({
        tabId: 13,
        command: 'translate-pdf',
      });
    });
    expect(mocks.tabsCreate).toHaveBeenCalledTimes(1);
    expect(mocks.openPdfForTab).not.toHaveBeenCalled();
  });

  it('defers a PDF context-menu command through the same gate', async () => {
    installPageActionListeners();
    installPageActions(
      undefined,
      clientWith(async () => promptStatus()),
    );
    const listener = mocks.menuListeners[0];
    if (!listener) throw new Error('context menu listener was not installed');

    listener({ menuItemId: 'translate-pdf' }, { id: 14, url: 'http://127.0.0.1:4173/sample.pdf' });

    await vi.waitFor(() => {
      expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toMatchObject({
        tabId: 14,
        command: 'translate-pdf',
      });
    });
    expect(mocks.tabsCreate).toHaveBeenCalledTimes(1);
    expect(mocks.openPdfForTab).not.toHaveBeenCalled();
  });

  it('opens a PDF directly when the folder permission is already granted', async () => {
    const status = promptStatus();
    status.sharedFolder = { ...status.sharedFolder!, permission: 'granted' };
    installPageActionListeners();
    installPageActions(
      undefined,
      clientWith(async () => status),
    );
    const listener = mocks.commandListeners[0];
    if (!listener) throw new Error('command listener was not installed');

    invokePdfCommand(listener);

    await vi.waitFor(() => {
      expect(mocks.openPdfForTab).toHaveBeenCalledWith({
        id: 13,
        url: 'http://127.0.0.1:4173/sample.pdf',
      });
    });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toBeUndefined();
  });

  it('opens a PDF when status is unavailable but permission is already granted', async () => {
    mocks.queryStoredFolderPermission.mockResolvedValue('granted');
    installPageActionListeners();
    installPageActions(
      undefined,
      clientWith(async () => {
        throw new Error('offscreen is still starting');
      }),
    );
    const listener = mocks.commandListeners[0];
    if (!listener) throw new Error('command listener was not installed');

    invokePdfCommand(listener);

    await vi.waitFor(() => {
      expect(mocks.openPdfForTab).toHaveBeenCalledWith({
        id: 13,
        url: 'http://127.0.0.1:4173/sample.pdf',
      });
    });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.session.get(FOLDER_GRANT_PENDING_KEY)).toBeUndefined();
  });
});
