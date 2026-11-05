import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyChanges } from '../scripts/ci-changed';

describe('CI change scope', () => {
  it('skips docs and markdown', () => {
    expect(classifyChanges(['README.md', 'docs/BUILDING.md'])).toEqual({
      wllama: false,
      code: false,
      bundle: false,
    });
  });

  it('runs checks for extension code without rebuilding wllama', () => {
    expect(classifyChanges(['README.md', 'src/dom/session.ts'])).toEqual({
      wllama: false,
      code: true,
      bundle: false,
    });
  });

  it('treats the pinned wllama inputs as a rebuild', () => {
    expect(
      classifyChanges([
        'scripts/wllama/pins.ts',
        'scripts/wllama/patches/0001-static-worker-script.patch',
      ]),
    ).toEqual({ wllama: true, code: true, bundle: true });
  });

  it('does not run the model bench from the workflow', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(workflow).not.toContain('pnpm bench');
    expect(workflow).not.toContain('scripts/bench');
  });

  it('packages when the upload step changes and leaves ordinary code alone', () => {
    expect(classifyChanges(['.github/actions/package-extension/action.yml'])).toEqual({
      wllama: false,
      code: true,
      bundle: true,
    });
  });

  it('does not rebuild wasm for the package-audit script', () => {
    expect(classifyChanges(['scripts/verify-package.ts', 'tests/package-audit.test.ts'])).toEqual({
      wllama: false,
      code: true,
      bundle: false,
    });
  });

  it('does not rebuild the zip for the tag workflow alone', () => {
    expect(
      classifyChanges([
        '.github/workflows/release.yml',
        'scripts/release/cli.ts',
        'docs/RELEASING.md',
      ]),
    ).toEqual({
      wllama: false,
      code: true,
      bundle: false,
    });
  });
});
