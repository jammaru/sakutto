import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID } from '@/engine/model/catalog';
import { emptySharedFolderStatus, sharedFolderNeedsPermission } from '@/engine/model/folder-status';
import { sharedFolderPickerAvailable } from '@/engine/model/shared-folder';
import {
  modelNeedsDownload,
  sharedFolderNeedsUserAction,
  shouldShowModelDownloadGate,
  translationStartBlocked,
} from '@/shared/engine-status';
import { modelRemovalStopsTranslation } from '@/shared/model-progress';
import { storedFolderGrantBlocksCommand } from '@/background/folder-grant';

function source(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
}

const absentModel = {
  id: DEFAULT_MODEL_ID,
  state: 'absent' as const,
  received: 0,
  total: 1,
  progress: 0,
};

/**
 * A reader whose engine is a local server deleted every in-browser model. No gate may ask
 * for the GGUF file back: the requests go to the server, so translation must still start
 * and keep running through the delete broadcasts the deletion fans out.
 */
describe('local server without an in-browser model', () => {
  it('never blocks a start control on the missing file', () => {
    const status = { model: absentModel, engineSource: 'local-server' as const };
    expect(translationStartBlocked(status)).toBe(false);
    expect(shouldShowModelDownloadGate(status)).toBe(false);
    expect(modelNeedsDownload(status)).toBe(false);
  });

  it('keeps the in-browser rule for the same model state', () => {
    const status = { model: absentModel, engineSource: 'in-browser' as const };
    expect(translationStartBlocked(status)).toBe(true);
    expect(shouldShowModelDownloadGate(status)).toBe(true);
    expect(modelNeedsDownload(status)).toBe(true);
  });

  it('does not fault the page when the delete broadcast arrives', () => {
    expect(modelRemovalStopsTranslation('local-server')).toBe(false);
    expect(modelRemovalStopsTranslation('in-browser')).toBe(true);
  });

  it('does not defer a page command behind the folder grant', () => {
    // The folder gate may not open a grant window for a page that never reads the folder.
    expect(
      sharedFolderNeedsUserAction({
        model: absentModel,
        sharedFolder: {
          ...emptySharedFolderStatus(true),
          configured: true,
          permission: 'prompt',
        },
        engineSource: 'local-server',
      }),
    ).toBe(false);
    expect(
      sharedFolderNeedsUserAction({
        model: absentModel,
        sharedFolder: {
          ...emptySharedFolderStatus(true),
          configured: true,
          permission: 'prompt',
        },
        engineSource: 'in-browser',
      }),
    ).toBe(true);
  });

  it('keeps translating in a Brave-like browser with no directory picker', () => {
    // Brave never grew `showDirectoryPicker`, so its builds stay on browser-only storage.
    const picker = sharedFolderPickerAvailable(undefined);
    expect(picker).toBe(false);
    const browserOnly = emptySharedFolderStatus(picker);
    expect(sharedFolderNeedsPermission(browserOnly)).toBe(false);
    expect(
      sharedFolderNeedsUserAction({
        model: absentModel,
        sharedFolder: browserOnly,
        engineSource: 'local-server',
      }),
    ).toBe(false);
    expect(translationStartBlocked({ model: absentModel, engineSource: 'local-server' })).toBe(
      false,
    );
  });

  it('does not open a grant window from the stored-permission fallback', () => {
    const settings = { engineSource: 'local-server' as const };
    for (const permission of ['prompt', 'denied'] as const) {
      expect(storedFolderGrantBlocksCommand(settings, permission), permission).toBe(false);
    }
    expect(storedFolderGrantBlocksCommand(null, 'prompt')).toBe(true);
    expect(storedFolderGrantBlocksCommand({ engineSource: 'in-browser' }, 'denied')).toBe(true);
    expect(storedFolderGrantBlocksCommand({ engineSource: 'in-browser' }, 'granted')).toBe(false);
    expect(storedFolderGrantBlocksCommand({ engineSource: 'in-browser' }, null)).toBe(false);
  });

  it('wires the engine source into the content-script delete handler', () => {
    const content = source('content/main.ts');
    // The missing-model fault must sit behind the engine-source check, next to the
    // recovery probe, so a local-server page cannot be faulted by an absent broadcast.
    const gate = content.indexOf('modelRemovalStopsTranslation(nextSettings.engineSource)');
    expect(gate).toBeGreaterThan(-1);
    const fault = content.indexOf('session.noteModelMissing()');
    expect(fault).toBeGreaterThan(gate);
    expect(content).toContain('import { modelRemovalOutcome, modelRemovalStopsTranslation }');
    // Compose readiness must keep passing the engine source into typedReadiness.
    expect(content).toContain('engineSource: settings.engineSource');
  });

  it('wires the engine source into the background grant fallback', () => {
    const grant = source('background/folder-grant.ts');
    expect(grant).toContain('storedFolderGrantBlocksCommand(settings, permission)');
    expect(grant).toContain("settings?.engineSource === 'local-server'");
  });
});
