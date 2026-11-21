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
 * Synchronous snapshot of the broad grant, so a later click can read it without awaiting
 * inside the click. The live permission stays the source of truth: `hasAllSitesAccess`
 * records this when it resolves, `requestAllSitesAccess` records the request result, and
 * `revokeAllSitesAccess` records the removal. Options, the popup, and the background call
 * `hasAllSitesAccess` on open and on `permissions.onAdded` / `onRemoved`, so the snapshot
 * is fresh wherever a request runs. It defaults to "not granted", so a click before the
 * first refresh still prompts.
 */
let allSitesAccessSnapshot = false;

/** Test hook: puts the snapshot back to the not-granted default so tests cannot leak it. */
export function resetAllSitesAccessSnapshot(): void {
  allSitesAccessSnapshot = false;
}

/**
 * An http/https host pattern the two broad origins cover: a host, wildcard host, or host
 * with a port, then `/*`. Any other scheme is not covered.
 */
const COVERED_HTTP_ORIGIN =
  /^https?:\/\/(?:\*|(?:\*\.)?(?:\[[0-9a-fA-F:.]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*))(?::\d{1,5})?\/\*$/u;

/**
 * True only when the snapshot says the broad grant is on and every requested origin is an
 * http/https host pattern the broad origins already cover. `permissions.contains` reports
 * such an origin as granted while the broad origins are active, but Chrome still shows a
 * prompt if the extension calls `permissions.request` for it, so callers treat this as
 * enough and turn the feature on without a request.
 */
export function allSitesGrantCoversOrigins(origins: readonly string[]): boolean {
  if (!allSitesAccessSnapshot) return false;
  return origins.length > 0 && origins.every((origin) => COVERED_HTTP_ORIGIN.test(origin));
}

/**
 * Optional host access for every http/https page. `permissions.request` must be the first
 * awaited extension call in the click that turns the control on — a prior `await`
 * (including `permissions.contains`) drops the user gesture and Chrome shows no prompt.
 */
export async function requestAllSitesAccess(): Promise<boolean> {
  const granted = await browser.permissions
    .request({ origins: allSitesPermissionOrigins() })
    .catch(() => false);
  allSitesAccessSnapshot = granted;
  return granted;
}

/**
 * Removes only the two broad origins. Chrome removes the patterns named in
 * `permissions.remove` from the active set, so a narrower origin the user granted on its
 * own (for example `https://www.youtube.com/*` before the all-sites grant) stays granted
 * and that feature keeps working. A feature that never had its own grant, and only worked
 * because the broad origin covered it, loses host access when the broad origin is removed;
 * its setting stays exactly as the reader set it. Captions and the mail banner are not
 * turned off, the narrower grants are not deleted, and none of them are re-requested
 * here — that call needs a user gesture and would prompt again. The next explicit enable,
 * with this control off, uses today's one-time prompt.
 */
export async function revokeAllSitesAccess(): Promise<void> {
  const remove = browser.permissions.remove;
  if (!remove) return;
  await remove({ origins: allSitesPermissionOrigins() }).catch(() => undefined);
  allSitesAccessSnapshot = false;
}

export async function hasAllSitesAccess(): Promise<boolean> {
  const granted = await browser.permissions
    .contains({ origins: allSitesPermissionOrigins() })
    .catch(() => false);
  allSitesAccessSnapshot = granted;
  return granted;
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
  getRegisteredContentScripts?: (filter?: {
    ids?: string[];
  }) => Promise<Array<{ id?: string; matches?: string[] }>>;
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

/** True when a registration already describes the current broad grant. */
function matchesAllSitesGrant(script: {
  id?: string | undefined;
  matches?: string[] | undefined;
}): boolean {
  if (script.id !== ALL_SITES_CONTENT_SCRIPT_ID) return false;
  const origins = script.matches;
  if (!origins) return true;
  const wanted = allSitesPermissionOrigins();
  return origins.length === wanted.length && wanted.every((origin) => origins.includes(origin));
}

/**
 * Live permission state is the source of truth, never a stored boolean. While the broad
 * origins are granted, the general bundle is registered for future top-frame http/https
 * loads; when they are absent — after the options control is turned off or the browser's
 * extension settings revoke them — the registration is removed so the next load is quiet.
 *
 * A newly appearing grant also sweeps already-open tabs once. `ensureContentScript` pings
 * first, so repeated syncs cannot execute the file twice into one page.
 */
async function runAllSitesSync(): Promise<void> {
  const scripting = browser.scripting as typeof browser.scripting & AllSitesScripting;
  const register = scripting.registerContentScripts;
  const unregister = scripting.unregisterContentScripts;
  if (!register || !unregister) return;

  const granted = await hasAllSitesAccess();
  const registered = await scripting
    .getRegisteredContentScripts?.({ ids: [ALL_SITES_CONTENT_SCRIPT_ID] })
    .catch(() => []);
  const alreadyRegistered = registered?.some(matchesAllSitesGrant) === true;

  // Do not tear down a registration that already matches the live state: another context
  // (options, popup, or the worker's permission listener) can be in the middle of its own
  // sync, and an unregister here would leave that context's grant without a bundle.
  if (granted && alreadyRegistered) {
    if (!openTabsSwept) {
      openTabsSwept = true;
      await injectAllSitesOpenTabs();
    }
    return;
  }
  if (!granted && !alreadyRegistered) {
    openTabsSwept = false;
    return;
  }

  await unregisterAllSitesContentScript();

  // The grant can land while the unregister is in flight — the options click resolves and
  // the worker's onAdded listener starts a second sync. Re-read before returning so a
  // no-grant answer from before that moment cannot leave the new grant unregistered.
  const stillGranted = await hasAllSitesAccess();
  if (!stillGranted) {
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

let syncInFlight: Promise<void> = Promise.resolve();

/**
 * Startup, permission events, and the UI can each start a sync at the same time. Queue them
 * in this context so their permission checks, unregisters, and registers cannot interleave.
 */
export function syncAllSitesContentScripts(): Promise<void> {
  const next = syncInFlight.then(runAllSitesSync, runAllSitesSync);
  syncInFlight = next.catch(() => undefined);
  return next;
}
