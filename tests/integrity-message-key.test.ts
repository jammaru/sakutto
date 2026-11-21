import { describe, expect, it } from 'vitest';
import { integrityMessageKey } from '@/shared/i18n';

describe('integrityMessageKey', () => {
  it('suggests updating Sakutto for an unrecognised official revision', () => {
    expect(integrityMessageKey('revision')).toBe('modelFolderIntegrityUnknownRevision');
    expect(integrityMessageKey('integrity-revision')).toBe('modelFolderIntegrityUnknownRevision');
  });

  it('keeps the wrong-file copy for a wrong size', () => {
    expect(integrityMessageKey('size')).toBe('modelFolderIntegrityFailed');
    expect(integrityMessageKey('integrity-size')).toBe('modelFolderIntegrityFailed');
  });

  it('keeps the wrong-file copy for an unqualified digest failure', () => {
    expect(integrityMessageKey('digest')).toBe('modelFolderIntegrityFailed');
    expect(integrityMessageKey('integrity-digest')).toBe('modelFolderIntegrityFailed');
  });

  it('falls back to the wrong-file copy for unrelated errors', () => {
    expect(integrityMessageKey(undefined)).toBe('modelFolderIntegrityFailed');
    expect(integrityMessageKey('download-failed')).toBe('modelFolderIntegrityFailed');
  });
});
