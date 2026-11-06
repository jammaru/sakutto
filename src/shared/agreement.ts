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
