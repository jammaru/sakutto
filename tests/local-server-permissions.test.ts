import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCAL_SERVER_URL,
  originPatternsFor,
  primaryOriginPattern,
} from '@/engine/local-server/url';

/**
 * Firefox drops the user-gesture flag after any awaited extension call. Chrome still
 * allows `permissions.request` after `permissions.contains`. The mock records that
 * difference so the old contains-then-request path fails only on the Firefox side.
 */
const state = vi.hoisted(() => ({
  kind: 'chrome' as 'chrome' | 'firefox',
  granted: new Set<string>(),
  deny: false,
  awaitedCalls: 0,
  requestCalls: 0,
  requestOrigins: [] as string[][],
}));

vi.mock('wxt/browser', () => ({
  browser: {
    permissions: {
      contains: async ({ origins }: { origins: string[] }) => {
        await Promise.resolve();
        state.awaitedCalls += 1;
        return origins.every((origin) => state.granted.has(origin));
      },
      request: async ({ origins }: { origins: string[] }) => {
        state.requestCalls += 1;
        state.requestOrigins.push([...origins]);
        if (state.kind === 'firefox' && state.awaitedCalls > 0) {
          throw new Error('permissions.request may only be called from a user input handler');
        }
        if (state.deny) return false;
        for (const origin of origins) state.granted.add(origin);
        return true;
      },
    },
  },
}));

const { browser } = await import('wxt/browser');
const { requestServerPermission, resolveEngineSourceSwitch } =
  await import('@/engine/local-server/permissions');

function reset(kind: 'chrome' | 'firefox'): void {
  state.kind = kind;
  state.granted.clear();
  state.deny = false;
  state.awaitedCalls = 0;
  state.requestCalls = 0;
  state.requestOrigins = [];
}

/** The Settings path before this fix: contains first, then request. */
async function containsThenRequest(url: string): Promise<boolean> {
  const origins = originPatternsFor(url);
  if (origins.length === 0) return false;
  const already = await browser.permissions.contains({ origins }).catch(() => false);
  if (already) return true;
  return browser.permissions.request({ origins }).catch(() => false);
}

beforeEach(() => {
  reset('chrome');
});

describe('requestServerPermission user-gesture', () => {
  it('Firefox: contains-then-request is rejected and swallowed as a denial', async () => {
    reset('firefox');
    await expect(containsThenRequest(DEFAULT_LOCAL_SERVER_URL)).resolves.toBe(false);
    expect(state.requestCalls).toBe(1);
    expect(state.granted.size).toBe(0);
  });

  it('Firefox: requesting first, with no prior await, grants the loopback origin', async () => {
    reset('firefox');
    await expect(requestServerPermission(DEFAULT_LOCAL_SERVER_URL)).resolves.toBe(true);
    expect(state.awaitedCalls).toBe(0);
    expect(state.requestCalls).toBe(1);
    expect(state.requestOrigins[0]).toEqual([primaryOriginPattern(DEFAULT_LOCAL_SERVER_URL)]);
    expect(state.granted.has('http://127.0.0.1/*')).toBe(true);
  });

  it('asks only for the URL origin so an already-granted 127.0.0.1 does not re-prompt for aliases', async () => {
    reset('chrome');
    state.granted.add('http://127.0.0.1/*');
    state.granted.add('http://localhost/*');
    await expect(requestServerPermission(DEFAULT_LOCAL_SERVER_URL)).resolves.toBe(true);
    expect(state.requestOrigins[0]).toEqual(['http://127.0.0.1/*']);
    expect(state.requestOrigins[0]).not.toEqual(originPatternsFor(DEFAULT_LOCAL_SERVER_URL));
  });

  it('Chrome: contains-then-request still grants, and request-first also grants', async () => {
    reset('chrome');
    await expect(containsThenRequest(DEFAULT_LOCAL_SERVER_URL)).resolves.toBe(true);
    expect(state.awaitedCalls).toBe(1);
    expect(state.requestCalls).toBe(1);

    reset('chrome');
    await expect(requestServerPermission(DEFAULT_LOCAL_SERVER_URL)).resolves.toBe(true);
    expect(state.awaitedCalls).toBe(0);
    expect(state.requestCalls).toBe(1);
  });

  it('returns false when the browser denies the prompt, on Chrome and Firefox', async () => {
    for (const kind of ['chrome', 'firefox'] as const) {
      reset(kind);
      state.deny = true;
      await expect(requestServerPermission(DEFAULT_LOCAL_SERVER_URL)).resolves.toBe(false);
      expect(state.granted.size).toBe(0);
    }
  });

  it('does not call request for an unparseable URL', async () => {
    await expect(requestServerPermission('not a url')).resolves.toBe(false);
    expect(state.requestCalls).toBe(0);
  });
});

describe('resolveEngineSourceSwitch', () => {
  const loopback = {
    localServerUrl: DEFAULT_LOCAL_SERVER_URL,
    localServerAllowRemote: false,
  };

  it('Firefox: confirming local-server persists the engine after a gesture-safe request', async () => {
    reset('firefox');
    const result = await resolveEngineSourceSwitch('local-server', loopback, { ack: true });
    expect(result).toEqual({
      denied: false,
      patch: { engineSource: 'local-server', localServerExperimentalAck: true },
    });
    expect(state.requestCalls).toBe(1);
    expect(state.awaitedCalls).toBe(0);
  });

  it('Firefox: a permission that is only requested after contains does not persist', async () => {
    reset('firefox');
    const result = await resolveEngineSourceSwitch('local-server', loopback, {
      ack: true,
      requestPermission: containsThenRequest,
    });
    expect(result).toEqual({ denied: true });
  });

  it('Chrome: confirming local-server persists the engine', async () => {
    reset('chrome');
    const result = await resolveEngineSourceSwitch('local-server', loopback, { ack: true });
    expect(result).toEqual({
      denied: false,
      patch: { engineSource: 'local-server', localServerExperimentalAck: true },
    });
  });

  it('does not persist when the permission prompt is denied', async () => {
    for (const kind of ['chrome', 'firefox'] as const) {
      reset(kind);
      state.deny = true;
      const result = await resolveEngineSourceSwitch('local-server', loopback, { ack: true });
      expect(result).toEqual({ denied: true });
    }
  });

  it('does not request permission when switching back to the built-in engine', async () => {
    const result = await resolveEngineSourceSwitch('in-browser', loopback);
    expect(result).toEqual({ denied: false, patch: { engineSource: 'in-browser' } });
    expect(state.requestCalls).toBe(0);
  });

  it('skips the host prompt for a remote URL until the off-machine confirmation is on', async () => {
    const remote = {
      localServerUrl: 'http://192.168.1.5:1234/v1',
      localServerAllowRemote: false,
    };
    const blocked = await resolveEngineSourceSwitch('local-server', remote, { ack: true });
    expect(blocked).toEqual({
      denied: false,
      patch: { engineSource: 'local-server', localServerExperimentalAck: true },
    });
    expect(state.requestCalls).toBe(0);

    const allowed = await resolveEngineSourceSwitch(
      'local-server',
      { ...remote, localServerAllowRemote: true },
      { ack: true },
    );
    expect(allowed.denied).toBe(false);
    expect(state.requestCalls).toBe(1);
  });
});
