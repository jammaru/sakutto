import { describe, expect, it } from 'vitest';
import { parseFolderGrantPending } from '@/shared/folder-grant-pending';

describe('folder grant pending', () => {
  it('parses a stored command', () => {
    const pending = parseFolderGrantPending({
      tabId: 3,
      command: 'selection',
      createdAt: Date.now(),
    });
    expect(pending?.tabId).toBe(3);
    expect(pending?.command).toBe('selection');
  });

  it('accepts a deferred PDF command', () => {
    const pending = parseFolderGrantPending({
      tabId: 4,
      command: 'translate-pdf',
      createdAt: Date.now(),
    });
    expect(pending).toMatchObject({ tabId: 4, command: 'translate-pdf' });
  });

  it('rejects stale entries', () => {
    const pending = parseFolderGrantPending({
      tabId: 1,
      command: 'toggle',
      createdAt: Date.now() - 6 * 60 * 1000,
    });
    expect(pending).toBeNull();
  });
});
