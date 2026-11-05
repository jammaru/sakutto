/** Alt+S with no other modifiers, including a keyboard that reports the letter as `s`. */
export function isPlainAltS(event: KeyboardEvent): boolean {
  return (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (event.code === 'KeyS' || event.key.toLowerCase() === 's')
  );
}

/** The manifest default for translate-selection. */
export function isDefaultAltSShortcut(shortcut: string): boolean {
  const parts = shortcut
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 2 && parts[0] === 'Alt' && parts[1] === 'S';
}
