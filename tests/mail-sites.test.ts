import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  granted: new Set<string>(),
  requestResult: false,
  requestOrigins: [] as string[],
  registered: [] as Array<
    Array<{
      id: string;
      js: string[];
      matches: string[];
      runAt: string;
      persistAcrossSessions?: boolean;
    }>
  >,
  unregistered: [] as Array<{ ids?: string[] } | undefined>,
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
      contains: async ({ origins }: { origins: string[] }) =>
        origins.every((origin) => state.granted.has(origin)),
      request: async ({ origins }: { origins: string[] }) => {
        state.requestOrigins = [...origins];
        return state.requestResult;
      },
    },
    scripting: {
      registerContentScripts: async (scripts: (typeof state.registered)[number]) => {
        state.registered.push(scripts);
      },
      unregisterContentScripts: async (filter?: { ids?: string[] }) => {
        state.unregistered.push(filter);
      },
    },
  },
}));

const {
  MAIL_BANNER_ENABLE_INTENT_KEY,
  MAIL_CONTENT_SCRIPT_FILE,
  MAIL_CONTENT_SCRIPT_ID,
  MAIL_EARLY_CONTENT_SCRIPT_FILE,
  MAIL_EARLY_CONTENT_SCRIPT_ID,
  grantedMailOrigins,
  hasMailHostAccess,
  hasMailOriginAccess,
  isMailHost,
  mailEnableIntentPending,
  mailOriginForHost,
  mailOriginsOverlap,
  mailPermissionOrigins,
  requestMailHostAccess,
  resolveMailBannerToggle,
  settleMailEnableIntent,
  syncMailContentScripts,
} = await import('@/dom/mail-sites');
const { MAIL_HOST_PATTERNS } = await import('@/shared/manifest');
const { loadSettings } = await import('@/shared/storage');

function grantAll(): void {
  state.granted = new Set(mailPermissionOrigins());
}

beforeEach(() => {
  state.values.clear();
  state.granted = new Set();
  state.requestResult = false;
  state.requestOrigins = [];
  state.registered = [];
  state.unregistered = [];
});

describe('mail host origins', () => {
  it('uses the shared mail patterns as runtime origins', () => {
    expect(mailPermissionOrigins()).toEqual([...MAIL_HOST_PATTERNS]);
    expect(mailPermissionOrigins().every((origin) => origin.startsWith('https://'))).toBe(true);
    expect(mailOriginsOverlap(['https://mail.google.com/*'])).toBe(true);
    expect(mailOriginsOverlap(['https://example.com/*'])).toBe(false);
    expect(mailOriginsOverlap(undefined)).toBe(false);
  });

  it('recognizes only the granted mail hosts', () => {
    expect(isMailHost('mail.google.com')).toBe(true);
    expect(isMailHost('MAIL.GOOGLE.COM')).toBe(true);
    expect(isMailHost('outlook.office365.com')).toBe(true);
    expect(isMailHost('inbox.mail.google.com')).toBe(false);
    expect(isMailHost('example.com')).toBe(false);
    expect(mailOriginForHost('outlook.live.com')).toBe('https://outlook.live.com/*');
    expect(mailOriginForHost('example.com')).toBeNull();
  });

  it('requests all mail origins without checking contains first', async () => {
    state.requestResult = true;
    await expect(requestMailHostAccess()).resolves.toBe(true);
    expect(state.requestOrigins).toEqual([...MAIL_HOST_PATTERNS]);
  });

  it('reports whole-set and per-host grants separately', async () => {
    state.granted = new Set(['https://mail.google.com/*']);
    await expect(hasMailHostAccess()).resolves.toBe(false);
    await expect(hasMailOriginAccess('mail.google.com')).resolves.toBe(true);
    await expect(hasMailOriginAccess('outlook.live.com')).resolves.toBe(false);
    grantAll();
    await expect(hasMailHostAccess()).resolves.toBe(true);
    await expect(grantedMailOrigins()).resolves.toEqual([...MAIL_HOST_PATTERNS]);
  });
});

describe('mail banner permission gate', () => {
  it('turns off without requesting host access', async () => {
    let requested = 0;
    await expect(
      resolveMailBannerToggle(false, async () => {
        requested += 1;
        return true;
      }),
    ).resolves.toEqual({ on: false, denied: false });
    expect(requested).toBe(0);
  });

  it('turns on after host access is granted', async () => {
    await expect(resolveMailBannerToggle(true, async () => true)).resolves.toEqual({
      on: true,
      denied: false,
    });
    expect((await loadSettings()).gmailTranslateBanner).toBe(true);
    expect(await mailEnableIntentPending()).toBe(false);
  });

  it('reverts to off when the permission request is denied', async () => {
    state.values.set('settings', { schemaVersion: 1, gmailTranslateBanner: false });
    await expect(resolveMailBannerToggle(true, async () => false)).resolves.toEqual({
      on: false,
      denied: true,
    });
    expect((await loadSettings()).gmailTranslateBanner).toBe(false);
    expect(await mailEnableIntentPending()).toBe(false);
  });

  it('records enable intent before the permission request resolves', async () => {
    let pendingDuringRequest = false;
    await resolveMailBannerToggle(true, async () => {
      pendingDuringRequest = await mailEnableIntentPending();
      return true;
    });
    expect(pendingDuringRequest).toBe(true);
  });

  it('finishes enabling when the popup closed before the click saved', async () => {
    state.values.set(MAIL_BANNER_ENABLE_INTENT_KEY, true);
    await expect(
      settleMailEnableIntent({ grantedOrigins: mailPermissionOrigins() }),
    ).resolves.toEqual({ applied: true, on: true, denied: false });
    expect((await loadSettings()).gmailTranslateBanner).toBe(true);
    expect(await mailEnableIntentPending()).toBe(false);
  });

  it('leaves the intent pending while the permission dialog is still open', async () => {
    state.values.set(MAIL_BANNER_ENABLE_INTENT_KEY, true);
    await expect(settleMailEnableIntent()).resolves.toEqual({
      applied: false,
      on: false,
      denied: false,
    });
    expect(await mailEnableIntentPending()).toBe(true);
  });
});

describe('mail content-script registration', () => {
  it('registers the early and idle bundles for every granted mail origin', async () => {
    grantAll();
    await syncMailContentScripts();

    expect(state.unregistered).toEqual([
      { ids: [MAIL_CONTENT_SCRIPT_ID, MAIL_EARLY_CONTENT_SCRIPT_ID] },
    ]);
    expect(state.registered).toEqual([
      [
        {
          id: MAIL_EARLY_CONTENT_SCRIPT_ID,
          js: [MAIL_EARLY_CONTENT_SCRIPT_FILE],
          matches: [...MAIL_HOST_PATTERNS],
          runAt: 'document_start',
          persistAcrossSessions: true,
        },
        {
          id: MAIL_CONTENT_SCRIPT_ID,
          js: [MAIL_CONTENT_SCRIPT_FILE],
          matches: [...MAIL_HOST_PATTERNS],
          runAt: 'document_idle',
          persistAcrossSessions: true,
        },
      ],
    ]);
  });

  it('registers only the granted subset and removes a revoked origin on the next sync', async () => {
    state.granted = new Set(['https://mail.google.com/*', 'https://outlook.office.com/*']);
    await syncMailContentScripts();
    expect(state.registered.at(-1)?.map((script) => script.matches)).toEqual([
      ['https://mail.google.com/*', 'https://outlook.office.com/*'],
      ['https://mail.google.com/*', 'https://outlook.office.com/*'],
    ]);

    state.granted.delete('https://outlook.office.com/*');
    await syncMailContentScripts();
    expect(state.registered.at(-1)?.map((script) => script.matches)).toEqual([
      ['https://mail.google.com/*'],
      ['https://mail.google.com/*'],
    ]);
    expect(state.unregistered).toHaveLength(2);
  });

  it('unregisters both bundles when no mail origin is granted', async () => {
    await syncMailContentScripts();
    expect(state.unregistered).toEqual([
      { ids: [MAIL_CONTENT_SCRIPT_ID, MAIL_EARLY_CONTENT_SCRIPT_ID] },
    ]);
    expect(state.registered).toEqual([]);
  });
});
