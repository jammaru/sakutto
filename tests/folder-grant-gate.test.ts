import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('folder grant gate', () => {
  it('defers shortcut commands when the folder grant needs a gesture', () => {
    const actions = readFileSync(
      new URL('../src/background/page-actions.ts', import.meta.url),
      'utf8',
    );
    const grant = readFileSync(
      new URL('../src/background/folder-grant.ts', import.meta.url),
      'utf8',
    );
    expect(actions).toContain('runGatedPageCommand');
    expect(grant).toContain('sharedFolderNeedsUserAction');
    expect(grant).toContain('openPopup');
    expect(grant).toContain('folder:grant-needed');
  });

  it('exposes an in-page one-click grant iframe', () => {
    const overlay = readFileSync(new URL('../src/dom/overlay.ts', import.meta.url), 'utf8');
    const enable = readFileSync(
      new URL('../src/entrypoints/folder-enable/App.svelte', import.meta.url),
      'utf8',
    );
    expect(overlay).toContain('showFolderEnable');
    expect(enable).toContain('ensureStoredFolderPermission');
    expect(enable).toContain('folder:resume-pending');
  });

  it('completes a grant through the background instead of page postMessage', () => {
    const enable = readFileSync(
      new URL('../src/entrypoints/folder-enable/App.svelte', import.meta.url),
      'utf8',
    );
    const background = readFileSync(
      new URL('../src/entrypoints/background.ts', import.meta.url),
      'utf8',
    );
    expect(enable).toContain("type: 'folder:grant-complete'");
    expect(enable).not.toContain('sakutto-folder-granted');
    expect(background).toContain('isFolderGrantCompleteMessage');
    expect(background).toContain('isFolderEnableSender');
    expect(background).toContain('readFolderGrantPending');
    expect(background).toContain('browser.tabs');
    expect(background).toContain('sendMessage');
  });

  it('binds the iframe grant to a one-time token and a trusted click', () => {
    const enable = readFileSync(
      new URL('../src/entrypoints/folder-enable/App.svelte', import.meta.url),
      'utf8',
    );
    const overlay = readFileSync(new URL('../src/dom/overlay.ts', import.meta.url), 'utf8');
    const background = readFileSync(
      new URL('../src/entrypoints/background.ts', import.meta.url),
      'utf8',
    );
    const content = readFileSync(new URL('../src/content/main.ts', import.meta.url), 'utf8');
    const validation = readFileSync(
      new URL('../src/background/folder-enable-validate.ts', import.meta.url),
      'utf8',
    );
    const handshake = readFileSync(
      new URL('../src/shared/folder-enable-handshake.ts', import.meta.url),
      'utf8',
    );
    expect(enable).toContain('folder:enable-validate');
    expect(enable).toContain('event.isTrusted');
    expect(enable).toContain('FOLDER_ENABLE_READY_MESSAGE');
    expect(enable).toContain('isFolderEnableTokenMessage');
    expect(enable).toContain('event.source !== window.parent');
    expect(enable).not.toContain('searchParams.get');
    expect(content).toContain('installFolderEnableTokenDelivery');
    expect(content).toContain('isFolderEnableConfirmMessage');
    expect(content).not.toContain("searchParams.set('token'");
    expect(background).toContain('isFolderEnableTokenRequest');
    expect(background).toContain('validateFolderEnableTokenMap');
    expect(background).toContain('browser.storage.session.remove');
    expect(validation).toContain("type: 'folder:enable-confirm'");
    expect(validation).toContain('frameId: record.frameId ?? 0');
    expect(validation).toContain('takeFolderEnableToken');
    expect(handshake).toContain("FOLDER_ENABLE_READY_MESSAGE = 'sakutto-folder-enable-ready'");
    expect(handshake).toContain('postMessage');
    expect(overlay).toContain('attachUiShadow(this.folderEnableHost)');
    expect(overlay).toContain('folderEnableShadow.append(frame)');
    expect(overlay).toContain('attachDelivery');
    expect(overlay).not.toContain("setAttribute('sandbox'");
    expect(overlay).not.toContain("addEventListener('load'");
  });

  it('hides the grant overlay when the deferred command completes', () => {
    const session = readFileSync(new URL('../src/dom/session.ts', import.meta.url), 'utf8');
    const end = session.slice(
      session.indexOf('endFolderGrantWait()'),
      session.indexOf('retryUntranslated()', session.indexOf('endFolderGrantWait()')),
    );
    expect(end).toContain('this.overlay.hideFolderEnable()');
  });

  it('keeps a deferred command until the page accepts it', () => {
    const grant = readFileSync(
      new URL('../src/background/folder-grant.ts', import.meta.url),
      'utf8',
    );
    const resume = grant.slice(grant.indexOf('export async function resumeFolderGrantPending'));
    expect(resume.indexOf('requestPageCommand')).toBeGreaterThan(-1);
    expect(resume.indexOf('clearFolderGrantPending')).toBeGreaterThan(
      resume.indexOf('requestPageCommand'),
    );
    expect(grant).toContain('resumeQueue');
    expect(grant).toContain('resumeFolderGrantPendingNow');
  });
});
