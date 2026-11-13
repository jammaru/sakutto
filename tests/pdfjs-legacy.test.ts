import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagedPath = resolve(root, 'public/vendor/pdfjs/build/pdf.min.mjs');
const describePackaged = existsSync(packagedPath) ? describe : describe.skip;

describePackaged('packaged pdf.js', () => {
  it('ships the legacy build so Chrome 116 can open a PDF', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'public/vendor/pdfjs/pdfjs-build.json'), 'utf8'),
    ) as { source: string; files: Record<string, { sha256: string }> };
    expect(manifest.source).toContain('/legacy');

    const packaged = readFileSync(resolve(root, 'public/vendor/pdfjs/build/pdf.min.mjs'));
    const legacy = readFileSync(resolve(root, 'node_modules/pdfjs-dist/legacy/build/pdf.min.mjs'));
    const modern = readFileSync(resolve(root, 'node_modules/pdfjs-dist/build/pdf.min.mjs'));
    const packagedHash = createHash('sha256').update(packaged).digest('hex');
    const legacyHash = createHash('sha256').update(legacy).digest('hex');
    const modernHash = createHash('sha256').update(modern).digest('hex');
    expect(packagedHash).toBe(legacyHash);
    expect(packagedHash).not.toBe(modernHash);
    expect(manifest.files['build/pdf.min.mjs']?.sha256).toBe(packagedHash);
  });
});
