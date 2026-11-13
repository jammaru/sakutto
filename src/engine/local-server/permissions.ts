import { browser } from 'wxt/browser';
import type { EngineSource } from '@/shared/engine-status';
import type { Settings, SettingsPatch } from '@/shared/settings';
import { isRemoteServerUrl, parseServerUrl, primaryOriginPattern } from './url';

/**
 * Optional host access for the local-server origin. `permissions.request` must be the
 * first awaited extension call in the click that turns the engine on — a prior `await`
 * (including `permissions.contains`) drops the user gesture. Firefox then rejects with
 * "permissions.request may only be called from a user input handler" and Settings stays
 * on the built-in engine. Chrome is more lenient for `contains`, but `request` still
 * returns true without a prompt when the origin is already granted.
 *
 * Request only the URL's own origin. Loopback aliases (`localhost`, `[::1]`) are extra
 * optional hosts; asking for them in the same call re-prompts Chrome when they are not
 * already granted, even if `127.0.0.1` is, and the Settings click then never finishes.
 */
export async function requestServerPermission(url: string): Promise<boolean> {
  const origin = primaryOriginPattern(url);
  if (!origin) return false;
  return browser.permissions.request({ origins: [origin] }).catch(() => false);
}

export type EngineSourceSwitchResult = { denied: false; patch: SettingsPatch } | { denied: true };

/**
 * Builds the Settings patch for an engine-source radio change. A local-server switch
 * asks for host access in this same turn so Firefox still has the user gesture; a
 * denial returns no patch so the radio can stay on the built-in engine.
 */
export async function resolveEngineSourceSwitch(
  source: EngineSource,
  settings: Pick<Settings, 'localServerUrl' | 'localServerAllowRemote'>,
  options: {
    ack?: boolean;
    requestPermission?: (url: string) => Promise<boolean>;
  } = {},
): Promise<EngineSourceSwitchResult> {
  if (source === 'local-server') {
    const remoteUrl = isRemoteServerUrl(settings.localServerUrl);
    if (!remoteUrl || settings.localServerAllowRemote) {
      const request = options.requestPermission ?? requestServerPermission;
      if (!(await request(settings.localServerUrl))) return { denied: true };
    }
  }
  const patch: SettingsPatch = { engineSource: source };
  if (options.ack) patch.localServerExperimentalAck = true;
  return { denied: false, patch };
}

export function serverOriginLabel(url: string): string {
  return parseServerUrl(url)?.origin ?? url;
}

/**
 * Puts the native radio dots back on the saved engine. A click that then fails
 * `permissions.request` leaves the browser's checked state on Local server even though
 * `engineSource` did not change, so Svelte will not reapply `checked={local}`.
 */
export function syncEngineSourceRadios(
  source: EngineSource,
  radios: {
    builtin?: HTMLInputElement | null | undefined;
    local?: HTMLInputElement | null | undefined;
  },
): void {
  const localOn = source === 'local-server';
  if (radios.builtin) radios.builtin.checked = !localOn;
  if (radios.local) radios.local.checked = localOn;
}
