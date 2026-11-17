import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  reads: 0,
  throws: false,
  value: undefined as { message?: string } | undefined,
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      get lastError() {
        state.reads += 1;
        if (state.throws) throw new Error('missing runtime.lastError');
        return state.value;
      },
    },
  },
}));

import {
  bindPortDisconnectCleanup,
  readRuntimeLastError,
  swallowMessagingError,
} from '@/shared/runtime-last-error';

beforeEach(() => {
  state.reads = 0;
  state.throws = false;
  state.value = undefined;
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

  it('binds a disconnect handler that reads lastError before cleanup', () => {
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
