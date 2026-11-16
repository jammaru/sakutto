import { describe, expect, it } from 'vitest';
import {
  FOLDER_ENABLE_TOKEN_TTL_MS,
  addFolderEnableToken,
  createFolderEnableToken,
  folderEnableTokenKey,
  folderEnableTokenMatches,
  parseFolderEnableToken,
  parseFolderEnableTokens,
  takeFolderEnableToken,
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

describe('folder enable token map', () => {
  it('keeps one token per tab and content frame', () => {
    const first = createFolderEnableToken(7, 3, now, 'token-7');
    const second = createFolderEnableToken(8, 4, now, 'token-8');
    const tokens = addFolderEnableToken(addFolderEnableToken({}, first), second);

    expect(Object.keys(tokens).sort()).toEqual([
      folderEnableTokenKey(7, 3),
      folderEnableTokenKey(8, 4),
    ]);
    expect(parseFolderEnableTokens(tokens, now)).toEqual(tokens);
  });

  it('consumes only the matched entry and rejects a wrong tab or expired token', () => {
    const first = createFolderEnableToken(7, 3, now, 'token-7');
    const second = createFolderEnableToken(8, 4, now, 'token-8');
    const tokens = addFolderEnableToken(addFolderEnableToken({}, first), second);

    const wrongTab = takeFolderEnableToken(tokens, 'token-7', 8, now);
    expect(wrongTab.record).toBeNull();
    expect(wrongTab.tokens).toEqual({ [folderEnableTokenKey(8, 4)]: second });

    const valid = takeFolderEnableToken(tokens, 'token-7', 7, now);
    expect(valid.record).toEqual(first);
    expect(valid.tokens).toEqual({ [folderEnableTokenKey(8, 4)]: second });

    const expired = takeFolderEnableToken(
      addFolderEnableToken({}, createFolderEnableToken(9, 5, now, 'token-9')),
      'token-9',
      9,
      now + FOLDER_ENABLE_TOKEN_TTL_MS,
    );
    expect(expired.record).toBeNull();
    expect(expired.tokens).toEqual({});
  });
});
