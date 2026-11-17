import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  reads: 0,
  throws: false,
  value: undefined as { message?: string } | undefined,
  sendMessage: vi.fn(),
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
  state.throws = false;
  state.value = undefined;
  state.sendMessage.mockReset();
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

  it('broadcasts runtime messages and clears errors on success and failure', async () => {
    state.sendMessage.mockResolvedValue(undefined);
    await broadcastRuntimeMessage({ type: 'model:progress' });
    expect(state.sendMessage).toHaveBeenCalledWith(
      { type: 'model:progress' },
      expect.any(Function),
    );
    expect(state.reads).toBe(2);

    state.sendMessage.mockRejectedValue(new Error('closed'));
    await expect(broadcastRuntimeMessage({ type: 'model:progress' })).resolves.toBeUndefined();
    expect(state.reads).toBe(4);
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
