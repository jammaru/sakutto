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
      // Chrome semantics: a granted broad pattern covers every narrower http/https origin.
      contains: vi.fn(async ({ origins }: { origins: string[] }) => {
        if (state.broadGranted) return origins.every((origin) => origin.startsWith('http'));
        return origins.every((origin) => state.granted.has(origin));
      }),
      request: vi.fn(async ({ origins }: { origins: string[] }) => {
        state.requestOrigins = [...origins];
        return state.requestResult;
      }),
      remove: vi.fn(async ({ origins }: { origins: string[] }) => {
        state.removed.push(...origins);
      }),
    },
    scripting: {
      registerContentScripts: async (scripts: (typeof state.registered)[number]): Promise<void> => {
        if (
          state.registerRejectsPersist &&
          scripts.some((script) => script.persistAcrossSessions === true)
        ) {
          throw new Error('persistAcrossSessions is not supported');
        }
        state.registered.push(scripts);
      },
      unregisterContentScripts: async (filter?: { ids?: string[] }) => {
        state.unregistered.push(filter);
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
  allSitesPermissionOrigins,
  hasAllSitesAccess,
  injectAllSitesOpenTabs,
  isAllSitesInjectableUrl,
  requestAllSitesAccess,
  revokeAllSitesAccess,
  syncAllSitesContentScripts,
} = await import('@/dom/all-sites');
const { MAIL_CONTENT_SCRIPT_ID, MAIL_EARLY_CONTENT_SCRIPT_ID, syncMailContentScripts } =
  await import('@/dom/mail-sites');
const { MAIL_HOST_PATTERNS, OPTIONAL_HOST_PERMISSIONS } = await import('@/shared/manifest');

function grantBroad(): void {
  state.broadGranted = true;
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

  it('unregisters and registers nothing when the broad origins are absent', async () => {
    await syncAllSitesContentScripts();
    expect(state.unregistered).toEqual([{ ids: [ALL_SITES_CONTENT_SCRIPT_ID] }]);
    expect(state.registered).toEqual([]);
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
