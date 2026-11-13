import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sharedFolderSettingsHref, shouldHighlightFolderPicker } from '@/engine/model/folder-offer';

describe('shared folder settings link', () => {
  it('highlights the Settings folder picker, not a popup prompt', () => {
    const href = sharedFolderSettingsHref((path) => `chrome-extension://id${path}`);
    expect(href).toContain('/options.html?folder=pick#model-folder');
    expect(shouldHighlightFolderPicker(href)).toBe(true);
    expect(shouldHighlightFolderPicker('chrome-extension://id/popup.html')).toBe(false);
  });

  it('does not decide when to nag OPFS users to move', () => {
    const source = readFileSync(
      new URL('../src/engine/model/folder-offer.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('shouldOfferSharedFolderMove');
    expect(source).not.toContain('opfsHasOfficialModel');
    expect(source).not.toContain('sharedFolderOfferDismissed');
  });
});
