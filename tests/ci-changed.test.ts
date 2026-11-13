import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyChanges } from '../scripts/ci-changed';
import { normalizeEol } from './support/eol';

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
    const workflow = normalizeEol(
      readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
    );
    expect(workflow).toContain('pnpm bench:equality --check');
    expect(workflow).toContain('pnpm bench:pdf:layout');
    expect(
      workflow
        .replaceAll('pnpm bench:equality --check', '')
        .replaceAll('pnpm bench:pdf:layout', ''),
    ).not.toContain('pnpm bench');
    expect(workflow).not.toContain('scripts/bench');
    expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(workflow).toContain('types: [opened, synchronize, reopened, ready_for_review]');
    expect(workflow).toContain('uses: ./.github/actions/build-wllama');
    expect(workflow).toContain('skip-wllama: true');
    expect(workflow).toContain('name: wllama-dist');
    expect(workflow).not.toContain('github.event.pull_request.draft == false');
  });

  it('packages when the upload step changes and leaves ordinary code alone', () => {
    expect(classifyChanges(['.github/actions/package-extension/action.yml'])).toEqual({
      wllama: false,
      code: true,
      bundle: true,
    });
    expect(classifyChanges(['.github/actions/build-wllama/action.yml'])).toEqual({
      wllama: false,
      code: true,
      bundle: true,
    });
    expect(classifyChanges(['scripts/wllama-cache-key.ts'])).toEqual({
      wllama: false,
      code: true,
      bundle: true,
    });
    expect(classifyChanges(['.github/workflows/amo.yml', 'scripts/web-ext-lint.ts'])).toEqual({
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
