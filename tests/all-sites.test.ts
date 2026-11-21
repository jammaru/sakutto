import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  broadGranted: false,
  requestOrigins: [] as string[],
  requestResult: false,
  removed: [] as string[],
  registered: [] as Array<
    Array<{
      id: string;
      js: string[];
      matches: string[];
      runAt: string;
      persistAcrossSessions?: boolean;
      allFrames?: boolean;
    }>
  >,
  unregistered: [] as Array<{ ids?: string[] } | undefined>,
  registerRejectsPersist: false,
  executed: [] as number[],
  injected: new Set<number>(),
  tabs: [] as Array<{ id?: number; url?: string }>,
  storage: new Map<string, unknown>(),
  registeredIds: new Set<string>(),
  registeredMatches: new Map<string, string[]>(),
  beforeRegister: undefined as (() => Promise<void>) | undefined,
  onUnregister: undefined as (() => void) | undefined,
}));

vi.mock('wxt/browser', () => ({
  browser: {
    i18n: {
      getUILanguage: () => 'en-US',
      getMessage: () => '',
    },
    runtime: {
      id: 'test-extension',
      get lastError() {
        return undefined;
      },
    },
    storage: {
      local: {
        get: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          const result: Record<string, unknown> = {};
          for (const name of keys) {
            if (state.storage.has(name)) result[name] = state.storage.get(name);
          }
          return result;
        },
        set: async (values: Record<string, unknown>) => {
          for (const [name, value] of Object.entries(values)) state.storage.set(name, value);
        },
        remove: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const name of keys) state.storage.delete(name);
        },
      },
      onChanged: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
    permissions: {
      // Chrome semantics: the store holds exactly what was granted, and a granted broad
      // pattern covers every narrower http/https origin.
      contains: vi.fn(async ({ origins }: { origins: string[] }) =>
        origins.every(
          (origin) =>
            state.granted.has(origin) || (state.broadGranted && origin.startsWith('http')),
        ),
      ),
      request: vi.fn(async ({ origins }: { origins: string[] }) => {
        state.requestOrigins = [...origins];
        if (state.requestResult) for (const origin of origins) state.granted.add(origin);
        return state.requestResult;
      }),
      remove: vi.fn(async ({ origins }: { origins: string[] }) => {
        state.removed.push(...origins);
        // The store deletes only the origins passed to remove; narrower grants stay.
        for (const origin of origins) {
          state.granted.delete(origin);
          if (origin === 'https://*/*' || origin === 'http://*/*') state.broadGranted = false;
        }
      }),
    },
    scripting: {
      registerContentScripts: async (scripts: (typeof state.registered)[number]): Promise<void> => {
        await state.beforeRegister?.();
        if (
          state.registerRejectsPersist &&
          scripts.some((script) => script.persistAcrossSessions === true)
        ) {
          throw new Error('persistAcrossSessions is not supported');
        }
        state.registered.push(scripts);
        for (const script of scripts) {
          state.registeredIds.add(script.id);
          state.registeredMatches.set(script.id, [...script.matches]);
        }
      },
      unregisterContentScripts: async (filter?: { ids?: string[] }) => {
        state.unregistered.push(filter);
        state.onUnregister?.();
        for (const id of filter?.ids ?? [...state.registeredIds]) {
          state.registeredIds.delete(id);
          state.registeredMatches.delete(id);
        }
      },
      getRegisteredContentScripts: async (filter?: { ids?: string[] }) => {
        const ids = filter?.ids ?? [...state.registeredIds];
        return ids
          .filter((id) => state.registeredIds.has(id))
          .map((id) => ({ id, matches: state.registeredMatches.get(id) }));
      },
      executeScript: vi.fn(async (options: { target: { tabId: number } }) => {
        state.executed.push(options.target.tabId);
        state.injected.add(options.target.tabId);
      }),
    },
    tabs: {
      query: async () => state.tabs,
      sendMessage: vi.fn(async (tabId: number) => {
        if (state.injected.has(tabId)) return { lang: 'en' };
        throw new Error('no content script in this tab');
      }),
    },
  },
}));

const {
  ALL_SITES_CONTENT_SCRIPT_FILE,
  ALL_SITES_CONTENT_SCRIPT_ID,
  allSitesGrantCoversOrigins,
  allSitesPermissionOrigins,
  hasAllSitesAccess,
  injectAllSitesOpenTabs,
  isAllSitesInjectableUrl,
  requestAllSitesAccess,
  resetAllSitesAccessSnapshot,
  revokeAllSitesAccess,
  syncAllSitesContentScripts,
} = await import('@/dom/all-sites');
const {
  MAIL_CONTENT_SCRIPT_ID,
  MAIL_EARLY_CONTENT_SCRIPT_ID,
  mailPermissionOrigins,
  requestMailHostAccess,
  resolveMailBannerToggle,
  syncMailContentScripts,
} = await import('@/dom/mail-sites');
const { captionPermissionOrigins, requestCaptionHostAccess, resolveCaptionToggle } =
  await import('@/captions/sites');
const { requestCaptionCustomHostAccess } = await import('@/captions/register-custom');
const { requestServerPermission } = await import('@/engine/local-server/permissions');
const { siteAccessOrigins } = await import('@/dom/sites');
const { loadSettings } = await import('@/shared/storage');
const { MAIL_HOST_PATTERNS, OPTIONAL_HOST_PERMISSIONS } = await import('@/shared/manifest');

function grantBroad(): void {
  state.broadGranted = true;
}

/** The options-page / popup flow: the open-time contains answer records the snapshot. */
async function recordBroadGrant(): Promise<void> {
  grantBroad();
  await hasAllSitesAccess();
}

const OPEN_TABS = [
  { id: 1, url: 'https://example.com/article' },
  { id: 2, url: 'http://127.0.0.1:4173/wiki.html' },
  { id: 3, url: 'chrome://extensions/' },
  { id: 4, url: 'about:blank' },
  { id: 5, url: 'chrome-extension://test-extension/popup.html' },
  { id: 6, url: 'https://example.com/report.pdf' },
];

beforeEach(async () => {
  state.granted = new Set();
  state.broadGranted = false;
  state.requestOrigins = [];
  state.requestResult = false;
  state.removed = [];
  state.registered = [];
  state.unregistered = [];
  state.registerRejectsPersist = false;
  state.executed = [];
  state.injected = new Set();
  state.tabs = [];
  state.storage.clear();
  state.registeredIds = new Set();
  state.registeredMatches = new Map();
  state.beforeRegister = undefined;
  state.onUnregister = undefined;
  // The all-sites snapshot is module state: every test starts at the not-granted default.
  resetAllSitesAccessSnapshot();
  // One sync while the broad origins are absent clears the open-tab sweep tracking, exactly
  // like the revoke that precedes a later grant.
  await syncAllSitesContentScripts();
  state.unregistered = [];
});

describe('all-sites optional origins', () => {
  it('uses exactly the manifest optional host permissions', () => {
    expect(allSitesPermissionOrigins()).toEqual(['https://*/*', 'http://*/*']);
    expect(allSitesPermissionOrigins()).toEqual([...OPTIONAL_HOST_PERMISSIONS]);
  });

  it('requests the broad origins with no prior awaited extension call', async () => {
    const { browser } = await import('wxt/browser');
    const contains = browser.permissions.contains as ReturnType<typeof vi.fn>;
    contains.mockClear();
    state.requestResult = true;

    // `permissions.request` must be the first awaited call in the enabling click; a prior
    // `permissions.contains` drops the user gesture and Chrome shows no prompt.
    await expect(requestAllSitesAccess()).resolves.toBe(true);
    expect(state.requestOrigins).toEqual(['https://*/*', 'http://*/*']);
    expect(contains.mock.calls).toHaveLength(0);
  });

  it('removes only the two broad origins on revoke', async () => {
    await revokeAllSitesAccess();
    expect(state.removed).toEqual(['https://*/*', 'http://*/*']);
  });

  it('reports the live grant state', async () => {
    await expect(hasAllSitesAccess()).resolves.toBe(false);
    grantBroad();
    await expect(hasAllSitesAccess()).resolves.toBe(true);
  });
});

describe('all-sites content-script registration', () => {
  it('registers the general bundle for the granted http/https patterns', async () => {
    grantBroad();
    await syncAllSitesContentScripts();

    expect(state.unregistered).toEqual([{ ids: [ALL_SITES_CONTENT_SCRIPT_ID] }]);
    expect(state.registered).toEqual([
      [
        {
          id: ALL_SITES_CONTENT_SCRIPT_ID,
          js: [ALL_SITES_CONTENT_SCRIPT_FILE],
          matches: ['https://*/*', 'http://*/*'],
          runAt: 'document_idle',
          persistAcrossSessions: true,
        },
      ],
    ]);
    // Top frame only: the registration never sets allFrames.
    expect(state.registered[0]?.[0]?.allFrames).toBeUndefined();
  });

  it('registers without persistAcrossSessions when the browser rejects the field', async () => {
    grantBroad();
    state.registerRejectsPersist = true;
    await syncAllSitesContentScripts();
    expect(state.registered).toEqual([
      [
        {
          id: ALL_SITES_CONTENT_SCRIPT_ID,
          js: [ALL_SITES_CONTENT_SCRIPT_FILE],
          matches: ['https://*/*', 'http://*/*'],
          runAt: 'document_idle',
        },
      ],
    ]);
  });

  it('leaves nothing to unregister when the broad origins are absent', async () => {
    await syncAllSitesContentScripts();
    // A startup sync with no grant must not touch a registration another context may
    // install a moment later, so an absent registration is left alone.
    expect(state.unregistered).toEqual([]);
    expect(state.registered).toEqual([]);
  });

  it('unregisters an existing bundle when the broad origins disappear', async () => {
    grantBroad();
    await syncAllSitesContentScripts();
    state.broadGranted = false;

    await syncAllSitesContentScripts();
    expect(state.unregistered.at(-1)).toEqual({ ids: [ALL_SITES_CONTENT_SCRIPT_ID] });
    expect(state.registered).toHaveLength(1);
    expect(state.registeredIds.has(ALL_SITES_CONTENT_SCRIPT_ID)).toBe(false);
  });

  it('keeps a matching registration on a repeated sync', async () => {
    grantBroad();
    await syncAllSitesContentScripts();
    await syncAllSitesContentScripts();

    // The second sync must not tear down and rebuild the first one's registration: an
    // options click and the worker's onAdded listener both sync for the same grant.
    expect(state.unregistered).toHaveLength(1);
    expect(state.registered).toHaveLength(1);
  });

  it('serializes syncs so a second one cannot unregister during the first register', async () => {
    grantBroad();
    let signalRegisterEntered: () => void = () => undefined;
    const registerEntered = new Promise<void>((resolve) => {
      signalRegisterEntered = resolve;
    });
    let releaseRegister: () => void = () => undefined;
    const registerGate = new Promise<void>((resolve) => {
      releaseRegister = resolve;
    });
    state.beforeRegister = async () => {
      signalRegisterEntered();
      await registerGate;
    };

    const first = syncAllSitesContentScripts();
    await registerEntered;
    const second = syncAllSitesContentScripts();
    releaseRegister();
    await Promise.all([first, second]);

    expect(state.unregistered).toHaveLength(1);
    expect(state.registered).toHaveLength(1);
  });

  it('registers when the grant lands during an in-flight unregister', async () => {
    grantBroad();
    await syncAllSitesContentScripts();
    state.broadGranted = false;
    state.onUnregister = () => grantBroad();

    await syncAllSitesContentScripts();
    expect(state.registered).toHaveLength(2);
    expect(state.registeredIds.has(ALL_SITES_CONTENT_SCRIPT_ID)).toBe(true);
  });

  it('is a no-op on a browser without registerContentScripts', async () => {
    const { browser } = await import('wxt/browser');
    const scripting = browser.scripting as unknown as Record<string, unknown>;
    const register = scripting.registerContentScripts;
    const unregister = scripting.unregisterContentScripts;
    delete scripting.registerContentScripts;
    delete scripting.unregisterContentScripts;
    grantBroad();
    try {
      await expect(syncAllSitesContentScripts()).resolves.toBeUndefined();
      expect(state.registered).toEqual([]);
    } finally {
      scripting.registerContentScripts = register;
      scripting.unregisterContentScripts = unregister;
    }
  });
});

describe('already-open tabs after a grant', () => {
  it('injects once into injectable http/https tabs and skips restricted ones', async () => {
    grantBroad();
    state.tabs = OPEN_TABS;
    await syncAllSitesContentScripts();
    expect(state.executed).toEqual([1, 2]);
  });

  it('skips a tab that already answers the page ping', async () => {
    grantBroad();
    state.tabs = OPEN_TABS;
    state.injected = new Set([1, 2]);
    await syncAllSitesContentScripts();
    expect(state.executed).toEqual([]);
  });

  it('sweeps once per grant and again after a revoke restores the grant', async () => {
    grantBroad();
    state.tabs = OPEN_TABS;
    await syncAllSitesContentScripts();
    expect(state.executed).toEqual([1, 2]);

    // A later resync (startup, onInstalled, onAdded) must not execute the file again.
    await syncAllSitesContentScripts();
    expect(state.executed).toEqual([1, 2]);

    // A revoke ends the sweep coverage; the next grant sweeps the still-open tabs again.
    state.broadGranted = false;
    await syncAllSitesContentScripts();
    grantBroad();
    // Tab 2 kept its script; tab 1 lost it with the revoke-era reload, so only it re-runs.
    state.injected = new Set([2]);
    await syncAllSitesContentScripts();
    expect(state.executed).toEqual([1, 2, 1]);
  });

  it('sweeps only while the broad origins are granted', async () => {
    state.tabs = OPEN_TABS;
    await injectAllSitesOpenTabs();
    expect(state.executed).toEqual([]);
  });
});

describe('restricted URLs', () => {
  it('accepts normal pages and rejects browser UI, extension pages, and PDF-looking URLs', () => {
    expect(isAllSitesInjectableUrl('https://example.com/article')).toBe(true);
    expect(isAllSitesInjectableUrl('http://127.0.0.1:4173/wiki.html')).toBe(true);
    expect(isAllSitesInjectableUrl('chrome://extensions/')).toBe(false);
    expect(isAllSitesInjectableUrl('about:blank')).toBe(false);
    expect(isAllSitesInjectableUrl('chrome-extension://abc/popup.html')).toBe(false);
    expect(isAllSitesInjectableUrl('file:///tmp/report.pdf')).toBe(false);
    expect(isAllSitesInjectableUrl('https://example.com/report.pdf')).toBe(false);
  });
});

describe('broad grant versus the mail bundles', () => {
  it('does not register the mail bundles from a broad grant while the banner setting is off', async () => {
    grantBroad();
    state.storage.set('settings', { schemaVersion: 1, gmailTranslateBanner: false });
    await syncMailContentScripts();
    expect(state.unregistered).toEqual([
      { ids: [MAIL_CONTENT_SCRIPT_ID, MAIL_EARLY_CONTENT_SCRIPT_ID] },
    ]);
    expect(state.registered).toEqual([]);
  });

  it('registers the mail bundles when the banner setting is already on', async () => {
    grantBroad();
    state.storage.set('settings', { schemaVersion: 1, gmailTranslateBanner: true });
    await syncMailContentScripts();
    expect(state.registered.at(-1)?.map((script) => script.matches)).toEqual([
      [...MAIL_HOST_PATTERNS],
      [...MAIL_HOST_PATTERNS],
    ]);
  });

  it('keeps registering narrow mail grants without the banner setting', async () => {
    // Today's behavior: without the broad origin, a granted mail origin registers the
    // bundles regardless of the banner flag, so it must not change.
    state.granted = new Set(MAIL_HOST_PATTERNS);
    await syncMailContentScripts();
    expect(state.registered.at(-1)?.map((script) => script.matches)).toEqual([
      [...MAIL_HOST_PATTERNS],
      [...MAIL_HOST_PATTERNS],
    ]);
  });
});

describe('the broad grant covering later per-site requests', () => {
  it('records the snapshot from the live contains answer', async () => {
    expect(allSitesGrantCoversOrigins(['https://example.com/*'])).toBe(false);
    await recordBroadGrant();
    expect(allSitesGrantCoversOrigins(['https://example.com/*'])).toBe(true);
    state.broadGranted = false;
    await hasAllSitesAccess();
    expect(allSitesGrantCoversOrigins(['https://example.com/*'])).toBe(false);
  });

  it('records the snapshot only from the request result', async () => {
    state.requestResult = false;
    await expect(requestAllSitesAccess()).resolves.toBe(false);
    expect(allSitesGrantCoversOrigins(['https://example.com/*'])).toBe(false);
    state.requestResult = true;
    await expect(requestAllSitesAccess()).resolves.toBe(true);
    expect(allSitesGrantCoversOrigins(['https://example.com/*'])).toBe(true);
  });

  it('covers only http/https host patterns', async () => {
    await recordBroadGrant();
    expect(allSitesGrantCoversOrigins(['https://www.youtube.com/*'])).toBe(true);
    expect(allSitesGrantCoversOrigins(['http://127.0.0.1:4173/*'])).toBe(true);
    expect(allSitesGrantCoversOrigins(['https://*.example.com/*'])).toBe(true);
    const siteOrigins = siteAccessOrigins('https://example.com/article');
    expect(siteOrigins).toEqual(['https://example.com/*', 'http://example.com/*']);
    expect(allSitesGrantCoversOrigins(siteOrigins ?? [])).toBe(true);
    expect(allSitesGrantCoversOrigins(['file:///tmp/report.pdf'])).toBe(false);
    expect(allSitesGrantCoversOrigins(['chrome-extension://test-extension/popup.html'])).toBe(
      false,
    );
    expect(allSitesGrantCoversOrigins(['https://example.com/report.pdf/*'])).toBe(false);
    expect(allSitesGrantCoversOrigins([])).toBe(false);
  });

  it('skips caption, mail, custom-caption, and local-server requests once recorded', async () => {
    await recordBroadGrant();
    const { browser } = await import('wxt/browser');
    const contains = browser.permissions.contains as ReturnType<typeof vi.fn>;
    const request = browser.permissions.request as ReturnType<typeof vi.fn>;
    contains.mockClear();
    request.mockClear();

    await expect(requestCaptionHostAccess()).resolves.toBe(true);
    await expect(requestMailHostAccess()).resolves.toBe(true);
    await expect(requestCaptionCustomHostAccess('videos.example.com')).resolves.toBe(true);
    await expect(requestServerPermission('http://127.0.0.1:8080/v1')).resolves.toBe(true);
    expect(request.mock.calls).toHaveLength(0);
    expect(contains.mock.calls).toHaveLength(0);
  });

  it('still turns the caption and mail settings on after a skipped request', async () => {
    await recordBroadGrant();
    await expect(resolveCaptionToggle(true)).resolves.toEqual({ on: true, denied: false });
    await expect(resolveMailBannerToggle(true)).resolves.toEqual({ on: true, denied: false });
    const settings = await loadSettings();
    expect(settings.translateVideoCaptions).toBe(true);
    expect(settings.gmailTranslateBanner).toBe(true);
  });

  it('still requests each origin set, with no contains first, while the grant is off', async () => {
    const { browser } = await import('wxt/browser');
    const contains = browser.permissions.contains as ReturnType<typeof vi.fn>;
    const request = browser.permissions.request as ReturnType<typeof vi.fn>;
    contains.mockClear();
    request.mockClear();
    state.requestResult = true;

    await expect(requestCaptionHostAccess()).resolves.toBe(true);
    expect(request.mock.calls.at(-1)).toEqual([{ origins: captionPermissionOrigins() }]);
    await expect(requestMailHostAccess()).resolves.toBe(true);
    expect(request.mock.calls.at(-1)).toEqual([{ origins: mailPermissionOrigins() }]);
    await expect(requestCaptionCustomHostAccess('videos.example.com')).resolves.toBe(true);
    expect(request.mock.calls.at(-1)).toEqual([
      { origins: ['https://videos.example.com/*', 'http://videos.example.com/*'] },
    ]);
    await expect(requestServerPermission('http://127.0.0.1:8080/v1')).resolves.toBe(true);
    expect(request.mock.calls.at(-1)).toEqual([{ origins: ['http://127.0.0.1/*'] }]);
    expect(contains.mock.calls).toHaveLength(0);
  });

  it('covers the popup always-translate click and the grant page', () => {
    const popup = readFileSync(new URL('../src/entrypoints/popup/App.svelte', import.meta.url), {
      encoding: 'utf8',
    });
    const grant = readFileSync(new URL('../src/entrypoints/grant/App.svelte', import.meta.url), {
      encoding: 'utf8',
    });

    // The popup click: the broad grant alone turns the rule on, and the request is the
    // same statement's other branch, so permissions.request stays the first awaited call
    // in that click whenever a prompt is still needed.
    const setAlwaysStart = popup.indexOf('async function setAlways');
    const setAlwaysBody = popup.slice(
      setAlwaysStart,
      popup.indexOf('async function ', setAlwaysStart + 1),
    );
    expect(setAlwaysBody).toMatch(
      /allSitesGrantCoversOrigins\(origins\)\s*\?\s*true\s*:\s*await browser\.permissions\.request\(\{ origins \}\)/u,
    );
    const beforePopupGranted = setAlwaysBody.slice(0, setAlwaysBody.indexOf('const granted'));
    expect(beforePopupGranted).not.toMatch(/\bawait\b/);

    // The grant page: same shape inside allow(), and the all-sites snapshot is recorded
    // while the page opens, never inside the Allow click.
    const allowBody = grant.slice(grant.indexOf('async function allow'));
    expect(allowBody).toMatch(
      /allSitesGrantCoversOrigins\(origins\)\s*\?\s*true\s*:\s*await browser\.permissions\.request\(\{ origins \}\)/u,
    );
    const beforeGrantGranted = allowBody.slice(0, allowBody.indexOf('const granted'));
    expect(beforeGrantGranted).not.toMatch(/\bawait\b/);
    expect(grant).toContain('void hasAllSitesAccess()');
  });

  it('revokes only the two broad origins and keeps an earlier narrow grant', async () => {
    // The caption toggle granted the YouTube/X origins on their own, before the all-sites
    // choice.
    state.requestResult = true;
    await requestCaptionHostAccess();
    state.requestResult = false;
    // Then the all-sites choice granted the two broad origins.
    await recordBroadGrant();
    // Turning the choice off removes only the broad origins.
    await revokeAllSitesAccess();
    expect(state.removed).toEqual(['https://*/*', 'http://*/*']);
    // The narrow caption grant the reader made earlier still reports as granted...
    expect(state.granted.has('https://www.youtube.com/*')).toBe(true);
    const { browser } = await import('wxt/browser');
    await expect(
      browser.permissions.contains({ origins: ['https://www.youtube.com/*'] }),
    ).resolves.toBe(true);
    await expect(browser.permissions.contains({ origins: ['https://*/*'] })).resolves.toBe(false);
    // ...and the snapshot is back to not-granted, so a later per-site click prompts again.
    expect(allSitesGrantCoversOrigins(['https://www.youtube.com/*'])).toBe(false);
  });

  it('registers the mail bundles from the broad grant without a new permissions request', async () => {
    grantBroad();
    state.storage.set('settings', { schemaVersion: 1, gmailTranslateBanner: true });
    const { browser } = await import('wxt/browser');
    const request = browser.permissions.request as ReturnType<typeof vi.fn>;
    request.mockClear();
    await syncMailContentScripts();
    expect(state.registered.at(-1)?.map((script) => script.matches)).toEqual([
      [...MAIL_HOST_PATTERNS],
      [...MAIL_HOST_PATTERNS],
    ]);
    expect(request.mock.calls).toHaveLength(0);
  });
});

describe('background wiring', () => {
  it('resyncs the all-sites registration next to the mail sync on every lifecycle path', () => {
    const source = readFileSync(new URL('../src/entrypoints/background.ts', import.meta.url), {
      encoding: 'utf8',
    });
    const onAdded = /browser\.permissions\.onAdded\?\.addListener\([\s\S]*?\}\);/.exec(source)?.[0];
    const onRemoved =
      /browser\.permissions\.onRemoved\?\.addListener\(\(\) => \{[\s\S]*?\}\);/.exec(source)?.[0];
    expect(onAdded).toBeDefined();
    expect(onRemoved).toBeDefined();
    for (const listener of [onAdded, onRemoved]) {
      expect(listener).toContain('syncMailContentScripts()');
      expect(listener).toContain('syncAllSitesContentScripts()');
    }
    // The settings bootstrap at startup, onInstalled, and onStartup each resync too.
    const startup = source.match(
      /void ensureSettings\(\)\.then\(\(settings\) => \{[\s\S]*?\}\);/,
    )?.[0];
    expect(startup).toContain('syncAllSitesContentScripts()');
    expect(source).toMatch(
      /await syncMailContentScripts\(\);\s*\n\s*await syncAllSitesContentScripts\(\);/,
    );
    expect(source).toMatch(
      /void syncMailContentScripts\(\);\s*\n\s*void syncAllSitesContentScripts\(\);\s*\n\s*\}\);/,
    );
  });

  it('reports the all-sites grant with the shortcut bindings a page reads', () => {
    const source = readFileSync(new URL('../src/entrypoints/background.ts', import.meta.url), {
      encoding: 'utf8',
    });
    expect(source).toContain('hasAllSitesAccess');
    expect(source).toMatch(/allSitesAccess: await hasAllSitesAccess\(\),/);
  });
});

describe('options toggle wiring', () => {
  it('reports the grant only after the registration sync has resolved', () => {
    const source = readFileSync(new URL('../src/ui/SettingsFields.svelte', import.meta.url), {
      encoding: 'utf8',
    });
    const body = source.slice(source.indexOf('function setAllSites'), source.indexOf('onMount('));
    expect(body).toContain('await requestAllSitesAccess()');
    expect(body).toContain('await revokeAllSitesAccess()');
    // A checked control means the bundle is registered, not just that the prompt was
    // answered — the e2e spec reads it as the moment to assert the live registration.
    expect(body.indexOf('await syncAllSitesContentScripts();')).toBeLessThan(
      body.indexOf('allSitesGranted = true;'),
    );
    const revoke = body.indexOf('await revokeAllSitesAccess()');
    expect(body.indexOf('await syncAllSitesContentScripts();', revoke)).toBeLessThan(
      body.indexOf('allSitesGranted = false;', revoke),
    );
  });
});

describe('content wiring for the passive injection', () => {
  const source = readFileSync(new URL('../src/content/main.ts', import.meta.url), {
    encoding: 'utf8',
  });

  it('keeps the passive injection quiet on a never host until an explicit action', () => {
    // Suppression follows the live rule, and only a lack of explicit activation keeps it on.
    expect(source).toMatch(
      /const suppress = liveRule\.auto === 'never' && !explicitActivationSeen;/,
    );
    // The explicit paths (popup state, popup/context-menu/command) lift it again.
    expect(source).toMatch(
      /if \(isPageStateRequest\(message\)\) \{\s*\n\s*\/\/ Only the popup asks for page state: this is an explicit look at the page\.\s*\n\s*markExplicitPageActivation\(\);/,
    );
    expect(source).toMatch(
      /if \(!isPageCommandRequest\(message\)\) return;\s*\n\s*\/\/ A command is the popup, a context menu, or an assigned browser command\.\s*\n\s*markExplicitPageActivation\(\);/,
    );
  });

  it('wires page-owned shortcut listeners only under the passive all-sites grant', () => {
    const shortcuts = readFileSync(new URL('../src/shared/shortcuts.ts', import.meta.url), {
      encoding: 'utf8',
    });
    // The page listener uses the strict gate: an assigned or user-cleared key stays off.
    expect(shortcuts).toContain('usesInPageFallback');
    expect(shortcuts).toContain('inPageFallbackShortcut');
    expect(source).toContain('inPageFallbackShortcut');
    expect(source).toContain('shortcutAssigned = state.assigned');
    expect(source).toContain('allSitesAccess = state.allSitesAccess === true');
    // Every page-owned command branch is guarded by the grant read from the background.
    expect(source).toMatch(/pageKey: \(event\) =>\s*\n\s*allSitesAccess &&/);
    expect(source).toMatch(/bilingualKey: \(event\) =>\s*\n\s*allSitesAccess &&/);
    expect(source).toMatch(/selectionKey: \(event\) =>\s*\n\s*allSitesAccess &&/);
    expect(source).toMatch(/composeKey: \(event\) =>\s*\n\s*allSitesAccess &&/);
    expect(source).toContain("pageCommandBridge.deliver?.('compose', source)");
    expect(source).toContain('onPageCommand: (command) => pageCommandBridge.deliver?.(command)');
  });

  it('offers an existing selection once on every injection path and never translates the page by it', () => {
    const offer = /A selection made before[\s\S]*?else session\.offerExistingSelection\(\);/.exec(
      source,
    )?.[0];
    expect(offer).toBeDefined();
    expect(offer).not.toContain('translate(');
    // The only automatic full-page translation stays the site rule's auto: 'always'.
    const autoBlock =
      /if \(rule\.auto === 'always'\) \{[\s\S]*?void session\.translate\(\);[\s\S]*?\}/.exec(
        source,
      )?.[0];
    expect(autoBlock).toBeDefined();
    expect(source.match(/session\.translate\(/g)).toHaveLength(1);
  });
});
