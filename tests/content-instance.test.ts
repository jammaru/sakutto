// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import {
  CONTENT_INSTANCE_DOC_ATTR,
  MAIL_BANNER_INSTANCE_DATASET,
  claimContentExtensionInstance,
  installContentInvalidationCleanup,
  isExtensionContextInvalidated,
  purgeForeignMailBannerHosts,
  removeOwnedMailBannerHosts,
  stampMailBannerInstance,
} from '@/shared/content-instance';

type RuntimeLastError = { message?: string } | undefined;

const connectMock = vi.fn();
let disconnectListener: (() => void) | null = null;
let lastError: RuntimeLastError;

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'same-extension-id',
      get lastError() {
        return lastError;
      },
      connect: (...args: unknown[]) => connectMock(...args),
    },
  },
}));

beforeEach(() => {
  lastError = undefined;
  disconnectListener = null;
  connectMock.mockReset();
  connectMock.mockImplementation(() => ({
    onDisconnect: {
      addListener: (listener: () => void) => {
        disconnectListener = listener;
      },
    },
  }));
});

afterEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('content extension instance markers', () => {
  it('removes mail banner hosts owned by another content-script instance', () => {
    const orphan = document.createElement('sakutto-gmail');
    stampMailBannerInstance(orphan, 'instance-old');
    const current = document.createElement('sakutto-gmail');
    stampMailBannerInstance(current, 'instance-current');
    document.body.append(orphan, current);

    purgeForeignMailBannerHosts(document, 'instance-current');
    expect(document.querySelectorAll('sakutto-gmail')).toHaveLength(1);
    expect((document.querySelector('sakutto-gmail') as HTMLElement).dataset).toHaveProperty(
      MAIL_BANNER_INSTANCE_DATASET,
      'instance-current',
    );
  });

  it('purges a different instance token even when runtime.id is unchanged', () => {
    const previous = document.createElement('sakutto-gmail');
    stampMailBannerInstance(previous, 'reload-orphan-token');
    const next = document.createElement('sakutto-gmail');
    stampMailBannerInstance(next, 'reload-current-token');
    document.body.append(previous, next);

    purgeForeignMailBannerHosts(document, 'reload-current-token');
    expect(document.querySelectorAll('sakutto-gmail')).toHaveLength(1);
    expect((document.querySelector('sakutto-gmail') as HTMLElement).dataset).toHaveProperty(
      MAIL_BANNER_INSTANCE_DATASET,
      'reload-current-token',
    );
    expect(browser.runtime.id).toBe('same-extension-id');
  });

  it('claims the page for the current content-script instance on documentElement', () => {
    document.documentElement.setAttribute(CONTENT_INSTANCE_DOC_ATTR, 'instance-old');
    claimContentExtensionInstance(document, 'instance-current');
    expect(document.documentElement.getAttribute(CONTENT_INSTANCE_DOC_ATTR)).toBe(
      'instance-current',
    );
  });

  it('does not tear down on service worker idle disconnect and reconnects', () => {
    vi.useFakeTimers();
    const cleaned: string[] = [];
    installContentInvalidationCleanup(() => cleaned.push('done'), { initialReconnectMs: 200 });

    expect(connectMock).toHaveBeenCalledTimes(1);
    lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
    expect(isExtensionContextInvalidated()).toBe(false);
    disconnectListener?.();
    expect(cleaned).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(cleaned).toEqual([]);
  });

  it('tears down once when the extension context is invalidated', () => {
    const cleaned: string[] = [];
    installContentInvalidationCleanup(() => cleaned.push('done'));

    const host = document.createElement('sakutto-gmail');
    stampMailBannerInstance(host, 'invalidate-me');
    document.body.append(host);
    document.documentElement.setAttribute(CONTENT_INSTANCE_DOC_ATTR, 'invalidate-me');

    lastError = { message: 'Extension context invalidated.' };
    expect(isExtensionContextInvalidated()).toBe(true);
    disconnectListener?.();
    expect(cleaned).toEqual(['done']);
    removeOwnedMailBannerHosts(document, 'invalidate-me');
    document.documentElement.removeAttribute(CONTENT_INSTANCE_DOC_ATTR);
    expect(document.querySelector('sakutto-gmail')).toBeNull();
    expect(document.documentElement.hasAttribute(CONTENT_INSTANCE_DOC_ATTR)).toBe(false);

    disconnectListener?.();
    expect(cleaned).toEqual(['done']);
  });
});
