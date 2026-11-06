/**
 * Stored consent must not rewind a start click that is still saving.
 */
export function agreementFromStorage(
  stored: boolean,
  interaction: { started: boolean },
): boolean | null {
  if (interaction.started) return null;
  return stored;
}

/**
 * The model may only be fetched once the stored record names the bundled license text.
 * Callers pass the normalized settings, so a stale or malformed record has already been
 * dropped by `normalizeSettings`. The predicate narrows the settings, so a caller that reads
 * them after this check cannot forget it.
 */
export function hasLicenseConsent<T extends { consent: unknown }>(
  settings: T | null | undefined,
): settings is T & { consent: NonNullable<T['consent']> } {
  return settings !== null && settings !== undefined && settings.consent != null;
}
