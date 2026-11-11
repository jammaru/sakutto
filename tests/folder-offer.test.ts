import { describe, expect, it } from 'vitest';
import {
  opfsHasOfficialModel,
  sharedFolderSettingsHref,
  shouldHighlightFolderPicker,
  shouldOfferSharedFolderMove,
  shouldPersistSharedFolderOfferImpression,
  type SharedFolderOfferInput,
} from '@/engine/model/folder-offer';

function ready(overrides: Partial<SharedFolderOfferInput> = {}): SharedFolderOfferInput {
  return {
    pickerAvailable: true,
    folderConfigured: false,
    dismissed: false,
    translating: false,
    opfsHasOfficialModel: true,
    ...overrides,
  };
}

describe('shared folder offer', () => {
  it('shows only for Chromium users with an OPFS model and no folder yet', () => {
    expect(shouldOfferSharedFolderMove(ready())).toBe(true);
    expect(shouldOfferSharedFolderMove(ready({ pickerAvailable: false }))).toBe(false);
    expect(shouldOfferSharedFolderMove(ready({ folderConfigured: true }))).toBe(false);
    expect(shouldOfferSharedFolderMove(ready({ opfsHasOfficialModel: false }))).toBe(false);
  });

  it('hides on a later visit after the card was shown, and never during translation', () => {
    expect(shouldOfferSharedFolderMove(ready({ dismissed: true }))).toBe(false);
    expect(shouldOfferSharedFolderMove(ready({ translating: true }))).toBe(false);
    expect(shouldOfferSharedFolderMove(ready({ closedThisVisit: true }))).toBe(false);
  });

  it('keeps the card for the visit that already rendered it after persist', () => {
    expect(shouldOfferSharedFolderMove(ready({ dismissed: true, shownThisVisit: true }))).toBe(
      true,
    );
  });

  it('records an impression only when the card would actually render', () => {
    expect(shouldPersistSharedFolderOfferImpression(ready())).toBe(true);
    expect(shouldPersistSharedFolderOfferImpression(ready({ translating: true }))).toBe(false);
    expect(shouldPersistSharedFolderOfferImpression(ready({ pickerAvailable: false }))).toBe(false);
    expect(shouldPersistSharedFolderOfferImpression(ready({ folderConfigured: true }))).toBe(false);
    expect(shouldPersistSharedFolderOfferImpression(ready({ opfsHasOfficialModel: false }))).toBe(
      false,
    );
  });

  it('treats a ready official file as present and ignores a leftover partial', () => {
    expect(opfsHasOfficialModel([{ state: 'ready' }])).toBe(true);
    expect(opfsHasOfficialModel([{ state: 'loaded' }])).toBe(true);
    expect(opfsHasOfficialModel([{ state: 'absent' }, { state: 'ready' }])).toBe(true);
    expect(opfsHasOfficialModel([{ state: 'partial' }])).toBe(false);
    expect(opfsHasOfficialModel([{ state: 'downloading' }])).toBe(false);
    expect(opfsHasOfficialModel([{ state: 'absent' }])).toBe(false);
    expect(opfsHasOfficialModel([])).toBe(false);
  });

  it('sends a popup move to the settings tab instead of picking in the popup', () => {
    const href = sharedFolderSettingsHref((path) => `chrome-extension://id${path}`);
    expect(href).toContain('/options.html?folder=pick#model-folder');
    expect(shouldHighlightFolderPicker(href)).toBe(true);
    expect(shouldHighlightFolderPicker('chrome-extension://id/popup.html')).toBe(false);
  });
});
