import { browser } from 'wxt/browser';
import { currentUiLanguage } from './i18n';
import { normalizeSettings, type Settings, type SettingsPatch } from './settings';

const SETTINGS_STORAGE_KEY = 'settings';

let writeQueue: Promise<unknown> = Promise.resolve();

/** Reads the stored settings. Storage failures reject so callers can surface them. */
export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(stored[SETTINGS_STORAGE_KEY], currentUiLanguage());
}

export async function ensureSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
  const value = stored[SETTINGS_STORAGE_KEY];
  const settings = normalizeSettings(value, currentUiLanguage());
  if (value === undefined) {
    await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
  }
  return settings;
}

/**
 * Applies a patch on top of the latest stored settings. Writes are queued so two
 * quick changes cannot both read the same stale value and drop one of them.
 */
export function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const operation = writeQueue.then(async () => {
    const current = await loadSettings();
    const next = normalizeSettings({ ...current, ...patch }, currentUiLanguage());
    await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });
    return next;
  });

  writeQueue = operation.catch(() => undefined);
  return operation;
}

export function subscribeSettings(listener: (settings: Settings) => void): () => void {
  const handleChanges = (
    changes: Record<string, { newValue?: unknown }>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    const change = changes[SETTINGS_STORAGE_KEY];
    if (!change) return;
    listener(normalizeSettings(change.newValue, currentUiLanguage()));
  };

  browser.storage.onChanged.addListener(handleChanges);
  return () => browser.storage.onChanged.removeListener(handleChanges);
}
