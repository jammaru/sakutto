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

  it('ships the worker, compatibility entries, wasm decoders, and ICC profile', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'public/vendor/pdfjs/pdfjs-build.json'), 'utf8'),
    ) as { files: Record<string, { sha256: string }> };
    const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

    const packagedWorker = readFileSync(
      resolve(root, 'public/vendor/pdfjs/build/pdf.worker.min.mjs'),
    );
    const legacyWorker = readFileSync(
      resolve(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
    );
    expect(hash(packagedWorker)).toBe(hash(legacyWorker));
    expect(manifest.files['build/pdf.worker.min.mjs']?.sha256).toBe(hash(packagedWorker));

    const entry = readFileSync(resolve(root, 'public/vendor/pdfjs/build/pdf.entry.mjs'), 'utf8');
    const workerEntry = readFileSync(
      resolve(root, 'public/vendor/pdfjs/build/pdf.worker.entry.mjs'),
      'utf8',
    );
    expect(entry).toContain("from './pdf.min.mjs'");
    expect(workerEntry).toContain("import './pdf.worker.min.mjs'");
    expect(entry).toContain("import './pdfjs-compat.mjs'");
    expect(workerEntry).toContain("import './pdfjs-compat.mjs'");

    expect(existsSync(resolve(root, 'public/vendor/pdfjs/wasm/openjpeg.wasm'))).toBe(true);
    expect(existsSync(resolve(root, 'public/vendor/pdfjs/wasm/qcms_bg.wasm'))).toBe(true);
    expect(existsSync(resolve(root, 'public/vendor/pdfjs/iccs/CGATS001Compat-v2-micro.icc'))).toBe(
      true,
    );
  });
});
