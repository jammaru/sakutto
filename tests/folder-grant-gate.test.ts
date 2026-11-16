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
});
