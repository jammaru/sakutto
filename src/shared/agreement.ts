/**
 * Stored consent must not clear a checkbox the user already changed, and must
 * not rewind a start click that is still saving.
 */
export function agreementFromStorage(
  stored: boolean,
  interaction: { touched: boolean; started: boolean },
): boolean | null {
  if (interaction.started || interaction.touched) return null;
  return stored;
}
