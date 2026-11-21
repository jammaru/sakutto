import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
}

describe('folder grant gate', () => {
  it('defers commands and installs context menus without duplicate ids', () => {
    const actions = source('background/page-actions.ts');
    const grant = source('background/folder-grant.ts');
    expect(actions).toContain('runGatedPageCommand');
    expect(grant).toContain('sharedFolderNeedsUserAction');
    expect(grant).toContain('openOrFocusExtensionTab');
    expect(grant).not.toContain('browser.tabs.create');
    expect(grant).not.toContain('openPopup');
    expect(grant).not.toContain('windows.create');
    expect(grant).toContain('folder:grant-needed');
    const menus = source('background/context-menus.ts');
    expect(actions).toContain('scheduleContextMenusInstall');
    expect(menus).toContain('removeAllMenus');
    expect(menus).toContain('readRuntimeLastError');
    expect(menus).toContain('installChain');
    expect(menus).not.toContain('removeAll().then(() =>');
  });

  it('shows an in-page hint without requesting folder permission in the page', () => {
    const overlay = source('dom/overlay.ts');
    const session = source('dom/session.ts');
    const content = source('content/main.ts');
    expect(overlay).toContain('showFolderEnable');
    expect(overlay).toContain('folderEnableHint');
    expect(overlay).toContain('folderEnableButton');
    expect(overlay).not.toContain("createElement('iframe')");
    expect(overlay).not.toContain('folder-enable.html');
    expect(session).toContain('onFolderEnable');
    expect(session).not.toContain('requestPermission');
    expect(content).toContain("type: 'folder:open-enable'");
    expect(content).not.toContain('folder-enable.html');
    expect(content).not.toContain('requestPermission');
    expect(content).not.toContain('ensureStoredFolderPermission');
  });

  it('gates page-owned shortcut listeners behind the all-sites grant', () => {
    const session = source('dom/session.ts');
    const content = source('content/main.ts');
    expect(session).toContain('onPageCommand');
    expect(session).toContain('selectionKey');
    expect(session).toContain('pageKey');
    expect(content).toContain('listensFor');
    expect(content).toContain('inPageFallbackShortcut');
    expect(content).toContain('onComposeCommand');
    expect(content).toContain('allSitesAccess');
    // The page callbacks are not installed as an unconditional fallback.
    expect(content).toMatch(/pageKey: \(event\) =>\s*\n\s*allSitesAccess &&/);
    expect(content).toMatch(/composeKey: \(event\) =>\s*\n\s*allSitesAccess &&/);
    expect(content).toContain('const armed = await armFolderCommand(command);');
  });

  it('grants only from the top-level folder-enable tab', () => {
    const popup = source('entrypoints/popup/App.svelte');
    const enable = source('entrypoints/folder-enable/App.svelte');
    const background = source('entrypoints/background.ts');
    expect(popup).toContain('readFolderGrantPending');
    expect(popup).toContain('enablePendingFolderGrant');
    expect(popup).not.toContain('ensureStoredFolderPermission');
    expect(popup).toContain("type: 'folder:open-enable'");
    expect(popup).toContain('window.close()');
    expect(enable).toContain('ensureStoredFolderPermission');
    expect(enable).toContain('folder:resume-pending');
    expect(enable).toContain('folder:grant-complete');
    expect(enable).toContain('browser.tabs.remove');
    expect(enable).toContain('window.parent !== window');
    expect(enable).toContain("type: 'folder:open-enable'");
    expect(enable).not.toContain('sakutto-folder-enable-token');
    expect(enable).not.toContain('searchParams.get');
    expect(background).toContain('isFolderOpenEnableRequest');
    expect(background).toContain('openFolderEnableWindow');
    expect(background).not.toContain('folder:enable-token');
    expect(background).not.toContain('folder:enable-validate');
  });

  it('hides the grant hint when the deferred command completes', () => {
    const session = source('dom/session.ts');
    const end = session.slice(
      session.indexOf('endFolderGrantWait()'),
      session.indexOf('retryUntranslated()', session.indexOf('endFolderGrantWait()')),
    );
    expect(end).toContain('this.overlay.hideFolderEnable()');
  });

  it('captures a selection before the async command path', () => {
    const content = source('content/main.ts');
    const capture = content.indexOf(
      "message.command === 'selection' ? capturePageSelection(document)",
    );
    expect(capture).toBeGreaterThan(-1);
    expect(content.indexOf('void sessionPromise.then', capture)).toBeGreaterThan(capture);
    expect(content).toContain('run(message.command, selection)');
    expect(content).toContain('session.translateSelection(selection.text, selection.rect)');
  });

  it('keeps a deferred command until the page accepts it', () => {
    const grant = source('background/folder-grant.ts');
    const resume = grant.slice(grant.indexOf('export async function resumeFolderGrantPending'));
    expect(resume.indexOf('requestPageCommand')).toBeGreaterThan(-1);
    expect(resume.indexOf('clearFolderGrantPending')).toBeGreaterThan(
      resume.indexOf('requestPageCommand'),
    );
    expect(grant).toContain('resumeQueue');
    expect(grant).toContain('resumeFolderGrantPendingNow');
  });
});
