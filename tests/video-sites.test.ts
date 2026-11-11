import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  contains: false,
}));

vi.mock('wxt/browser', () => ({
  browser: {
    i18n: {
      getUILanguage: () => 'en-US',
      getMessage: () => '',
    },
    storage: {
      local: {
        get: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          const result: Record<string, unknown> = {};
          for (const name of keys) {
            if (state.values.has(name)) result[name] = state.values.get(name);
          }
          return result;
        },
        set: async (values: Record<string, unknown>) => {
          for (const [name, value] of Object.entries(values)) state.values.set(name, value);
        },
        remove: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const name of keys) state.values.delete(name);
        },
      },
      onChanged: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
    permissions: {
      contains: async () => state.contains,
      request: async () => false,
    },
  },
}));

const {
  captionEnableIntentPending,
  captionPermissionOrigins,
  captionOriginsOverlap,
  clearCaptionEnableIntent,
  isCaptionAutoHost,
  markCaptionEnableIntent,
  resolveCaptionToggle,
  settleCaptionEnableIntent,
  shouldAutoInjectCaptions,
} = await import('@/captions/sites');
const { loadSettings } = await import('@/shared/storage');

beforeEach(() => {
  state.values.clear();
  state.contains = false;
});

describe('caption auto-run gating', () => {
  it('auto-injects only YouTube and X when the setting and origin grant are on', () => {
    expect(
      shouldAutoInjectCaptions({
        settingOn: true,
        host: 'www.youtube.com',
        originAllowed: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoInjectCaptions({
        settingOn: true,
        host: 'x.com',
        originAllowed: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoInjectCaptions({
        settingOn: false,
        host: 'www.youtube.com',
        originAllowed: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoInjectCaptions({
        settingOn: true,
        host: 'www.youtube.com',
        originAllowed: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoInjectCaptions({
        settingOn: true,
        host: 'example.com',
        originAllowed: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoInjectCaptions({
        settingOn: true,
        host: 'videos.example.com',
        originAllowed: true,
        customHosts: ['*.example.com'],
      }),
    ).toBe(true);
    expect(
      shouldAutoInjectCaptions({
        settingOn: true,
        host: 'other.test',
        originAllowed: true,
        customHosts: ['example.com'],
      }),
    ).toBe(false);
  });

  it('requests the existing optional page origins, not twimg', () => {
    const origins = captionPermissionOrigins();
    expect(origins.some((origin) => origin.includes('youtube.com'))).toBe(true);
    expect(origins.some((origin) => origin.includes('x.com'))).toBe(true);
    expect(origins.some((origin) => origin.includes('twitter.com'))).toBe(true);
    expect(origins.join(' ')).not.toContain('twimg.com');
    expect(isCaptionAutoHost('music.youtube.com')).toBe(true);
    expect(captionOriginsOverlap(['https://www.youtube.com/*'])).toBe(true);
    expect(captionOriginsOverlap(['https://example.com/*'])).toBe(false);
  });
});

describe('caption toggle permission gate', () => {
  it('turns off without requesting host access', async () => {
    let requested = 0;
    await expect(
      resolveCaptionToggle(false, async () => {
        requested += 1;
        return true;
      }),
    ).resolves.toEqual({ on: false, denied: false });
    expect(requested).toBe(0);
  });

  it('turns on after host access is granted', async () => {
    await expect(resolveCaptionToggle(true, async () => true)).resolves.toEqual({
      on: true,
      denied: false,
    });
    expect((await loadSettings()).translateVideoCaptions).toBe(true);
    expect(await captionEnableIntentPending()).toBe(false);
  });

  it('reverts to off when the permission request is denied', async () => {
    await expect(resolveCaptionToggle(true, async () => false)).resolves.toEqual({
      on: false,
      denied: true,
    });
    expect((await loadSettings()).translateVideoCaptions).not.toBe(true);
    expect(await captionEnableIntentPending()).toBe(false);
  });

  it('records enable intent before the permission request resolves', async () => {
    let pendingDuringRequest = false;
    await resolveCaptionToggle(true, async () => {
      pendingDuringRequest = await captionEnableIntentPending();
      return true;
    });
    expect(pendingDuringRequest).toBe(true);
  });

  it('finishes enabling when the popup closed before the click saved', async () => {
    markCaptionEnableIntent();
    expect((await loadSettings()).translateVideoCaptions).toBe(false);
    await expect(
      settleCaptionEnableIntent({ grantedOrigins: captionPermissionOrigins() }),
    ).resolves.toEqual({ applied: true, on: true, denied: false });
    expect((await loadSettings()).translateVideoCaptions).toBe(true);
    expect(await captionEnableIntentPending()).toBe(false);
  });

  it('leaves the intent pending while the permission dialog is still open', async () => {
    markCaptionEnableIntent();
    state.contains = false;
    await expect(settleCaptionEnableIntent()).resolves.toEqual({
      applied: false,
      on: false,
      denied: false,
    });
    expect(await captionEnableIntentPending()).toBe(true);
    expect((await loadSettings()).translateVideoCaptions).toBe(false);
  });

  it('enables from contains after a grant that closed the popup', async () => {
    markCaptionEnableIntent();
    state.contains = true;
    await expect(settleCaptionEnableIntent()).resolves.toEqual({
      applied: true,
      on: true,
      denied: false,
    });
    expect((await loadSettings()).translateVideoCaptions).toBe(true);
  });

  it('does nothing when there is no pending intent', async () => {
    await clearCaptionEnableIntent();
    state.contains = true;
    await expect(settleCaptionEnableIntent()).resolves.toEqual({
      applied: false,
      on: false,
      denied: false,
    });
    expect((await loadSettings()).translateVideoCaptions).toBe(false);
  });
});
