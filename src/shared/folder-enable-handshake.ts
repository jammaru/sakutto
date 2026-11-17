export const FOLDER_ENABLE_READY_MESSAGE = 'sakutto-folder-enable-ready';
export const FOLDER_ENABLE_TOKEN_MESSAGE = 'sakutto-folder-enable-token';

interface FolderEnableReadyMessage {
  type: typeof FOLDER_ENABLE_READY_MESSAGE;
}

interface FolderEnableTokenMessage {
  type: typeof FOLDER_ENABLE_TOKEN_MESSAGE;
  token: string;
}

export interface FolderEnableDeliveryFrame {
  contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
}

export interface FolderEnableDeliveryWindow {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export function isFolderEnableReadyMessage(value: unknown): value is FolderEnableReadyMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as FolderEnableReadyMessage).type === FOLDER_ENABLE_READY_MESSAGE
  );
}

export function isFolderEnableTokenMessage(value: unknown): value is FolderEnableTokenMessage {
  return (
    isRecord(value) &&
    value.type === FOLDER_ENABLE_TOKEN_MESSAGE &&
    typeof value.token === 'string' &&
    value.token.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Wait for the extension iframe to announce that its document is ready, then deliver the
 * secret. A `load` event can still belong to `about:blank`, so it must not carry the token.
 */
export function installFolderEnableTokenDelivery(
  frame: FolderEnableDeliveryFrame,
  token: string,
  extensionOrigin: string,
  listenWindow: FolderEnableDeliveryWindow,
  retryDelayMs = 200,
): () => void {
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const remove = (): void => {
    listenWindow.removeEventListener('message', onMessage);
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    remove();
  };
  const deliver = (): boolean => {
    try {
      const target = frame.contentWindow;
      if (!target) return false;
      target.postMessage({ type: FOLDER_ENABLE_TOKEN_MESSAGE, token }, extensionOrigin);
      return true;
    } catch {
      return false;
    }
  };
  const onMessage = (event: MessageEvent): void => {
    if (stopped || event.source !== frame.contentWindow) return;
    if (event.origin !== extensionOrigin || !isFolderEnableReadyMessage(event.data)) return;
    if (retryTimer !== null) return;
    if (deliver()) {
      finish();
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped) return;
      if (deliver()) finish();
      else finish();
    }, retryDelayMs);
  };

  listenWindow.addEventListener('message', onMessage);
  return finish;
}
