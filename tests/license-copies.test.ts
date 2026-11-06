import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LICENSE_FILE_COPIES,
  decodedLicenseText,
  packagedLicenseText,
  withUtf8Bom,
} from '../scripts/license-copies.ts';

const licensesDir = new URL('../licenses/', import.meta.url);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function read(name: string): Buffer {
  return readFileSync(new URL(name, licensesDir));
}

describe('packaged license text', () => {
  it('declares UTF-8 with a byte-order mark so Chrome stops reading it as windows-1252', () => {
    // Reproduced in Chrome: a packaged `licenses/PLaMo-Community-License-ja.txt` opened at
    // chrome-extension://<id>/licenses/… reported `document.characterSet === 'windows-1252'`
    // and painted `PLaMoã‚³ãƒŸãƒ¥ãƒ‹ãƒ†ã‚£ãƒ©ã‚¤ã‚»ãƒ³ã‚¹å¥‘ç´„`. Chrome sends a packaged
    // `.txt` as `text/plain` with no charset, so it falls back to the locale default. The BOM
    // is the only in-band way for the document to declare UTF-8, and the decoder strips it.
    const packaged = withUtf8Bom(read('PLaMo-Community-License-ja.txt'));
    expect(packaged.subarray(0, 3).equals(BOM)).toBe(true);
    expect(decodedLicenseText(packaged)).toContain('PLaMoコミュニティライセンス契約');
  });

  it('does not add a second BOM to a file that already has one', () => {
    const once = withUtf8Bom(Buffer.from('PLaMo', 'utf8'));
    expect(withUtf8Bom(once).equals(once)).toBe(true);
  });

  it('keeps the legal wording byte for byte after the mark', () => {
    for (const name of ['PLaMo-Community-License-ja.txt', 'PLaMo-Community-License-en.txt']) {
      const source = read(name);
      const packaged = withUtf8Bom(source);
      expect(packaged.subarray(3).equals(source), name).toBe(true);
      // Nothing is reflowed or rewritten: the only change is the three-byte prefix.
      expect(packaged.length).toBe(source.length + 3);
    }
  });

  it('decodes the packaged bytes to the checked-in text for every bundled license', () => {
    const names = readdirSync(licensesDir).filter((name) => name.endsWith('.txt'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(packagedLicenseText(read(name)), name).toBe(
        read(name)
          .toString('utf8')
          .replace(/^\uFEFF/u, ''),
      );
    }
  });

  it('lists every PLaMo license text and no weight file', () => {
    expect(LICENSE_FILE_COPIES).toContain('PLaMo-Community-License-ja.txt');
    expect(LICENSE_FILE_COPIES).toContain('PLaMo-Community-License-en.txt');
    for (const name of LICENSE_FILE_COPIES) {
      expect(name).not.toMatch(/\.gguf$/i);
      expect(readdirSync(licensesDir)).toContain(name);
    }
  });

  /**
   * The build script is plain JavaScript so `pnpm build` never needs a type-stripping step.
   * It carries its own copy of the list, and a file added to one copy but not the other would
   * ship an unmarked license or skip one entirely.
   */
  it("keeps the build script's copy list in step with the tested list", () => {
    const script = readFileSync(new URL('../scripts/sync-licenses.mjs', import.meta.url), 'utf8');
    const listed = [...script.matchAll(/^\s+'([^']+\.txt)',$/gmu)].map((match) => match[1]);
    const inScript = listed.filter((name) => name !== 'LICENSE.txt' && name !== 'NOTICE.txt');
    expect(new Set(inScript)).toEqual(new Set(LICENSE_FILE_COPIES));
  });
});
