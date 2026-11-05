import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  ReleaseError,
  assertMainAndClean,
  assertTagMatches,
  assertWxtUsesPackageVersion,
  bumpVersion,
  changelogSubjects,
  compareVersions,
  extractChangelogSection,
  formatUtcDate,
  hasChangelogSection,
  insertChangelogSection,
  latestReleaseTag,
  parseVersion,
  pushCommand,
  readManifestVersion,
  readPackageVersion,
  renderChangelogSection,
  replacePackageVersion,
  tagName,
  versionFromTag,
  type Bump,
} from './plan.ts';

export interface ReleaseResult {
  version: string;
  tag: string;
  pushCommand: string;
}

export function releaseVersion(options: { root: string; bump: Bump; now?: Date }): ReleaseResult {
  const branch = git(options.root, ['branch', '--show-current']).trim();
  const status = git(options.root, ['status', '--porcelain', '--untracked-files=all']);
  assertMainAndClean(branch, status);

  const packagePath = join(options.root, 'package.json');
  const packageSource = readRequired(packagePath, 'package.json');
  const current = readPackageVersion(packageSource);
  assertWxtUsesPackageVersion(readRequired(join(options.root, 'wxt.config.ts'), 'wxt.config.ts'));

  const version = bumpVersion(current, options.bump);
  const tag = tagName(version);
  if (tagExists(options.root, tag)) throw new ReleaseError(`Tag ${tag} already exists.`);

  const changelogPath = join(options.root, 'CHANGELOG.md');
  const previousChangelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : null;
  if (previousChangelog !== null && hasChangelogSection(previousChangelog, version)) {
    throw new ReleaseError(`CHANGELOG.md already has a section for ${version}`);
  }

  const previousTag = latestReleaseTag(listMergedTags(options.root));
  if (previousTag !== null) {
    const previousVersion = versionFromTag(previousTag);
    if (
      previousVersion !== null &&
      compareVersions(parseVersion(version), parseVersion(previousVersion)) <= 0
    ) {
      throw new ReleaseError(
        `Refusing to release ${version} because ${previousTag} is already the newest merged tag.`,
      );
    }
  }
  const subjects = changelogSubjects(logSubjects(options.root, previousTag));
  const section = renderChangelogSection(
    version,
    formatUtcDate(options.now ?? new Date()),
    subjects,
  );
  const changelog = insertChangelogSection(previousChangelog ?? '', section);
  const packageJson = replacePackageVersion(packageSource, version);

  let committed = false;
  try {
    writeFileSync(packagePath, packageJson);
    writeFileSync(changelogPath, changelog);
    git(options.root, ['add', '--', 'package.json', 'CHANGELOG.md']);
    git(options.root, [
      'commit',
      '-m',
      `chore: release ${tag}`,
      '--',
      'package.json',
      'CHANGELOG.md',
    ]);
    committed = true;
    git(options.root, ['tag', '-a', tag, '-m', tag]);
  } catch (error) {
    const restored = restoreRelease({
      root: options.root,
      committed,
      tag,
      packagePath,
      packageSource,
      changelogPath,
      previousChangelog,
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new ReleaseError(restored === null ? message : `${message}\n${restored}`);
  }

  return { version, tag, pushCommand: pushCommand(tag) };
}

export function checkRelease(options: { root: string; tag: string; manifestPath?: string }): {
  version: string;
  notes: string;
} {
  const version = readPackageVersion(
    readRequired(join(options.root, 'package.json'), 'package.json'),
  );
  assertTagMatches(options.tag, version);
  assertWxtUsesPackageVersion(readRequired(join(options.root, 'wxt.config.ts'), 'wxt.config.ts'));
  const notes = extractChangelogSection(
    readRequired(join(options.root, 'CHANGELOG.md'), 'CHANGELOG.md'),
    version,
  );
  if (options.manifestPath !== undefined) {
    const manifestPath = isAbsolute(options.manifestPath)
      ? options.manifestPath
      : join(options.root, options.manifestPath);
    const manifestVersion = readManifestVersion(readRequired(manifestPath, 'manifest.json'));
    if (manifestVersion !== version) {
      throw new ReleaseError(
        `manifest version ${manifestVersion} does not match package version ${version}`,
      );
    }
  }
  return { version, notes };
}

function restoreRelease(options: {
  root: string;
  committed: boolean;
  tag: string;
  packagePath: string;
  packageSource: string;
  changelogPath: string;
  previousChangelog: string | null;
}): string | null {
  if (options.committed) {
    spawnGit(options.root, ['tag', '-d', options.tag]);
    const reset = spawnGit(options.root, ['reset', '--hard', 'HEAD~1']);
    if (reset.status === 0) return null;
    const detail = (reset.stderr || reset.stdout || '').trim();
    return detail || 'git reset --hard HEAD~1 failed';
  }
  spawnGit(options.root, ['reset', '-q', '--', 'package.json', 'CHANGELOG.md']);
  try {
    writeFileSync(options.packagePath, options.packageSource);
    if (options.previousChangelog === null) rmSync(options.changelogPath, { force: true });
    else writeFileSync(options.changelogPath, options.previousChangelog);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

function listMergedTags(root: string): string[] {
  return git(root, ['tag', '--list', 'v*', '--merged', 'HEAD'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function logSubjects(root: string, previous: string | null): string[] {
  const args = ['log', '--reverse', '--no-merges', '--pretty=format:%s'];
  if (previous !== null) args.push(`${previous}..HEAD`);
  return git(root, args)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function tagExists(root: string, tag: string): boolean {
  const result = spawnGit(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
  return result.status === 0;
}

function readRequired(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ReleaseError(`${label} is missing`);
    }
    throw error;
  }
}

function git(root: string, args: readonly string[]): string {
  const result = spawnGit(root, args);
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new ReleaseError(missing ? 'git was not found on PATH' : result.error.message);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new ReleaseError(detail || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function spawnGit(root: string, args: readonly string[]) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}
