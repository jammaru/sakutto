import { browser } from 'wxt/browser';
import { OPTIONAL_HOST_PERMISSIONS } from '@/shared/manifest';
import { looksLikePdfUrl } from '@/shared/pdf';
import { ensureContentScript } from '@/shared/page-bridge';
import { pageHost } from './sites';

/**
 * Runtime id for the general content bundle registered once the reader opts into all-sites
 * access. It must not collide with the mail ids or the caption custom-host id.
 */
export const ALL_SITES_CONTENT_SCRIPT_ID = 'sakutto-all-sites';
/** The same file `ensureContentScript` injects; the page guard makes double runs no-ops. */
export const ALL_SITES_CONTENT_SCRIPT_FILE = 'content-scripts/content.js';

/** The optional origins behind the opt-in: every normal http/https page. */
export function allSitesPermissionOrigins(): string[] {
  return [...OPTIONAL_HOST_PERMISSIONS];
}

export function allSitesOriginsOverlap(origins: readonly string[] | undefined): boolean {
  if (!origins || origins.length === 0) return false;
  const wanted = new Set(allSitesPermissionOrigins());
  return origins.some((origin) => wanted.has(origin));
}

/**
 * Optional host access for every http/https page. `permissions.request` must be the first
 * awaited extension call in the click that turns the control on — a prior `await`
 * (including `permissions.contains`) drops the user gesture and Chrome shows no prompt.
 */
export async function requestAllSitesAccess(): Promise<boolean> {
  return browser.permissions.request({ origins: allSitesPermissionOrigins() }).catch(() => false);
}

/** Removes only the two broad origins. Narrower site, mail, caption, and server origins stay. */
export async function revokeAllSitesAccess(): Promise<void> {
  const remove = browser.permissions.remove;
  if (!remove) return;
  await remove({ origins: allSitesPermissionOrigins() }).catch(() => undefined);
}

export async function hasAllSitesAccess(): Promise<boolean> {
  return browser.permissions.contains({ origins: allSitesPermissionOrigins() }).catch(() => false);
}

interface RegisteredAllSitesScript {
  id: string;
  js: string[];
  matches: string[];
  runAt: 'document_idle';
  persistAcrossSessions?: boolean;
}

interface AllSitesScripting {
  registerContentScripts?: (scripts: RegisteredAllSitesScript[]) => Promise<void>;
  unregisterContentScripts?: (filter?: { ids?: string[] }) => Promise<void>;
}

export async function unregisterAllSitesContentScript(): Promise<void> {
  const scripting = browser.scripting as typeof browser.scripting & AllSitesScripting;
  if (!scripting.unregisterContentScripts) return;
  await scripting
    .unregisterContentScripts({ ids: [ALL_SITES_CONTENT_SCRIPT_ID] })
    .catch(() => undefined);
}

/**
 * True for the tabs the registered script also covers: normal http/https documents, never
 * browser UI, the extension's own pages, or a URL Chrome's built-in PDF viewer would take.
 */
export function isAllSitesInjectableUrl(url: string): boolean {
  if (pageHost(url) === null) return false;
  return !looksLikePdfUrl(url);
}

/**
 * Injects the general bundle once into already-open tabs so they work without a reload.
 * `ensureContentScript` pings first, so a page that already runs the bundle — including one
 * the registration itself covered — is left alone and no second session can start.
 */
export async function injectAllSitesOpenTabs(): Promise<void> {
  if (!(await hasAllSitesAccess())) return;
  const tabs = await browser.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url) continue;
    if (!isAllSitesInjectableUrl(tab.url)) continue;
    void ensureContentScript(tab.id);
  }
}

/** Set while the broad origins are granted, so the open-tab sweep runs once per grant. */
let openTabsSwept = false;

/**
 * Live permission state is the source of truth, never a stored boolean. While the broad
 * origins are granted, the general bundle is registered for future top-frame http/https
 * loads; when they are absent — after the options control is turned off or the browser's
 * extension settings revoke them — the registration is removed so the next load is quiet.
 *
 * A newly appearing grant also sweeps already-open tabs once. `ensureContentScript` pings
 * first, so repeated syncs cannot execute the file twice into one page.
 */
export async function syncAllSitesContentScripts(): Promise<void> {
  const scripting = browser.scripting as typeof browser.scripting & AllSitesScripting;
  const register = scripting.registerContentScripts;
  const unregister = scripting.unregisterContentScripts;
  if (!register || !unregister) return;

  await unregisterAllSitesContentScript();

  const granted = await hasAllSitesAccess();
  if (!granted) {
    openTabsSwept = false;
    return;
  }

  const script: RegisteredAllSitesScript = {
    id: ALL_SITES_CONTENT_SCRIPT_ID,
    js: [ALL_SITES_CONTENT_SCRIPT_FILE],
    matches: allSitesPermissionOrigins(),
    runAt: 'document_idle',
  };
  // Top frame only: `allFrames` stays off, matching `ensureContentScript`'s default path.
  await register([{ ...script, persistAcrossSessions: true }]).catch(() =>
    register([script]).catch(() => undefined),
  );

  if (!openTabsSwept) {
    openTabsSwept = true;
    await injectAllSitesOpenTabs();
  }
}
