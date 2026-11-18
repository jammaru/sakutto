import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID, HIGH_QUALITY_MODEL_ID } from '@/engine/model/catalog';
import {
  canDeleteBrowserCopy,
  folderRecordsModel,
  sharedFolderNeedsPermission,
  sharedFolderStorageActive,
  shouldOfferRecordedFolderModel,
} from '@/engine/model/folder-status';
import type { ModelStatus } from '@/shared/engine-status';
import {
  modelCanTranslate,
  modelNeedsDownload,
  modelStartBlocked,
  sharedFolderNeedsUserAction,
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

  it('only offers browser-copy deletion when the folder copy is known', () => {
    expect(
      canDeleteBrowserCopy(
        { configured: true, permission: 'granted', recordedModels: [] },
        DEFAULT_MODEL_ID,
      ),
    ).toBe(true);
    expect(
      canDeleteBrowserCopy(
        { configured: true, permission: 'prompt', recordedModels: [DEFAULT_MODEL_ID] },
        DEFAULT_MODEL_ID,
      ),
    ).toBe(true);
    expect(
      canDeleteBrowserCopy(
        { configured: true, permission: 'prompt', recordedModels: [] },
        DEFAULT_MODEL_ID,
      ),
    ).toBe(false);
    expect(canDeleteBrowserCopy(undefined, DEFAULT_MODEL_ID)).toBe(true);
  });

  it('treats a configured shared folder without access as permission-needed, not a missing file', () => {
    expect(sharedFolderNeedsPermission({ configured: true, permission: 'prompt' })).toBe(true);
    expect(sharedFolderNeedsPermission({ configured: true, permission: 'denied' })).toBe(true);
    expect(sharedFolderNeedsPermission({ configured: true, permission: 'granted' })).toBe(false);
    expect(sharedFolderNeedsPermission({ configured: false, permission: 'unknown' })).toBe(false);
    expect(sharedFolderNeedsPermission(undefined)).toBe(false);
  });

  it('offers recovery only when no downloaded file can answer', () => {
    const base = {
      id: DEFAULT_MODEL_ID,
      received: 0,
      total: 1,
      progress: 0,
    };
    for (const state of ['absent', 'partial'] as const) {
      expect(modelNeedsDownload({ model: { ...base, state } }), state).toBe(true);
    }
    for (const state of [
      'downloading',
      'verifying',
      'ready',
      'loading',
      'loaded',
      'error',
    ] as const) {
      expect(modelNeedsDownload({ model: { ...base, state } }), state).toBe(false);
    }
    expect(
      modelNeedsDownload({
        model: { ...base, state: 'error', error: 'model-folder-permission' },
      }),
    ).toBe(false);
    expect(
      modelNeedsDownload({
        engineSource: 'local-server',
        model: { ...base, state: 'absent' },
      }),
    ).toBe(false);
    expect(
      modelNeedsDownload({
        model: { ...base, state: 'absent' },
        sharedFolder: {
          supported: true,
          configured: true,
          permission: 'prompt',
          opfsCopies: [],
          integrityIssues: [],
        },
      }),
    ).toBe(false);
  });

  it('does not ask for folder access when a local server is the engine', () => {
    // A local server never reads the model folder, so no grant state of that folder
    // can block its pages — even with every in-browser model deleted.
    const folder = {
      supported: true,
      configured: true,
      permission: 'prompt' as const,
      opfsCopies: [],
      integrityIssues: [],
    };
    const absent = {
      id: DEFAULT_MODEL_ID,
      state: 'absent' as const,
      received: 0,
      total: 1,
      progress: 0,
    };
    expect(
      sharedFolderNeedsUserAction({
        model: absent,
        sharedFolder: folder,
        engineSource: 'local-server',
      }),
    ).toBe(false);
    expect(
      sharedFolderNeedsUserAction({
        model: absent,
        sharedFolder: folder,
        engineSource: 'in-browser',
      }),
    ).toBe(true);
    // An older host that did not report an engine source keeps the in-browser rule.
    expect(sharedFolderNeedsUserAction({ model: absent, sharedFolder: folder })).toBe(true);
  });

  it('does not ask for folder access when OPFS or a ready model can answer', () => {
    const folder = {
      supported: true,
      configured: true,
      permission: 'prompt' as const,
      opfsCopies: [DEFAULT_MODEL_ID],
      integrityIssues: [],
      recordedModels: [DEFAULT_MODEL_ID],
    };
    const model = {
      id: DEFAULT_MODEL_ID,
      received: 0,
      total: 1,
      progress: 0,
    };
    expect(
      sharedFolderNeedsUserAction({
        model: { ...model, state: 'ready' },
        sharedFolder: { ...folder, opfsCopies: [] },
      }),
    ).toBe(false);
    expect(
      sharedFolderNeedsUserAction({
        model: { ...model, state: 'absent' },
        sharedFolder: folder,
      }),
    ).toBe(false);
    expect(
      sharedFolderNeedsUserAction({
        model: { ...model, state: 'loading' },
        sharedFolder: { ...folder, opfsCopies: [] },
      }),
    ).toBe(false);
    expect(
      sharedFolderNeedsUserAction({
        model: { ...model, state: 'absent' },
        sharedFolder: { ...folder, opfsCopies: [] },
      }),
    ).toBe(true);
    expect(
      sharedFolderNeedsUserAction({
        model: { ...model, state: 'absent' },
        sharedFolder: { ...folder, permission: 'granted' },
      }),
    ).toBe(false);
  });

  it('offers use for a folder-recorded model while permission is still prompt', () => {
    const folder = {
      configured: true,
      permission: 'prompt' as const,
      recordedModels: [HIGH_QUALITY_MODEL_ID],
    };
    expect(shouldOfferRecordedFolderModel(folder, HIGH_QUALITY_MODEL_ID, 'absent')).toBe(true);
    expect(shouldOfferRecordedFolderModel(folder, HIGH_QUALITY_MODEL_ID, 'ready')).toBe(false);
    expect(shouldOfferRecordedFolderModel(folder, DEFAULT_MODEL_ID, 'absent')).toBe(false);
    expect(
      shouldOfferRecordedFolderModel(
        { ...folder, permission: 'granted' },
        HIGH_QUALITY_MODEL_ID,
        'absent',
      ),
    ).toBe(false);
    expect(sharedFolderStorageActive(folder)).toBe(true);
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
