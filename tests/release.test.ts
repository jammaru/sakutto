import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../scripts/release/cli.ts';
import {
  CHANGELOG_HEADER,
  USAGE,
  assertMainAndClean,
  assertTagMatches,
  assertWxtUsesPackageVersion,
  bumpVersion,
  changelogSubjects,
  extractChangelogSection,
  formatUtcDate,
  hasChangelogSection,
  insertChangelogSection,
  latestReleaseTag,
  parseCommand,
  parseVersion,
  pushCommand,
  readManifestVersion,
  readPackageVersion,
  releaseReport,
  renderChangelogSection,
  replacePackageVersion,
  tagName,
  versionFromTag,
} from '../scripts/release/plan.ts';
import { checkRelease, releaseVersion } from '../scripts/release/run.ts';
import { STORE_SECRET_NAMES } from '../scripts/chrome-web-store.ts';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('version and tag', () => {
  it('bumps major, minor, and patch without keeping the lower parts', () => {
    expect(bumpVersion('0.1.0', 'patch')).toBe('0.1.1');
    expect(bumpVersion('0.1.9', 'patch')).toBe('0.1.10');
    expect(bumpVersion('0.1.1', 'minor')).toBe('0.2.0');
    expect(bumpVersion('0.2.3', 'major')).toBe('1.0.0');
    expect(tagName('1.2.10')).toBe('v1.2.10');
  });

  it('rejects versions that are not canonical MAJOR.MINOR.PATCH', () => {
    expect(() => parseVersion('1.2')).toThrow(/MAJOR\.MINOR\.PATCH/);
    expect(() => parseVersion('01.2.3')).toThrow(/MAJOR\.MINOR\.PATCH/);
    expect(() => parseVersion('1.2.3-beta')).toThrow(/MAJOR\.MINOR\.PATCH/);
    expect(versionFromTag('v1.2.3')).toBe('1.2.3');
    expect(versionFromTag('v01.2.3')).toBeNull();
    expect(versionFromTag('1.2.3')).toBeNull();
    expect(versionFromTag('v1.2.3-beta')).toBeNull();
  });

  it('matches only the vX.Y.Z tag for that package version', () => {
    expect(() => assertTagMatches('v0.1.0', '0.1.0')).not.toThrow();
    expect(() => assertTagMatches('v0.1.1', '0.1.0')).toThrow(/v0\.1\.0/);
    expect(() => assertTagMatches('V0.1.0', '0.1.0')).toThrow(/V0\.1\.0/);
    expect(pushCommand('v0.1.1')).toBe('git push origin main v0.1.1');
    expect(
      releaseReport({ tag: 'v0.1.1', pushCommand: 'git push origin main v0.1.1' })
        .trim()
        .split('\n')
        .at(-1),
    ).toBe('git push origin main v0.1.1');
  });

  it('picks the highest merged release tag and ignores other names', () => {
    expect(latestReleaseTag(['v0.9.0', 'v0.10.0', 'v0.2.0', 'nightly', 'v1.2.3-beta'])).toBe(
      'v0.10.0',
    );
    expect(latestReleaseTag(['nightly'])).toBeNull();
  });

  it('replaces only the package version text', () => {
    const source = '{\n  "name": "demo",\n  "version": "0.1.0",\n  "private": true\n}\n';
    const updated = replacePackageVersion(source, '0.1.1');
    expect(updated).toBe('{\n  "name": "demo",\n  "version": "0.1.1",\n  "private": true\n}\n');
    expect(readPackageVersion(updated)).toBe('0.1.1');
    expect(readManifestVersion('{"version":"1.2.3","name":"demo"}')).toBe('1.2.3');
  });

  it('refuses a dirty tree and any branch other than main', () => {
    expect(() => assertMainAndClean('main', '')).not.toThrow();
    expect(() => assertMainAndClean('main', '\n')).not.toThrow();
    expect(() => assertMainAndClean('feature', '')).toThrow(/feature/);
    expect(() => assertMainAndClean('', 'clean')).toThrow(/detached HEAD/);
    expect(() => assertMainAndClean('main', ' M package.json\n?? notes.txt')).toThrow(/dirty/);
  });

  it('keeps the extension version in package.json', () => {
    const config = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');
    expect(() => assertWxtUsesPackageVersion(config)).not.toThrow();
    expect(() => assertWxtUsesPackageVersion('minimum_chrome_version: "116"\n')).not.toThrow();
    expect(() => assertWxtUsesPackageVersion('// version: "1.0.0"\n')).not.toThrow();
    expect(() => assertWxtUsesPackageVersion('const label = "version: 1";\n')).not.toThrow();
    expect(() => assertWxtUsesPackageVersion('version: "1.2.3",\n')).toThrow(/package\.json/);
    expect(() => assertWxtUsesPackageVersion('version_name: "1.2.3",\n')).toThrow(/package\.json/);
  });
});

describe('changelog', () => {
  it('builds a section from commit subjects and skips release commits', () => {
    expect(formatUtcDate(new Date('2026-11-05T15:30:00-10:00'))).toBe('2026-11-06');
    expect(changelogSubjects([' fix: one ', '', 'chore: release v0.1.0', 'fix: two'])).toEqual([
      'fix: one',
      'fix: two',
    ]);
    expect(renderChangelogSection('0.1.1', '2026-11-06', ['fix: one'])).toBe(
      '## [0.1.1] - 2026-11-06\n\n- fix: one',
    );
    expect(renderChangelogSection('0.1.1', '2026-11-06', [])).toContain(
      '- No commits since the previous release.',
    );
  });

  it('inserts the new section above older ones and does not confuse 0.1.1 with 0.1.10', () => {
    const existing = `# Changelog

intro

## [0.1.0] - 2026-01-01

- first

## [0.1.10] - 2026-02-01

- tenth
`;
    const next = renderChangelogSection('0.1.1', '2026-11-05', ['fix: second']);
    const updated = insertChangelogSection(existing, next);
    expect(updated.indexOf('## [0.1.1]')).toBeLessThan(updated.indexOf('## [0.1.0]'));
    expect(updated.startsWith('# Changelog')).toBe(true);
    expect(extractChangelogSection(updated, '0.1.1')).toBe(
      '## [0.1.1] - 2026-11-05\n\n- fix: second\n',
    );
    expect(extractChangelogSection(updated, '0.1.10')).toContain('- tenth');
    expect(hasChangelogSection(updated, '0.1.1')).toBe(true);
    expect(() => extractChangelogSection(updated, '9.9.9')).toThrow(/9\.9\.9/);
  });

  it('starts a new changelog from the header', () => {
    const section = renderChangelogSection('0.1.0', '2026-11-05', ['chore: init']);
    expect(insertChangelogSection('', section)).toBe(`${CHANGELOG_HEADER.trim()}\n\n${section}\n`);
  });
});

describe('command parsing', () => {
  it('accepts the owner bumps and the workflow subcommands', () => {
    expect(parseCommand(['patch'])).toEqual({ kind: 'release', bump: 'patch' });
    expect(parseCommand(['minor'])).toEqual({ kind: 'release', bump: 'minor' });
    expect(parseCommand(['major'])).toEqual({ kind: 'release', bump: 'major' });
    expect(parseCommand(['check', '--manifest', 'manifest.json', '--tag', 'v0.1.0'])).toEqual({
      kind: 'check',
      tag: 'v0.1.0',
      manifest: 'manifest.json',
    });
    expect(parseCommand(['notes', '--tag', 'v0.1.0'])).toEqual({ kind: 'notes', tag: 'v0.1.0' });
    expect(() => parseCommand([])).toThrow(USAGE);
    expect(() => parseCommand(['patch', '--force'])).toThrow(USAGE);
    expect(() => parseCommand(['notes', '--manifest', 'manifest.json'])).toThrow(USAGE);
    expect(() => parseCommand(['check', '--tag'])).toThrow(/--tag/);
  });
});

describe('release command', () => {
  it('points the cli at this repository', () => {
    expect(repoRoot()).toBe(repo);
    const pkg = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
      scripts: { release: string };
    };
    expect(pkg.scripts.release).toBe('node scripts/release/cli.ts');

    // `pnpm release` prepends a section every time, so this repository's
    // changelog no longer equals the starter template once it has shipped.
    // Release runs must keep the template header and only add sections below it.
    const changelog = readFileSync(join(repoRoot(), 'CHANGELOG.md'), 'utf8');
    const head = changelog.split(/^## /m)[0] ?? '';
    expect(head.trim()).toBe(CHANGELOG_HEADER.trim());

    const versions = changelogSectionVersions(changelog);
    expect(new Set(versions).size).toBe(versions.length);
    for (const version of versions) {
      expect(() => parseVersion(version)).not.toThrow();
      expect(extractChangelogSection(changelog, version)).toMatch(
        /^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}\n\n- \S/,
      );
    }
  });

  it('commits the bump and an annotated tag without pushing', () => {
    withRepo((root) => {
      commitFile(root, 'note.txt', 'note\n', 'fix: keep the model');
      const result = releaseVersion({
        root,
        bump: 'patch',
        now: new Date('2026-11-05T15:30:00-10:00'),
      });
      expect(result).toEqual({
        version: '0.1.1',
        tag: 'v0.1.1',
        pushCommand: 'git push origin main v0.1.1',
      });
      expect(readPackageVersion(readFileSync(join(root, 'package.json'), 'utf8'))).toBe('0.1.1');
      expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('## [0.1.1] - 2026-11-06');
      expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('- chore: init');
      expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('- fix: keep the model');
      expect(git(root, ['status', '--porcelain'])).toBe('');
      expect(git(root, ['log', '-1', '--pretty=%s']).trim()).toBe('chore: release v0.1.1');
      expect(git(root, ['cat-file', '-t', 'v0.1.1']).trim()).toBe('tag');
      expect(git(root, ['remote'])).toBe('');

      commitFile(root, 'again.txt', 'again\n', 'fix: again');
      const second = releaseVersion({
        root,
        bump: 'minor',
        now: new Date('2026-12-01T00:00:00Z'),
      });
      expect(second.tag).toBe('v0.2.0');
      const notes = checkRelease({ root, tag: 'v0.2.0' }).notes;
      expect(notes).toContain('- fix: again');
      expect(notes).not.toContain('chore: init');
      expect(notes).not.toContain('chore: release v0.1.1');
    });
  });

  it('ignores a higher tag that is not merged into main', () => {
    withRepo((root) => {
      git(root, ['tag', '-a', 'v0.1.0', '-m', 'v0.1.0']);
      commitFile(root, 'note.txt', 'note\n', 'fix: on main');
      git(root, ['checkout', '-b', 'side']);
      commitFile(root, 'side.txt', 'side\n', 'feat: side only');
      git(root, ['tag', '-a', 'v9.9.9', '-m', 'v9.9.9']);
      git(root, ['checkout', 'main']);
      const result = releaseVersion({ root, bump: 'patch', now: new Date('2026-11-06T00:00:00Z') });
      expect(result.version).toBe('0.1.1');
      const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
      expect(changelog).toContain('- fix: on main');
      expect(changelog).not.toContain('feat: side only');
    });
  });

  it('refuses a dirty tree, another branch, a detached HEAD, an existing tag, and a hardcoded version', () => {
    withRepo((root) => {
      writeFileSync(join(root, 'extra.txt'), 'x\n');
      expect(() => releaseVersion({ root, bump: 'patch' })).toThrow(/dirty/);
      expect(readPackageVersion(readFileSync(join(root, 'package.json'), 'utf8'))).toBe('0.1.0');
      rmSync(join(root, 'extra.txt'));

      git(root, ['checkout', '-b', 'feature']);
      expect(() => releaseVersion({ root, bump: 'patch' })).toThrow(/feature/);
      git(root, ['checkout', 'main']);

      git(root, ['checkout', '--detach']);
      expect(() => releaseVersion({ root, bump: 'patch' })).toThrow(/detached HEAD/);
      git(root, ['checkout', 'main']);

      git(root, ['tag', '-a', 'v0.1.1', '-m', 'v0.1.1']);
      expect(() => releaseVersion({ root, bump: 'patch' })).toThrow(/already exists/);
      expect(git(root, ['log', '-1', '--pretty=%s']).trim()).toBe('chore: init');
      git(root, ['tag', '-d', 'v0.1.1']);

      writeFileSync(join(root, 'wxt.config.ts'), 'export default {\n  version: "9.9.9",\n};\n');
      git(root, ['add', '--', 'wxt.config.ts']);
      git(root, ['commit', '-m', 'chore: pin a version']);
      expect(() => releaseVersion({ root, bump: 'patch' })).toThrow(/wxt\.config\.ts/);
      expect(git(root, ['log', '-1', '--pretty=%s']).trim()).toBe('chore: pin a version');
      expect(git(root, ['status', '--porcelain'])).toBe('');
    });
  });

  it('refuses untracked files when git status is configured to hide them', () => {
    withRepo((root) => {
      git(root, ['config', 'status.showUntrackedFiles', 'no']);
      writeFileSync(join(root, 'extra.txt'), 'x\n');
      expect(() => releaseVersion({ root, bump: 'patch' })).toThrow(/dirty/);
      expect(readPackageVersion(readFileSync(join(root, 'package.json'), 'utf8'))).toBe('0.1.0');
      expect(git(root, ['tag', '--list'])).toBe('');
    });
  });

  it('refuses a version older than the newest merged tag', () => {
    withRepo((root) => {
      git(root, ['tag', '-a', 'v0.2.0', '-m', 'v0.2.0']);
      expect(() => releaseVersion({ root, bump: 'patch' })).toThrow(/v0\.2\.0/);
      expect(readPackageVersion(readFileSync(join(root, 'package.json'), 'utf8'))).toBe('0.1.0');
      expect(git(root, ['log', '-1', '--pretty=%s']).trim()).toBe('chore: init');
      expect(git(root, ['tag', '--list']).trim()).toBe('v0.2.0');
    });
  });

  it('removes the release commit when the annotated tag cannot be created', () => {
    withRepo((root) => {
      const fail = join(root, '.git', 'fail-gpg.sh');
      writeFileSync(fail, '#!/bin/sh\nexit 1\n');
      chmodSync(fail, 0o755);
      git(root, ['config', 'gpg.format', 'openpgp']);
      git(root, ['config', 'tag.gpgsign', 'true']);
      git(root, ['config', 'gpg.program', fail]);
      expect(() => releaseVersion({ root, bump: 'patch' })).toThrow(/unable to sign the tag/);
      expect(readPackageVersion(readFileSync(join(root, 'package.json'), 'utf8'))).toBe('0.1.0');
      expect(git(root, ['status', '--porcelain'])).toBe('');
      expect(git(root, ['tag', '--list'])).toBe('');
      expect(git(root, ['log', '-1', '--pretty=%s']).trim()).toBe('chore: init');
    });
  });

  it('restores the tree when the commit hook rejects the release', () => {
    withRepo((root) => {
      const hooks = join(root, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      const hook = join(hooks, 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\nexit 1\n');
      chmodSync(hook, 0o755);
      expect(() => releaseVersion({ root, bump: 'patch' })).toThrow();
      expect(readPackageVersion(readFileSync(join(root, 'package.json'), 'utf8'))).toBe('0.1.0');
      expect(git(root, ['status', '--porcelain'])).toBe('');
      expect(git(root, ['tag', '--list'])).toBe('');
    });
  });

  it('checks the built manifest version', () => {
    withRepo((root) => {
      releaseVersion({ root, bump: 'patch', now: new Date('2026-11-06T00:00:00Z') });
      writeFileSync(join(root, 'manifest.json'), '{"version":"0.1.1"}\n');
      expect(checkRelease({ root, tag: 'v0.1.1', manifestPath: 'manifest.json' }).version).toBe(
        '0.1.1',
      );
      writeFileSync(join(root, 'manifest.json'), '{"version":"0.1.0"}\n');
      expect(() => checkRelease({ root, tag: 'v0.1.1', manifestPath: 'manifest.json' })).toThrow(
        /manifest version 0\.1\.0/,
      );
    });
  });
});

describe('release workflow', () => {
  it('reuses the package action and publishes to the store only from the workflow input', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/release.yml', import.meta.url),
      'utf8',
    );
    const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(workflow).toContain("tags: ['v*']");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('publish:');
    expect(workflow).toContain('uses: ./.github/actions/package-extension');
    expect(workflow).not.toContain('pnpm build:wllama');
    expect(workflow).toContain('node scripts/release/cli.ts check');
    expect(workflow).toContain('node scripts/release/cli.ts notes > release-notes.md');
    expect(workflow).toContain('draft: true');
    expect(workflow).toContain('chrome-mv3-zip');
    expect(workflow).toContain('pnpm lint');
    expect(workflow).toContain('pnpm format:check');
    expect(workflow).toContain('pnpm typecheck');
    expect(workflow).toContain('pnpm test');
    expect(workflow).toContain('pnpm test:e2e');
    expect(workflow).toContain('node scripts/chrome-web-store.ts dist-zip');
    expect(workflow).toContain('files: dist-zip/*.zip');
    expect(workflow).toContain(
      "CWS_PUBLISH: ${{ github.event_name == 'workflow_dispatch' && inputs.publish == true && 'true' || 'false' }}",
    );
    for (const name of STORE_SECRET_NAMES) {
      expect(workflow).toContain(`secrets.${name}`);
    }
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).not.toMatch(/GOCSPX|ya29\.|refresh_token=/);
    expect(workflow).not.toMatch(/run:.*\$\{\{\s*secrets\./);
    expect(ci).not.toContain('pnpm release');
    expect(ci).not.toContain('chrome-web-store');
    const runSource = readFileSync(new URL('../scripts/release/run.ts', import.meta.url), 'utf8');
    expect(runSource).not.toContain("'push'");
    expect(runSource).not.toContain('"push"');
  });

  it('documents the command, the secrets, and OPFS in both languages', () => {
    const japanese = readFileSync(new URL('../docs/RELEASING.md', import.meta.url), 'utf8');
    const english = readFileSync(new URL('../docs/RELEASING.en.md', import.meta.url), 'utf8');
    expect(japanese).toContain('pnpm release patch');
    expect(japanese).toContain('git push origin main vX.Y.Z');
    expect(japanese).toContain('CWS_REFRESH_TOKEN');
    expect(japanese).toContain('CWS_PUBLISHER_ID');
    expect(japanese).toContain('OPFS');
    expect(japanese).toContain('です。');
    expect(japanese).not.toMatch(/GOCSPX|ya29\./);
    expect(english).toContain('git push origin main vX.Y.Z');
    expect(english).toContain('CWS_CLIENT_SECRET');
    expect(english).toContain('OPFS');
    expect(english).toContain('does not publish');
  });
});

function withRepo(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'sakutto-release-'));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'release-test@example.com']);
    git(root, ['config', 'user.name', 'Release Test']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    git(root, ['config', 'tag.gpgsign', 'false']);
    git(root, ['config', 'core.autocrlf', 'false']);
    git(root, ['config', 'core.hooksPath', join(root, '.git', 'hooks')]);
    writeFileSync(join(root, 'wxt.config.ts'), 'export default {\n  manifestVersion: 3,\n};\n');
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'sakutto', version: '0.1.0' }, null, 2)}\n`,
    );
    git(root, ['add', '--', 'package.json', 'wxt.config.ts']);
    git(root, ['commit', '-m', 'chore: init']);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function changelogSectionVersions(changelog: string): string[] {
  return changelog
    .split(/\r?\n/)
    .map((line) => /^## \[([^\]]+)\]/.exec(line)?.[1])
    .filter((version): version is string => version !== undefined);
}

function commitFile(root: string, name: string, contents: string, message: string): void {
  writeFileSync(join(root, name), contents);
  git(root, ['add', '--', name]);
  git(root, ['commit', '-m', message]);
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(' ')}`).trim());
  }
  return result.stdout;
}
