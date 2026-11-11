import { describe, expect, it } from 'vitest';
import { EngineError, isFolderPermissionError } from '@/engine/errors';
import { isPermissionDenied } from '@/engine/model/file-store';
import {
  folderAccessNeedsRestore,
  folderGrantCanOfferPersistentPrompt,
  folderGrantSurface,
  folderPermissionError,
  folderPermissionForStatus,
  resolveFolderAccessState,
} from '@/engine/model/folder-permission';

describe('folder grant surface', () => {
  it('treats settings and onboarding as tabs that can show the restore prompt', () => {
    expect(folderGrantSurface('chrome-extension://id/options.html')).toBe('tab');
    expect(folderGrantSurface('chrome-extension://id/onboarding.html')).toBe('tab');
    expect(folderGrantCanOfferPersistentPrompt('tab')).toBe(true);
  });

  it('does not treat the popup or offscreen document as a tab', () => {
    expect(folderGrantSurface('chrome-extension://id/popup.html')).toBe('popup');
    expect(folderGrantSurface('chrome-extension://id/offscreen.html')).toBe('offscreen');
    expect(folderGrantCanOfferPersistentPrompt('popup')).toBe(false);
    expect(folderGrantCanOfferPersistentPrompt('offscreen')).toBe(false);
  });
});

describe('folder access state machine', () => {
  it('is idle when no folder is configured', () => {
    expect(resolveFolderAccessState({ configured: false, queried: 'unknown', opened: false })).toBe(
      'none',
    );
    expect(folderAccessNeedsRestore('none')).toBe(false);
  });

  it('honors a forced queryPermission when the mock handle still opens', () => {
    expect(
      resolveFolderAccessState({
        configured: true,
        queried: 'prompt',
        opened: true,
        queryAuthoritative: true,
      }),
    ).toBe('prompt');
    expect(
      resolveFolderAccessState({
        configured: true,
        queried: 'denied',
        opened: true,
        queryAuthoritative: true,
      }),
    ).toBe('denied');
  });

  it('detects an active grant when the handle actually opens', () => {
    expect(resolveFolderAccessState({ configured: true, queried: 'granted', opened: true })).toBe(
      'granted',
    );
    expect(resolveFolderAccessState({ configured: true, queried: 'prompt', opened: true })).toBe(
      'granted',
    );
    expect(folderPermissionForStatus('granted')).toBe('granted');
    expect(folderAccessNeedsRestore('granted')).toBe(false);
  });

  it('is prompt when Chrome asks again and the handle does not open', () => {
    expect(resolveFolderAccessState({ configured: true, queried: 'prompt', opened: false })).toBe(
      'prompt',
    );
    expect(folderPermissionForStatus('prompt')).toBe('prompt');
    expect(folderAccessNeedsRestore('prompt')).toBe(true);
  });

  it('keeps denied distinct from prompt', () => {
    expect(resolveFolderAccessState({ configured: true, queried: 'denied', opened: false })).toBe(
      'denied',
    );
    expect(folderPermissionForStatus('denied')).toBe('denied');
    expect(folderAccessNeedsRestore('denied')).toBe(true);
  });

  it('treats a mid-session NotAllowedError as revoked, not a missing file', () => {
    const error = new DOMException('Permission denied.', 'NotAllowedError');
    expect(isPermissionDenied(error)).toBe(true);
    expect(
      resolveFolderAccessState({
        configured: true,
        queried: 'granted',
        opened: false,
        readError: error,
      }),
    ).toBe('revoked');
    expect(
      resolveFolderAccessState({
        configured: true,
        queried: 'granted',
        opened: false,
        readError: new DOMException('blocked', 'SecurityError'),
      }),
    ).toBe('revoked');
    expect(folderPermissionForStatus('revoked')).toBe('prompt');
    expect(folderAccessNeedsRestore('revoked')).toBe(true);
  });

  it('treats queryPermission granted plus a failed open as revoked', () => {
    expect(resolveFolderAccessState({ configured: true, queried: 'granted', opened: false })).toBe(
      'revoked',
    );
  });

  it('exposes a retryable model-folder-permission error', () => {
    const error = folderPermissionError();
    expect(isFolderPermissionError(error)).toBe(true);
    expect(error.code).toBe('model-folder-permission');
    expect(error.retryable).toBe(true);
    expect(isFolderPermissionError(new EngineError('model-missing', 'no file'))).toBe(false);
  });
});
