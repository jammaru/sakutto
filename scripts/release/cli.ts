import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ReleaseError, parseCommand, releaseReport } from './plan.ts';
import { checkRelease, releaseVersion } from './run.ts';

export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  try {
    const command = parseCommand(argv);
    const root = repoRoot();
    if (command.kind === 'release') {
      const result = releaseVersion({ root, bump: command.bump });
      process.stdout.write(releaseReport(result));
      return;
    }
    const tag = command.tag ?? env.GITHUB_REF_NAME ?? '';
    if (tag === '') {
      throw new ReleaseError('Pass --tag vX.Y.Z or run this from a GitHub Actions tag.');
    }
    const checked = checkRelease({
      root,
      tag,
      ...(command.kind === 'check' && command.manifest ? { manifestPath: command.manifest } : {}),
    });
    if (command.kind === 'notes') {
      process.stdout.write(checked.notes);
      return;
    }
    process.stdout.write(`tag ${tag} matches package.json ${checked.version}\n`);
  } catch (error) {
    if (error instanceof ReleaseError) console.error(error.message);
    else console.error(error);
    process.exitCode = 1;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) main(process.argv.slice(2));
