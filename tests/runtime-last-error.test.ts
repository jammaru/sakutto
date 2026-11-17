import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  reads: 0,
  chromeReads: 0,
  throws: false,
  value: undefined as { message?: string } | undefined,
  sendMessage: vi.fn(),
  chromeSendMessage: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      get lastError() {
        state.reads += 1;
        if (state.throws) throw new Error('missing runtime.lastError');
        return state.value;
      },
      sendMessage: state.sendMessage,
    },
  },
}));

import {
  bindPortDisconnectCleanup,
  broadcastRuntimeMessage,
  postPortMessage,
  readRuntimeLastError,
  safeSendResponse,
  swallowMessagingError,
} from '@/shared/runtime-last-error';

beforeEach(() => {
  state.reads = 0;
  state.chromeReads = 0;
  state.throws = false;
  state.value = undefined;
  state.sendMessage.mockReset();
  state.chromeSendMessage.mockReset();
  Reflect.deleteProperty(globalThis, 'chrome');
});

describe('runtime lastError helper', () => {
  it('reads and clears the browser messaging error', () => {
    state.value = { message: 'The message channel closed' };
    readRuntimeLastError();
    expect(state.reads).toBe(1);
  });

  it('tolerates hosts without runtime.lastError', () => {
    state.throws = true;
    expect(() => readRuntimeLastError()).not.toThrow();
  });

  it('binds a disconnect handler that reads lastError before cleanup and again next turn', async () => {
    let listener: (() => void) | undefined;
    const cleanup = vi.fn();
    bindPortDisconnectCleanup(
      { onDisconnect: { addListener: (next) => (listener = next) } },
      cleanup,
    );
    state.value = { message: 'The message channel closed' };
    listener?.();
    expect(state.reads).toBe(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(state.reads).toBe(2);
  });

  it('uses the Chrome callback path and reads callback lastError', async () => {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          get lastError() {
            state.chromeReads += 1;
            return undefined;
          },
          sendMessage: state.chromeSendMessage,
        },
      },
    });
    state.chromeSendMessage.mockImplementation((_message: unknown, callback: () => void) => {
      state.value = { message: 'The message channel closed' };
      callback();
    });

    await broadcastRuntimeMessage({ type: 'model:progress' });

    expect(state.chromeSendMessage).toHaveBeenCalledWith(
      { type: 'model:progress' },
      expect.any(Function),
    );
    expect(state.sendMessage).not.toHaveBeenCalled();
    expect(state.chromeReads).toBeGreaterThanOrEqual(1);
    expect(state.reads).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the Firefox promise path without chrome callbacks', async () => {
    state.sendMessage.mockResolvedValue(undefined);
    await broadcastRuntimeMessage({ type: 'model:progress' });
    expect(state.sendMessage).toHaveBeenCalledWith({ type: 'model:progress' });
    expect(state.reads).toBe(1);

    state.sendMessage.mockRejectedValue(new Error('closed'));
    await expect(broadcastRuntimeMessage({ type: 'model:progress' })).resolves.toBeUndefined();
    expect(state.reads).toBe(2);
  });

  it('clears lastError after port posts and async sendResponse', async () => {
    const port = { postMessage: vi.fn() };
    postPortMessage(port, { type: 'ping' });
    expect(port.postMessage).toHaveBeenCalled();
    expect(state.reads).toBeGreaterThanOrEqual(1);
    await Promise.resolve();
    expect(state.reads).toBeGreaterThanOrEqual(2);

    state.reads = 0;
    const sendResponse = vi.fn();
    safeSendResponse(sendResponse, { ok: true });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(state.reads).toBeGreaterThanOrEqual(1);
    await Promise.resolve();
    expect(state.reads).toBeGreaterThanOrEqual(2);
  });

  it('returns message results and swallows rejected messaging calls', async () => {
    await expect(swallowMessagingError(async () => 'ok')).resolves.toBe('ok');
    state.value = { message: 'The message channel closed' };
    await expect(
      swallowMessagingError(async () => {
        throw new Error('closed');
      }),
    ).resolves.toBeNull();
    expect(state.reads).toBe(1);
  });
});
