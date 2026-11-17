// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { installContentPortLifecycle } from '@/shared/content-port-lifecycle';
import {
  CONTENT_INSTANCE_DOC_ATTR,
  MAIL_BANNER_INSTANCE_DATASET,
  applyContentLoadGeneration,
  claimContentExtensionInstance,
  installContentInvalidationCleanup,
  isExtensionContextInvalidated,
  purgeForeignMailBannerHosts,
  registerLiveContentInstanceToken,
  removeOwnedMailBannerHosts,
  resetContentInstanceGlobalsForTests,
  stampMailBannerInstance,
  unregisterLiveContentInstanceToken,
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
    onMessage: {
      addListener: () => undefined,
    },
  }));
  resetContentInstanceGlobalsForTests();
  applyContentLoadGeneration('test-generation');
});

afterEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
  document.body.innerHTML = '';
  resetContentInstanceGlobalsForTests();
  vi.useRealTimers();
});

describe('content extension instance markers', () => {
  it('removes mail banner hosts whose owner is not registered live', () => {
    const orphan = document.createElement('sakutto-gmail');
    stampMailBannerInstance(orphan, 'instance-old');
    const current = document.createElement('sakutto-gmail');
    stampMailBannerInstance(current, 'instance-current');
    document.body.append(orphan, current);

    registerLiveContentInstanceToken('instance-current');
    purgeForeignMailBannerHosts(document, 'instance-current');
    expect(document.querySelectorAll('sakutto-gmail')).toHaveLength(1);
    expect((document.querySelector('sakutto-gmail') as HTMLElement).dataset).toHaveProperty(
      MAIL_BANNER_INSTANCE_DATASET,
      'instance-current',
    );
  });

  it('keeps hosts stamped by another bundle when both tokens are live', () => {
    const mailBundleToken = 'bundle-mail-token';
    const contentBundleToken = 'bundle-content-token';
    registerLiveContentInstanceToken(mailBundleToken);
    registerLiveContentInstanceToken(contentBundleToken);

    const host = document.createElement('sakutto-gmail');
    stampMailBannerInstance(host, mailBundleToken);
    document.body.append(host);

    purgeForeignMailBannerHosts(document, contentBundleToken);
    expect(document.querySelectorAll('sakutto-gmail')).toHaveLength(1);
    expect(browser.runtime.id).toBe('same-extension-id');
  });

  it('does not clear live tokens on the first generation message for this page', () => {
    resetContentInstanceGlobalsForTests();
    registerLiveContentInstanceToken('bundle-a');
    registerLiveContentInstanceToken('bundle-b');
    applyContentLoadGeneration('first-generation');
    applyContentLoadGeneration('first-generation');
    const host = document.createElement('sakutto-gmail');
    stampMailBannerInstance(host, 'bundle-a');
    document.body.append(host);
    purgeForeignMailBannerHosts(document, 'bundle-b');
    expect(document.querySelectorAll('sakutto-gmail')).toHaveLength(1);
  });

  it('drops non-live hosts after the background generation bumps', () => {
    registerLiveContentInstanceToken('reload-orphan-token');
    const previous = document.createElement('sakutto-gmail');
    stampMailBannerInstance(previous, 'reload-orphan-token');
    document.body.append(previous);

    applyContentLoadGeneration('reload-generation');

    const next = document.createElement('sakutto-gmail');
    stampMailBannerInstance(next, 'reload-current-token');
    document.body.append(next);
    purgeForeignMailBannerHosts(document, 'reload-current-token');
    expect(document.querySelectorAll('sakutto-gmail')).toHaveLength(1);
    expect((document.querySelector('sakutto-gmail') as HTMLElement).dataset).toHaveProperty(
      MAIL_BANNER_INSTANCE_DATASET,
      'reload-current-token',
    );
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
    const cleanup = installContentInvalidationCleanup(() => cleaned.push('done'), {
      initialReconnectMs: 200,
    });

    expect(connectMock).toHaveBeenCalledTimes(1);
    lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
    expect(isExtensionContextInvalidated()).toBe(false);
    disconnectListener?.();
    expect(cleaned).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(cleaned).toEqual([]);
    cleanup();
  });

  it('reconnects on a persisted pageshow without waiting for the retry timer', () => {
    vi.useFakeTimers();
    const cleaned: string[] = [];
    const uninstallPorts = installContentPortLifecycle();
    const cleanup = installContentInvalidationCleanup(() => cleaned.push('done'), {
      initialReconnectMs: 200,
    });

    lastError = undefined;
    disconnectListener?.();
    expect(connectMock).toHaveBeenCalledTimes(1);

    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);
    expect(connectMock).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(200);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(cleaned).toEqual([]);
    cleanup();
    uninstallPorts();
  });

  it('tears down once when the extension context is invalidated', () => {
    const cleaned: string[] = [];
    const token = 'invalidate-me';
    registerLiveContentInstanceToken(token);
    const cleanup = installContentInvalidationCleanup(() => {
      cleaned.push('done');
      unregisterLiveContentInstanceToken(token);
      removeOwnedMailBannerHosts(document, token);
      document.documentElement.removeAttribute(CONTENT_INSTANCE_DOC_ATTR);
    });

    const host = document.createElement('sakutto-gmail');
    stampMailBannerInstance(host, token);
    document.body.append(host);
    document.documentElement.setAttribute(CONTENT_INSTANCE_DOC_ATTR, token);

    lastError = { message: 'Extension context invalidated.' };
    expect(isExtensionContextInvalidated()).toBe(true);
    disconnectListener?.();
    expect(cleaned).toEqual(['done']);
    expect(document.querySelector('sakutto-gmail')).toBeNull();

    disconnectListener?.();
    expect(cleaned).toEqual(['done']);
    cleanup();
  });
});
