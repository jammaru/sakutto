/** Git `core.autocrlf=true` on Windows turns checked-in LF files into CRLF in the working tree. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
