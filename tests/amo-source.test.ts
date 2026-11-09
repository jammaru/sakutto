import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourceZipProblems } from '../scripts/amo-source-package.ts';
import type { ZipInput } from '../scripts/zip-archive.ts';

function file(name: string, data = 'x'): ZipInput {
  return { name, data: Buffer.from(data) };
}

describe('AMO source zip', () => {
  it('requires the reviewer files', () => {
    expect(sourceZipProblems([])).toEqual([
      'missing SOURCE_CODE_REVIEW.md',
      'missing scripts/wllama/Dockerfile',
      'missing scripts/wllama/pins.ts',
      'missing package.json',
      'missing pnpm-lock.yaml',
    ]);
    expect(
      sourceZipProblems([
        file('SOURCE_CODE_REVIEW.md'),
        file('scripts/wllama/Dockerfile'),
        file('scripts/wllama/pins.ts'),
        file('package.json'),
        file('pnpm-lock.yaml'),
      ]),
    ).toEqual([]);
  });

  it('keeps the WebGPU kick patch out of the default patch directory', () => {
    const applied = readdirSync(new URL('../scripts/wllama/patches', import.meta.url)).filter(
      (name) => name.endsWith('.patch'),
    );
    const optional = readdirSync(new URL('../scripts/wllama/patches/optional', import.meta.url));
    expect(applied).not.toContain('0007-firefox-webgpu-kick.patch');
    expect(optional).toContain('0007-firefox-webgpu-kick.patch');
  });
});
