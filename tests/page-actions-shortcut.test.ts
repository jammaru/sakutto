import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultShortcutEnabled } from '@/shared/shortcuts';

const tabsQuery = vi.fn();
const requestPageCommand = vi.fn(async (_tabId: number, _command: string, _frameId?: number) => ({
  active: true,
}));
const ensureContentScript = vi.fn(
  async (_tabId: number, _options?: { allFrames?: boolean }) => true,
);
const noteShortcutCommandAssigned = vi.fn(async (_command: string) => undefined);
const loadSettings = vi.fn(async () => ({ shortcutsEnabled: defaultShortcutEnabled() }));

vi.mock('wxt/browser', () => ({
  browser: {
    commands: { onCommand: { addListener: vi.fn() } },
    tabs: {
      query: (...args: unknown[]) => tabsQuery(...args),
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    contextMenus: {
      onClicked: { addListener: vi.fn() },
      removeAll: async () => undefined,
      create: vi.fn(),
    },
    i18n: { getMessage: (key: string) => key },
    scripting: { executeScript: vi.fn() },
    permissions: { contains: async () => false },
  },
}));

vi.mock('@/shared/page-bridge', () => ({
  ensureContentScript: (tabId: number, options?: { allFrames?: boolean }) =>
    ensureContentScript(tabId, options),
}));

vi.mock('@/shared/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/messages')>();
  return {
    ...actual,
    requestPageCommand: (tabId: number, command: string, frameId?: number) =>
      requestPageCommand(tabId, command, frameId),
  };
});

vi.mock('@/shared/shortcut-assignment', () => ({
  noteShortcutCommandAssigned: (command: string) => noteShortcutCommandAssigned(command),
}));

vi.mock('@/shared/storage', () => ({
  loadSettings: () => loadSettings(),
}));

const { handleShortcutCommand, resolveShortcutTabId, shouldHandleShortcutCommand } =
  await import('@/background/page-actions');

beforeEach(() => {
  tabsQuery.mockReset();
  requestPageCommand.mockClear();
  ensureContentScript.mockClear();
  noteShortcutCommandAssigned.mockClear();
  loadSettings.mockReset();
  loadSettings.mockResolvedValue({ shortcutsEnabled: defaultShortcutEnabled() });
  ensureContentScript.mockResolvedValue(true);
});

describe('shortcut command tab routing', () => {
  it('prefers the tab Chrome delivered with onCommand', () => {
    expect(resolveShortcutTabId({ id: 7 }, [{ id: 1 }], [{ id: 2 }])).toBe(7);
  });

  it('uses the last focused window when onCommand omitted the tab', () => {
    expect(resolveShortcutTabId(undefined, [{ id: 4 }], [{ id: 9 }])).toBe(4);
  });

  it('falls back to currentWindow when lastFocusedWindow is empty', () => {
    expect(resolveShortcutTabId(undefined, [], [{ id: 9 }])).toBe(9);
    expect(resolveShortcutTabId(undefined, [], [])).toBeUndefined();
  });
});

describe('shortcut command enablement', () => {
  it('honors Sakutto’s own off switch without treating a missing Chrome key as off', () => {
    const enabled = defaultShortcutEnabled();
    expect(shouldHandleShortcutCommand('translate-page', enabled)).toBe(true);
    expect(
      shouldHandleShortcutCommand('translate-page', { ...enabled, 'translate-page': false }),
    ).toBe(false);
    expect(shouldHandleShortcutCommand('not-a-command', enabled)).toBe(false);
  });
});

describe('handleShortcutCommand', () => {
  it('sends toggle to the tab Chrome delivered with translate-page', async () => {
    await handleShortcutCommand('translate-page', { id: 12 });
    expect(noteShortcutCommandAssigned).toHaveBeenCalledWith('translate-page');
    expect(tabsQuery).not.toHaveBeenCalled();
    expect(ensureContentScript).toHaveBeenCalledWith(12, { allFrames: false });
    expect(requestPageCommand).toHaveBeenCalledWith(12, 'toggle', undefined);
  });

  it('queries lastFocusedWindow when onCommand did not include a tab', async () => {
    tabsQuery.mockImplementation(async (query: { lastFocusedWindow?: boolean }) => {
      if (query.lastFocusedWindow) return [{ id: 21 }];
      return [{ id: 99 }];
    });
    await handleShortcutCommand('translate-page');
    expect(tabsQuery).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(requestPageCommand).toHaveBeenCalledWith(21, 'toggle', undefined);
  });

  it('does not send a page command when the reader turned that shortcut off', async () => {
    loadSettings.mockResolvedValue({
      shortcutsEnabled: { ...defaultShortcutEnabled(), 'translate-page': false },
    });
    await handleShortcutCommand('translate-page', { id: 12 });
    expect(noteShortcutCommandAssigned).toHaveBeenCalledWith('translate-page');
    expect(requestPageCommand).not.toHaveBeenCalled();
  });
});
