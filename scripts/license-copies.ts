/**
 * Files copied from `licenses/` into the packaged extension. `LICENSE` and `NOTICE` live at
 * the repository root and are copied separately.
 *
 * The copies stay byte-identical to the checked-in text apart from a UTF-8 byte-order mark.
 * Chrome serves a packaged `.txt` as `text/plain` with no charset and decodes the bytes as
 * windows-1252, so the Japanese license reads as mojibake. A BOM is the only in-band way to
 * declare the encoding of a plain text document, and the decoder strips it, so the legal
 * wording is unchanged.
 */
export const LICENSE_FILE_COPIES = [
  'llama.cpp-LICENSE.txt',
  'wllama-LICENSE.txt',
  'emscripten-LICENSE.txt',
  'dawn-LICENSE.txt',
  'PLaMo-Community-License-en.txt',
  'PLaMo-Community-License-ja.txt',
  'svelte-LICENSE.txt',
] as const;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** The bytes a packaged license file should contain for `contents`. */
export function withUtf8Bom(contents: Buffer): Buffer {
  if (contents.subarray(0, 3).equals(UTF8_BOM)) return contents;
  return Buffer.concat([UTF8_BOM, contents]);
}

/** The text `chrome-extension://…/licenses/<name>` shows, given the packaged bytes. */
export function decodedLicenseText(contents: Buffer): string {
  return contents.toString('utf8').replace(/^\uFEFF/u, '');
}

/** The text a user reads when they open `licenses/<name>` in the extension. */
export function packagedLicenseText(contents: Buffer): string {
  return decodedLicenseText(withUtf8Bom(contents));
}
