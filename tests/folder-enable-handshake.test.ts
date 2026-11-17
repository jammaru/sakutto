import { describe, expect, it, vi } from 'vitest';
import {
  FOLDER_ENABLE_READY_MESSAGE,
  FOLDER_ENABLE_TOKEN_MESSAGE,
  folderEnableDocumentOrigin,
  installFolderEnableTokenDelivery,
  type FolderEnableDeliveryFrame,
  type FolderEnableDeliveryWindow,
} from '@/shared/folder-enable-handshake';

const extensionOrigin = 'chrome-extension://test';

function harness() {
  const postMessage = vi.fn();
  const contentWindow = { postMessage };
  const frame = { contentWindow } as unknown as FolderEnableDeliveryFrame;
  const listeners = new Set<(event: MessageEvent) => void>();
  const listenWindow: FolderEnableDeliveryWindow = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const emit = (data: unknown, source: unknown = contentWindow, origin = extensionOrigin): void => {
    const event = { data, source, origin } as MessageEvent;
    for (const listener of [...listeners]) listener(event);
  };
  return { frame, postMessage, listenWindow, emit, listeners };
}

describe('folder enable handshake', () => {
  it('uses the dynamic folder-enable document origin for the handshake', () => {
    expect(folderEnableDocumentOrigin('chrome-extension://dynamic-id/folder-enable.html')).toBe(
      'chrome-extension://dynamic-id',
    );
    expect(
      folderEnableDocumentOrigin('chrome-extension://extension-id/guid/folder-enable.html'),
    ).toBe('chrome-extension://extension-id');
  });

  it('never delivers on load/about:blank or a wrong source and origin', () => {
    const target = harness();
    installFolderEnableTokenDelivery(
      target.frame,
      'secret-token',
      extensionOrigin,
      target.listenWindow,
    );

    target.emit({ type: 'load' });
    target.emit({ type: FOLDER_ENABLE_READY_MESSAGE }, {}, extensionOrigin);
    target.emit(
      { type: FOLDER_ENABLE_READY_MESSAGE },
      target.frame.contentWindow,
      'https://example.com',
    );
    expect(target.postMessage).not.toHaveBeenCalled();
  });

  it('replies to the actual allowed extension origin from the ready message', () => {
    const target = harness();
    installFolderEnableTokenDelivery(
      target.frame,
      'secret-token',
      ['chrome-extension://dynamic-id', 'chrome-extension://canonical-id'],
      target.listenWindow,
    );

    target.emit(
      { type: FOLDER_ENABLE_READY_MESSAGE },
      target.frame.contentWindow,
      'chrome-extension://canonical-id',
    );

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: FOLDER_ENABLE_TOKEN_MESSAGE, token: 'secret-token' },
      'chrome-extension://canonical-id',
    );
  });

  it('delivers the token once after the extension document says it is ready', () => {
    const target = harness();
    installFolderEnableTokenDelivery(
      target.frame,
      'secret-token',
      extensionOrigin,
      target.listenWindow,
    );

    target.emit({ type: FOLDER_ENABLE_READY_MESSAGE });
    target.emit({ type: FOLDER_ENABLE_READY_MESSAGE });

    expect(target.postMessage).toHaveBeenCalledTimes(1);
    expect(target.postMessage).toHaveBeenCalledWith(
      { type: FOLDER_ENABLE_TOKEN_MESSAGE, token: 'secret-token' },
      extensionOrigin,
    );
    expect(target.listeners.size).toBe(0);
  });

  it('retries delivery once when the first post to the frame fails', async () => {
    vi.useFakeTimers();
    try {
      const target = harness();
      target.postMessage.mockImplementationOnce(() => {
        throw new Error('frame not ready');
      });
      installFolderEnableTokenDelivery(
        target.frame,
        'secret-token',
        extensionOrigin,
        target.listenWindow,
        25,
      );

      target.emit({ type: FOLDER_ENABLE_READY_MESSAGE });
      expect(target.postMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(25);
      expect(target.postMessage).toHaveBeenCalledTimes(2);
      expect(target.postMessage).toHaveBeenLastCalledWith(
        { type: FOLDER_ENABLE_TOKEN_MESSAGE, token: 'secret-token' },
        extensionOrigin,
      );
      expect(target.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
