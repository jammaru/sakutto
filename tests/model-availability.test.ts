import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID } from '@/engine/model/catalog';
import { folderRecordsModel, sharedFolderNeedsPermission } from '@/engine/model/folder-status';
import type { ModelStatus } from '@/shared/engine-status';
import {
  modelCanTranslate,
  modelStartBlocked,
  shouldShowModelDownloadGate,
  translationStartBlocked,
} from '@/shared/engine-status';

function status(state: ModelStatus['state']): Pick<ModelStatus, 'state'> {
  return { state };
}

/**
 * A start-now control (onboarding's sample button, the toolbar's translate button) may only
 * be offered when a request can actually answer. During the download the page keeps its
 * source text, so the control would start a translation that visibly does nothing.
 */
describe('model availability', () => {
  it('can translate once the file is on disk', () => {
    expect(modelCanTranslate(status('ready'))).toBe(true);
    expect(modelCanTranslate(status('loaded'))).toBe(true);
  });

  it('cannot translate without a usable file', () => {
    for (const state of ['absent', 'partial', 'downloading', 'verifying', 'error'] as const) {
      expect(modelCanTranslate(status(state)), state).toBe(false);
    }
    expect(modelCanTranslate(null)).toBe(false);
    expect(modelCanTranslate(undefined)).toBe(false);
  });

  it('blocks a start control for everything that has no answer yet', () => {
    for (const state of [
      'absent',
      'partial',
      'downloading',
      'verifying',
      'error',
      'bogus' as ModelStatus['state'],
    ] as const) {
      expect(modelStartBlocked(status(state)), state).toBe(true);
    }
  });

  it('does not block a start control on a load that is already running', () => {
    // `loading` means the file is there and the runtime is reading it. A request joins that
    // load, and the page fills in as soon as it finishes, so the button is honest.
    expect(modelStartBlocked(status('loading'))).toBe(false);
    expect(modelStartBlocked(status('ready'))).toBe(false);
    expect(modelStartBlocked(status('loaded'))).toBe(false);
  });

  it('leaves an unknown status alone instead of locking a control on a guess', () => {
    expect(modelStartBlocked(null)).toBe(false);
    expect(modelStartBlocked(undefined)).toBe(false);
  });

  it('only ever treats the pinned model id as a state of the model', () => {
    expect(DEFAULT_MODEL_ID).toBe('plamo-3-translate-0.8b-q4_k_m');
  });

  it('does not wait for a GGUF file when a local server is the selected engine', () => {
    expect(
      translationStartBlocked({
        model: {
          id: DEFAULT_MODEL_ID,
          state: 'absent',
          received: 0,
          total: 1,
          progress: 0,
        },
        engineSource: 'local-server',
      }),
    ).toBe(false);
    expect(
      translationStartBlocked({
        model: {
          id: DEFAULT_MODEL_ID,
          state: 'absent',
          received: 0,
          total: 1,
          progress: 0,
        },
        engineSource: 'in-browser',
      }),
    ).toBe(true);
  });

  it('treats a configured shared folder without access as permission-needed, not a missing file', () => {
    expect(sharedFolderNeedsPermission({ configured: true, permission: 'prompt' })).toBe(true);
    expect(sharedFolderNeedsPermission({ configured: true, permission: 'denied' })).toBe(true);
    expect(sharedFolderNeedsPermission({ configured: true, permission: 'granted' })).toBe(false);
    expect(sharedFolderNeedsPermission({ configured: false, permission: 'unknown' })).toBe(false);
    expect(sharedFolderNeedsPermission(undefined)).toBe(false);
  });

  it('hides the download gate when the shared folder only needs permission', () => {
    const absent = {
      model: {
        id: DEFAULT_MODEL_ID,
        state: 'error' as const,
        received: 0,
        total: 1,
        progress: 0,
        error: 'model-folder-permission',
      },
      sharedFolder: {
        supported: true,
        configured: true,
        permission: 'prompt' as const,
        opfsCopies: [],
        integrityIssues: [],
        recordedModels: [DEFAULT_MODEL_ID],
      },
    };
    expect(shouldShowModelDownloadGate(absent)).toBe(false);
    expect(translationStartBlocked(absent)).toBe(true);
    expect(folderRecordsModel(absent.sharedFolder, DEFAULT_MODEL_ID)).toBe(true);
    expect(folderRecordsModel(absent.sharedFolder, 'plamo-3-translate-2b-q4_k_m')).toBe(false);
  });
});
