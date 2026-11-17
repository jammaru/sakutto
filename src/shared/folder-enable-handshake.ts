export const FOLDER_ENABLE_READY_MESSAGE = 'sakutto-folder-enable-ready';
export const FOLDER_ENABLE_TOKEN_MESSAGE = 'sakutto-folder-enable-token';

interface FolderEnableReadyMessage {
  type: typeof FOLDER_ENABLE_READY_MESSAGE;
}

interface FolderEnableTokenMessage {
  type: typeof FOLDER_ENABLE_TOKEN_MESSAGE;
  token: string;
}

/** Dynamic web-accessible URLs can carry a different origin than the extension root. */
export function folderEnableDocumentOrigin(pageUrl: string): string {
  const url = new URL(pageUrl);
  // Node's URL parser returns "null" for extension schemes; browsers keep the host origin.
  return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
}

export interface FolderEnableDeliveryFrame {
  contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
}

export type FolderEnableOrigin = string | readonly string[];

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
  extensionOrigin: FolderEnableOrigin,
  listenWindow: FolderEnableDeliveryWindow,
  retryDelayMs = 200,
): () => void {
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let deliveryOrigin: string | null = null;
  const allowedOrigins = new Set(
    typeof extensionOrigin === 'string' ? [extensionOrigin] : extensionOrigin,
  );

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
      if (!target || !deliveryOrigin) return false;
      target.postMessage({ type: FOLDER_ENABLE_TOKEN_MESSAGE, token }, deliveryOrigin);
      return true;
    } catch {
      return false;
    }
  };
  const onMessage = (event: MessageEvent): void => {
    if (stopped || event.source !== frame.contentWindow) return;
    if (!allowedOrigins.has(event.origin) || !isFolderEnableReadyMessage(event.data)) return;
    if (retryTimer !== null) return;
    // Dynamic WAR URLs can present a different origin than the extension root. The ready
    // message names the frame's real document origin, so reply there after source checks.
    deliveryOrigin = event.origin;
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
