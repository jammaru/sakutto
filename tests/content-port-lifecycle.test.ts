// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ reads: 0 }));

vi.mock('@/shared/runtime-last-error', () => ({
  readRuntimeLastError: () => {
    state.reads += 1;
  },
}));

import {
  installContentPortLifecycle,
  registerContentPortReconnect,
  trackContentPort,
} from '@/shared/content-port-lifecycle';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  state.reads = 0;
});

describe('content port lifecycle', () => {
  it('disconnects tracked ports on pagehide and reads lastError first', () => {
    const disconnect = vi.fn();
    const untrack = trackContentPort({ disconnect } as never);
    cleanups.push(untrack, installContentPortLifecycle());

    window.dispatchEvent(new Event('pagehide'));

    expect(state.reads).toBeGreaterThan(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('runs reconnect hooks on persisted pageshow', () => {
    const reconnect = vi.fn();
    cleanups.push(registerContentPortReconnect(reconnect), installContentPortLifecycle());

    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);

    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
