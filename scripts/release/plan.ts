export class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseError';
  }
}

export const USAGE = 'Usage: pnpm release patch|minor|major';

export const CHANGELOG_HEADER = `# Changelog

Release sections are added by \`pnpm release\`. Each section lists commit subjects since the previous \`vX.Y.Z\` tag.
`;

export const EMPTY_CHANGELOG_SUBJECT = 'No commits since the previous release.';

export type Bump = 'patch' | 'minor' | 'major';

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

export interface ReleaseCommand {
  kind: 'release';
  bump: Bump;
}

export interface CheckCommand {
  kind: 'check';
  tag: string | null;
  manifest: string | null;
}

export interface NotesCommand {
  kind: 'notes';
  tag: string | null;
}

export type Command = ReleaseCommand | CheckCommand | NotesCommand;

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_COMMIT = /^chore: release v\d+\.\d+\.\d+$/;

export function formatVersion(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function parseVersion(value: string): Version {
  const match = VERSION_PATTERN.exec(value);
  const majorText = match?.[1];
  const minorText = match?.[2];
  const patchText = match?.[3];
  if (majorText === undefined || minorText === undefined || patchText === undefined) {
    throw new ReleaseError(`version ${value} is not MAJOR.MINOR.PATCH`);
  }
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) {
    throw new ReleaseError(`version ${value} is not MAJOR.MINOR.PATCH`);
  }
  const version = { major, minor, patch };
  if (formatVersion(version) !== value) {
    throw new ReleaseError(`version ${value} is not MAJOR.MINOR.PATCH`);
  }
  return version;
}

export function bumpVersion(current: string, bump: Bump): string {
  const version = parseVersion(current);
  switch (bump) {
    case 'major':
      return formatVersion({ major: version.major + 1, minor: 0, patch: 0 });
    case 'minor':
      return formatVersion({ major: version.major, minor: version.minor + 1, patch: 0 });
    case 'patch':
      return formatVersion({
        major: version.major,
        minor: version.minor,
        patch: version.patch + 1,
      });
    default: {
      const unknown: never = bump;
      throw new ReleaseError(`${USAGE} (${String(unknown)})`);
    }
  }
}

export function tagName(version: string): string {
  return `v${formatVersion(parseVersion(version))}`;
}

export function versionFromTag(tag: string): string | null {
  if (!tag.startsWith('v')) return null;
  try {
    return formatVersion(parseVersion(tag.slice(1)));
  } catch (error) {
    if (error instanceof ReleaseError) return null;
    throw error;
  }
}

export function assertTagMatches(tag: string, version: string): void {
  const expected = tagName(version);
  if (tag !== expected) {
    throw new ReleaseError(`tag ${tag} does not match package version ${version} (${expected})`);
  }
}

export function pushCommand(tag: string): string {
  const version = versionFromTag(tag);
  if (version === null || tagName(version) !== tag) {
    throw new ReleaseError(`tag ${tag} is not a release tag`);
  }
  return `git push origin main ${tag}`;
}

export function compareVersions(left: Version, right: Version): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function latestReleaseTag(tags: readonly string[]): string | null {
  let best: Version | null = null;
  let name: string | null = null;
  for (const tag of tags) {
    const versionText = versionFromTag(tag);
    if (versionText === null) continue;
    const version = parseVersion(versionText);
    if (best === null || compareVersions(version, best) > 0) {
      best = version;
      name = tag;
    }
  }
  return name;
}

export function readPackageVersion(source: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new ReleaseError('package.json is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ReleaseError('package.json is not an object');
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string') throw new ReleaseError('package.json has no version');
  parseVersion(version);
  return version;
}

export function replacePackageVersion(source: string, next: string): string {
  const current = readPackageVersion(source);
  parseVersion(next);
  const pattern = /("version"\s*:\s*")([^"]+)(")/;
  let replaced = false;
  const updated = source.replace(pattern, (match, open: string, value: string, close: string) => {
    if (replaced || value !== current) return match;
    replaced = true;
    return `${open}${next}${close}`;
  });
  if (!replaced || readPackageVersion(updated) !== next) {
    throw new ReleaseError('package.json version was not updated');
  }
  return updated;
}

export function readManifestVersion(source: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new ReleaseError('manifest.json is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ReleaseError('manifest.json is not an object');
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string') throw new ReleaseError('manifest.json has no version');
  parseVersion(version);
  return version;
}

export function formatUtcDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new ReleaseError('invalid release date');
  return date.toISOString().slice(0, 10);
}

export function changelogSubjects(subjects: readonly string[]): string[] {
  return subjects
    .map((subject) => subject.trim())
    .filter((subject) => subject.length > 0 && !RELEASE_COMMIT.test(subject));
}

export function renderChangelogSection(
  version: string,
  date: string,
  subjects: readonly string[],
): string {
  formatVersion(parseVersion(version));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ReleaseError(`invalid release date ${date}`);
  const lines = changelogSubjects(subjects);
  const bullets = (lines.length > 0 ? lines : [EMPTY_CHANGELOG_SUBJECT]).map((line) => `- ${line}`);
  return [`## [${version}] - ${date}`, '', ...bullets].join('\n');
}

function headingPattern(version: string): RegExp {
  const canonical = formatVersion(parseVersion(version));
  return new RegExp(`^## \\[${escapeRegExp(canonical)}\\](?:\\s|$)`);
}

export function hasChangelogSection(changelog: string, version: string): boolean {
  const heading = headingPattern(version);
  return changelog.split(/\r?\n/).some((line) => heading.test(line));
}

export function extractChangelogSection(changelog: string, version: string): string {
  const heading = headingPattern(version);
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) throw new ReleaseError(`CHANGELOG.md has no section for ${version}`);
  const section = [lines[start] ?? ''];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('## ')) break;
    section.push(line);
  }
  return `${section.join('\n').trim()}\n`;
}

export function insertChangelogSection(existing: string, section: string): string {
  const body = section.trim();
  if (body.length === 0) throw new ReleaseError('changelog section is empty');
  const source = existing.replace(/\s*$/, '');
  if (source.length === 0) return `${CHANGELOG_HEADER.trim()}\n\n${body}\n`;
  const match = /^## /m.exec(source);
  if (!match || match.index === undefined) return `${source}\n\n${body}\n`;
  const head = source.slice(0, match.index).replace(/\s*$/, '');
  const tail = source.slice(match.index).replace(/^\s*/, '');
  return `${head}\n\n${body}\n\n${tail}\n`;
}

export function assertMainAndClean(branch: string, status: string): void {
  if (branch !== 'main') {
    const where = branch.trim() === '' ? 'a detached HEAD' : branch.trim();
    throw new ReleaseError(`Refusing to release from ${where}. Checkout main.`);
  }
  if (status.trim() !== '') {
    throw new ReleaseError(`Refusing to release a dirty tree.\n${status.trimEnd()}`);
  }
}

export function assertWxtUsesPackageVersion(source: string): void {
  const scanned = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
  if (/(?<![\w-])(version|version_name)\s*:/.test(scanned)) {
    throw new ReleaseError(
      'wxt.config.ts sets version. Remove it so WXT keeps using the version in package.json.',
    );
  }
}

export function parseCommand(argv: readonly string[]): Command {
  const [command, ...rest] = argv;
  if (command === 'patch' || command === 'minor' || command === 'major') {
    if (rest.length > 0) throw new ReleaseError(USAGE);
    return { kind: 'release', bump: command };
  }
  if (command === 'check' || command === 'notes') {
    const tag = takeOption(rest, '--tag');
    const manifest =
      command === 'check' ? takeOption(tag.rest, '--manifest') : { value: null, rest: tag.rest };
    if (manifest.rest.length > 0) throw new ReleaseError(USAGE);
    return command === 'check'
      ? { kind: 'check', tag: tag.value, manifest: manifest.value }
      : { kind: 'notes', tag: tag.value };
  }
  throw new ReleaseError(USAGE);
}

export function releaseReport(result: { tag: string; pushCommand: string }): string {
  return `Created ${result.tag} on main.\nThis command does not push. When you are ready, run:\n\n${result.pushCommand}\n`;
}

function takeOption(
  args: readonly string[],
  name: string,
): { value: string | null; rest: string[] } {
  const index = args.indexOf(name);
  if (index < 0) return { value: null, rest: [...args] };
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new ReleaseError(`missing value for ${name}`);
  }
  return { value, rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
