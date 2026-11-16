import { describe, expect, it, vi } from 'vitest';
import {
  validateFolderEnableTokenMap,
  type FolderEnableConfirmSender,
} from '@/background/folder-enable-validate';
import {
  addFolderEnableToken,
  createFolderEnableToken,
  folderEnableTokenKey,
} from '@/shared/folder-enable-token';

const now = 1_700_000_000_000;

function tokens() {
  return addFolderEnableToken(
    addFolderEnableToken({}, createFolderEnableToken(7, 3, now, 'token-7')),
    createFolderEnableToken(8, 4, now, 'token-8'),
  );
}

describe('folder enable validation', () => {
  it('rejects a wrong tab without confirming and consumes that token', async () => {
    const send = vi.fn(async () => true);
    const result = await validateFolderEnableTokenMap(tokens(), 'token-7', 8, send, now);

    expect(result.valid).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(result.tokens).toEqual({
      [folderEnableTokenKey(8, 4)]: createFolderEnableToken(8, 4, now, 'token-8'),
    });
  });

  it('confirms the issuing content frame and rejects when that frame no longer owns the overlay', async () => {
    const send: FolderEnableConfirmSender = vi.fn(async (tabId, message, options) => {
      expect(tabId).toBe(7);
      expect(message).toEqual({ type: 'folder:enable-confirm', token: 'token-7' });
      expect(options).toEqual({ frameId: 3 });
      return false;
    });
    const result = await validateFolderEnableTokenMap(tokens(), 'token-7', 7, send, now);

    expect(result.valid).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.tokens).not.toHaveProperty(folderEnableTokenKey(7, 3));
  });

  it('cannot replay a consumed token', async () => {
    const send = vi.fn(async () => true);
    const first = await validateFolderEnableTokenMap(tokens(), 'token-7', 7, send, now);
    const second = await validateFolderEnableTokenMap(first.tokens, 'token-7', 7, send, now);

    expect(first.valid).toBe(true);
    expect(second.valid).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('lets two tabs validate their own tokens independently', async () => {
    const send: FolderEnableConfirmSender = vi.fn(async (tabId, _message, options) => {
      return (tabId === 7 && options.frameId === 3) || (tabId === 8 && options.frameId === 4);
    });
    const current = tokens();
    const [first, second] = await Promise.all([
      validateFolderEnableTokenMap(current, 'token-7', 7, send, now),
      validateFolderEnableTokenMap(current, 'token-8', 8, send, now),
    ]);

    expect(first.valid).toBe(true);
    expect(second.valid).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(first.tokens).not.toHaveProperty(folderEnableTokenKey(7, 3));
    expect(second.tokens).not.toHaveProperty(folderEnableTokenKey(8, 4));
  });
});
