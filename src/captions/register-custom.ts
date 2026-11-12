import { browser } from 'wxt/browser';
import {
  CAPTION_CUSTOM_SCRIPT_FILE,
  CAPTION_CUSTOM_SCRIPT_ID,
  captionCustomHostOrigins,
} from './custom-hosts';

/**
 * Optional host access for one custom caption site. `permissions.request` must be the
 * first awaited extension call in the add click so Chrome still has the user gesture.
 */
export async function requestCaptionCustomHostAccess(entry: string): Promise<boolean> {
  const origins = captionCustomHostOrigins(entry);
  return browser.permissions.request({ origins }).catch(() => false);
}

export async function revokeCaptionCustomHostAccess(entry: string): Promise<void> {
  const origins = captionCustomHostOrigins(entry);
  const remove = browser.permissions.remove;
  if (!remove) return;
  await remove({ origins }).catch(() => undefined);
}

export async function syncCaptionCustomContentScripts(hosts: readonly string[]): Promise<void> {
  const scripting = browser.scripting as typeof browser.scripting & {
    registerContentScripts?: (scripts: RegisteredCaptionScript[]) => Promise<void>;
    unregisterContentScripts?: (filter?: { ids?: string[] }) => Promise<void>;
  };
  if (!scripting.registerContentScripts || !scripting.unregisterContentScripts) return;

  await scripting
    .unregisterContentScripts({ ids: [CAPTION_CUSTOM_SCRIPT_ID] })
    .catch(() => undefined);

  const matches = [...new Set(hosts.flatMap((host) => captionCustomHostOrigins(host)))];
  if (matches.length === 0) return;

  const script = {
    id: CAPTION_CUSTOM_SCRIPT_ID,
    js: [CAPTION_CUSTOM_SCRIPT_FILE],
    matches,
    runAt: 'document_idle' as const,
  };
  await scripting
    .registerContentScripts([{ ...script, persistAcrossSessions: true }])
    .catch(() => scripting.registerContentScripts([script]).catch(() => undefined));
}

interface RegisteredCaptionScript {
  id: string;
  js: string[];
  matches: string[];
  runAt: 'document_idle';
  persistAcrossSessions?: boolean;
}
