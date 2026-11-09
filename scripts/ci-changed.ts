import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BUNDLE_FILES = new Set([
  '.github/workflows/ci.yml',
  '.github/workflows/amo.yml',
  'scripts/package-artifact.ts',
  'scripts/amo-source-package.ts',
  'scripts/web-ext-lint.ts',
  'scripts/compare-extension-builds.ts',
  'amo-metadata.json',
]);

export interface ChangeScope {
  wllama: boolean;
  code: boolean;
  bundle: boolean;
}

function isBundleInput(file: string): boolean {
  return (
    file.startsWith('scripts/wllama/') ||
    file.startsWith('.github/actions/package-extension/') ||
    BUNDLE_FILES.has(file)
  );
}

export function classifyChanges(files: readonly string[]): ChangeScope {
  let wllama = false;
  let code = false;
  let bundle = false;

  for (const file of files) {
    if (file.startsWith('scripts/wllama/')) wllama = true;
    if (isBundleInput(file)) bundle = true;
    if (file.startsWith('docs/') || file.endsWith('.md')) continue;
    code = true;
  }

  if (wllama || bundle) code = true;
  return { wllama, code, bundle };
}

function filesFrom(args: readonly string[]): string[] {
  if (args[0] === '--stdin') {
    return readFileSync(0, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  return args.filter((line) => line.length > 0);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(realpathSync(entry)).href;
}

if (isDirectRun()) {
  const scope = classifyChanges(filesFrom(process.argv.slice(2)));
  process.stdout.write(`wllama=${scope.wllama}\ncode=${scope.code}\nbundle=${scope.bundle}\n`);
}
