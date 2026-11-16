// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTENT_INSTANCE_DOC_ATTR,
  MAIL_BANNER_INSTANCE_DATASET,
  claimContentExtensionInstance,
  installContentInvalidationCleanup,
  purgeForeignMailBannerHosts,
  removeOwnedMailBannerHosts,
  stampMailBannerInstance,
} from '@/shared/content-instance';

const disconnectListeners: Array<() => void> = [];

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'build-current',
      connect: vi.fn(() => ({
        onDisconnect: {
          addListener: (listener: () => void) => {
            disconnectListeners.push(listener);
          },
        },
      })),
    },
  },
}));

afterEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
  document.body.innerHTML = '';
  disconnectListeners.length = 0;
});

describe('content extension instance markers', () => {
  it('removes mail banner hosts owned by another build', () => {
    const orphan = document.createElement('sakutto-gmail');
    stampMailBannerInstance(orphan, 'build-old');
    const current = document.createElement('sakutto-gmail');
    stampMailBannerInstance(current, 'build-current');
    document.body.append(orphan, current);

    purgeForeignMailBannerHosts(document, 'build-current');
    expect(document.querySelectorAll('sakutto-gmail')).toHaveLength(1);
    expect((document.querySelector('sakutto-gmail') as HTMLElement).dataset).toHaveProperty(
      MAIL_BANNER_INSTANCE_DATASET,
      'build-current',
    );
  });

  it('claims the page for the current build on documentElement', () => {
    document.documentElement.setAttribute(CONTENT_INSTANCE_DOC_ATTR, 'build-old');
    claimContentExtensionInstance(document, 'build-current');
    expect(document.documentElement.getAttribute(CONTENT_INSTANCE_DOC_ATTR)).toBe('build-current');
  });

  it('runs invalidation cleanup when the liveness port disconnects', () => {
    const host = document.createElement('sakutto-gmail');
    stampMailBannerInstance(host, 'build-current');
    document.body.append(host);
    document.documentElement.setAttribute(CONTENT_INSTANCE_DOC_ATTR, 'build-current');

    const cleaned: string[] = [];
    installContentInvalidationCleanup(() => {
      cleaned.push('done');
      removeOwnedMailBannerHosts(document, 'build-current');
      document.documentElement.removeAttribute(CONTENT_INSTANCE_DOC_ATTR);
    });

    expect(disconnectListeners).toHaveLength(1);
    disconnectListeners[0]?.();
    expect(cleaned).toEqual(['done']);
    expect(document.querySelector('sakutto-gmail')).toBeNull();
    expect(document.documentElement.hasAttribute(CONTENT_INSTANCE_DOC_ATTR)).toBe(false);
  });
});
