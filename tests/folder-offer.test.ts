import { describe, expect, it, vi } from 'vitest';
import {
  completeSharedFolderOffer,
  opfsHasOfficialModel,
  shouldOfferSharedFolderMove,
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

  it('hides after Later and never during translation', () => {
    expect(shouldOfferSharedFolderMove(ready({ dismissed: true }))).toBe(false);
    expect(shouldOfferSharedFolderMove(ready({ translating: true }))).toBe(false);
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

  it('runs the picker then the verified move in one flow', async () => {
    const reload = vi.fn(async () => undefined);
    await expect(
      completeSharedFolderOffer({
        pick: async () => ({ status: 'granted' }),
        reload,
      }),
    ).resolves.toBe('moved');
    expect(reload).toHaveBeenCalledOnce();

    reload.mockClear();
    await expect(
      completeSharedFolderOffer({
        pick: async () => ({ status: 'cancelled' }),
        reload,
      }),
    ).resolves.toBe('cancelled');
    expect(reload).not.toHaveBeenCalled();
  });
});
