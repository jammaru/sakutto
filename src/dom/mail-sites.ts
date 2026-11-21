import { browser } from 'wxt/browser';
import { allSitesGrantCoversOrigins, hasAllSitesAccess } from '@/dom/all-sites';
import { MAIL_HOST_PATTERNS } from '@/shared/manifest';
import { loadSettings, saveSettings } from '@/shared/storage';

/** Runtime content-script IDs. The pairs are registered only for granted mail origins. */
export const MAIL_CONTENT_SCRIPT_ID = 'sakutto-mail';
export const MAIL_EARLY_CONTENT_SCRIPT_ID = 'sakutto-mail-early';
export const MAIL_CONTENT_SCRIPT_FILE = 'content-scripts/mail.js';
export const MAIL_EARLY_CONTENT_SCRIPT_FILE = 'content-scripts/mail-early.js';

/** Stored while Chrome's permission prompt is open so a closed popup can finish enabling. */
export const MAIL_BANNER_ENABLE_INTENT_KEY = 'mailBannerEnableIntent';

const MAIL_ORIGIN_HOSTS = MAIL_HOST_PATTERNS.map((origin) => ({
  origin,
  host: new URL(origin.replaceAll('*', '')).hostname.toLowerCase(),
}));

function normalizedHost(host: string): string {
  return host.trim().replace(/\.$/u, '').toLowerCase();
}

/** True for exactly the hosts covered by `MAIL_HOST_PATTERNS`. */
export function isMailHost(host: string): boolean {
  const normalized = normalizedHost(host);
  return MAIL_ORIGIN_HOSTS.some((entry) => entry.host === normalized);
}

/** The optional origin that covers `host`, or null for a non-mail host. */
export function mailOriginForHost(host: string): string | null {
  const normalized = normalizedHost(host);
  return MAIL_ORIGIN_HOSTS.find((entry) => entry.host === normalized)?.origin ?? null;
}

/** Origins requested when the reader enables Gmail/Outlook translation. */
export function mailPermissionOrigins(): string[] {
  return [...MAIL_HOST_PATTERNS];
}

export function mailOriginsOverlap(origins: readonly string[] | undefined): boolean {
  if (!origins || origins.length === 0) return false;
  const wanted = new Set(mailPermissionOrigins());
  return origins.some((origin) => wanted.has(origin));
}

/**
 * Optional host access for the mail hosts. `permissions.request` must be the first awaited
 * extension call in the click that turns the banner on — a prior `await` (including
 * `permissions.contains`) drops the user gesture and Chrome shows no prompt. A broad
 * all-sites grant already covers these https origins and requesting them would still
 * prompt, so the grant alone turns the banner on and no request runs.
 */
export async function requestMailHostAccess(): Promise<boolean> {
  const origins = mailPermissionOrigins();
  if (allSitesGrantCoversOrigins(origins)) return true;
  return browser.permissions.request({ origins }).catch(() => false);
}

export async function hasMailHostAccess(): Promise<boolean> {
  const origins = mailPermissionOrigins();
  return browser.permissions.contains({ origins }).catch(() => false);
}

/** Whether the one origin that covers this mail host is currently granted. */
export async function hasMailOriginAccess(host: string): Promise<boolean> {
  const origin = mailOriginForHost(host);
  if (!origin) return false;
  return browser.permissions.contains({ origins: [origin] }).catch(() => false);
}

export interface MailBannerToggleDecision {
  on: boolean;
  denied: boolean;
}

/** Fire-and-forget: must not be awaited before `permissions.request`. */
export function markMailEnableIntent(): void {
  void browser.storage.local.set({ [MAIL_BANNER_ENABLE_INTENT_KEY]: true });
}

export async function clearMailEnableIntent(): Promise<void> {
  await browser.storage.local.remove(MAIL_BANNER_ENABLE_INTENT_KEY).catch(() => undefined);
}

export async function mailEnableIntentPending(): Promise<boolean> {
  const stored = (await browser.storage.local
    .get(MAIL_BANNER_ENABLE_INTENT_KEY)
    .catch(() => ({}))) as {
    [MAIL_BANNER_ENABLE_INTENT_KEY]?: unknown;
  };
  return stored[MAIL_BANNER_ENABLE_INTENT_KEY] === true;
}

/**
 * Completes a mail-enable click that Chrome aborted by closing the popup.
 * Only turns the setting on when the hosts are already granted. A still-open
 * permission dialog leaves the intent pending instead of treating it as a denial.
 */
export async function settleMailEnableIntent(options?: {
  grantedOrigins?: readonly string[];
}): Promise<MailBannerToggleDecision & { applied: boolean }> {
  if (!(await mailEnableIntentPending())) {
    return { applied: false, on: false, denied: false };
  }
  const granted = mailOriginsOverlap(options?.grantedOrigins) || (await hasMailHostAccess());
  if (!granted) return { applied: false, on: false, denied: false };
  await saveSettings({ gmailTranslateBanner: true });
  await clearMailEnableIntent();
  return { applied: true, on: true, denied: false };
}

/**
 * Turns the mail banner on only after optional host access is granted in this click.
 * A denial leaves the setting off so the switch can revert.
 *
 * Chrome closes the toolbar popup when `permissions.request` opens its prompt, so this
 * records an enable intent *before* the request (no `await`) and writes the setting as
 * soon as the grant lands. `settleMailEnableIntent` finishes the same click if the
 * popup never sees the promise resolve.
 */
export async function resolveMailBannerToggle(
  nextOn: boolean,
  requestAccess: () => Promise<boolean> = requestMailHostAccess,
): Promise<MailBannerToggleDecision> {
  if (!nextOn) {
    void clearMailEnableIntent();
    return { on: false, denied: false };
  }
  markMailEnableIntent();
  const granted = await requestAccess();
  if (!granted) {
    await clearMailEnableIntent();
    return { on: false, denied: true };
  }
  await saveSettings({ gmailTranslateBanner: true });
  await clearMailEnableIntent();
  return { on: true, denied: false };
}

interface RegisteredMailScript {
  id: string;
  js: string[];
  matches: string[];
  runAt: 'document_start' | 'document_idle';
  persistAcrossSessions?: boolean;
}

interface MailScripting {
  registerContentScripts?: (scripts: RegisteredMailScript[]) => Promise<void>;
  unregisterContentScripts?: (filter?: { ids?: string[] }) => Promise<void>;
}

/** Only the mail origins the browser has actually granted. */
export async function grantedMailOrigins(grantedOrigins?: readonly string[]): Promise<string[]> {
  if (grantedOrigins && mailOriginsOverlap(grantedOrigins)) {
    const granted = new Set(grantedOrigins);
    return mailPermissionOrigins().filter((origin) => granted.has(origin));
  }

  const checks = await Promise.all(
    mailPermissionOrigins().map(async (origin) => ({
      origin,
      granted: await browser.permissions.contains({ origins: [origin] }).catch(() => false),
    })),
  );
  return checks.filter((entry) => entry.granted).map((entry) => entry.origin);
}

export async function unregisterMailContentScripts(): Promise<void> {
  const scripting = browser.scripting as typeof browser.scripting & MailScripting;
  if (!scripting.unregisterContentScripts) return;
  await scripting
    .unregisterContentScripts({
      ids: [MAIL_CONTENT_SCRIPT_ID, MAIL_EARLY_CONTENT_SCRIPT_ID],
    })
    .catch(() => undefined);
}

/**
 * Registers the idle and document_start mail bundles for exactly the granted origins.
 * Re-running it after a grant or removal replaces the previous registration, so a host
 * the reader revoked no longer receives the mail scripts.
 */
export async function syncMailContentScripts(grantedOrigins?: readonly string[]): Promise<void> {
  const scripting = browser.scripting as typeof browser.scripting & MailScripting;
  const register = scripting.registerContentScripts;
  const unregister = scripting.unregisterContentScripts;
  if (!register || !unregister) return;

  await unregisterMailContentScripts();

  const matches = await grantedMailOrigins(grantedOrigins);
  if (matches.length === 0) return;

  // The broad all-sites origin makes every mail origin report as granted. The mail bundles
  // exist for the banner, so a broad grant alone must not register them: without the banner
  // setting they would be redundant with the all-sites script on ordinary pages. Narrow
  // grants — the only kind when the broad origin is absent — keep today's behavior.
  if (matches.length === mailPermissionOrigins().length && (await hasAllSitesAccess())) {
    const settings = await loadSettings().catch(() => null);
    if (!settings?.gmailTranslateBanner) return;
  }

  const scripts: RegisteredMailScript[] = [
    {
      id: MAIL_EARLY_CONTENT_SCRIPT_ID,
      js: [MAIL_EARLY_CONTENT_SCRIPT_FILE],
      matches,
      runAt: 'document_start',
    },
    {
      id: MAIL_CONTENT_SCRIPT_ID,
      js: [MAIL_CONTENT_SCRIPT_FILE],
      matches,
      runAt: 'document_idle',
    },
  ];
  await register(scripts.map((script) => ({ ...script, persistAcrossSessions: true }))).catch(() =>
    register(scripts).catch(() => undefined),
  );
}
