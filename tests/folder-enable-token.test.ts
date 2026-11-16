import { describe, expect, it } from 'vitest';
import {
  FOLDER_ENABLE_TOKEN_TTL_MS,
  createFolderEnableToken,
  folderEnableTokenMatches,
  parseFolderEnableToken,
} from '@/shared/folder-enable-token';

const now = 1_700_000_000_000;

describe('folder enable token', () => {
  it('binds a token to its tab and frame until it expires', () => {
    const token = createFolderEnableToken(7, 3, now, 'token-123');
    expect(token).toEqual({
      token: 'token-123',
      tabId: 7,
      frameId: 3,
      expiresAt: now + FOLDER_ENABLE_TOKEN_TTL_MS,
    });
    expect(parseFolderEnableToken(token, now)).toEqual(token);
    expect(folderEnableTokenMatches(token, 'token-123', 7, now)).toBe(true);
  });

  it('rejects another tab, another token, and an expired token', () => {
    const token = createFolderEnableToken(7, 3, now, 'token-123');
    expect(folderEnableTokenMatches(token, 'token-123', 8, now)).toBe(false);
    expect(folderEnableTokenMatches(token, 'token-999', 7, now)).toBe(false);
    expect(folderEnableTokenMatches(token, 'token-123', 7, token.expiresAt)).toBe(false);
    expect(parseFolderEnableToken(token, token.expiresAt)).toBeNull();
  });

  it('requires a complete numeric token record', () => {
    expect(parseFolderEnableToken(null, now)).toBeNull();
    expect(
      parseFolderEnableToken({ ...createFolderEnableToken(7, 3, now, 'x'), tabId: '7' }),
    ).toBeNull();
    expect(
      parseFolderEnableToken({ ...createFolderEnableToken(7, 3, now, 'x'), expiresAt: 'soon' }),
    ).toBeNull();
  });
});
