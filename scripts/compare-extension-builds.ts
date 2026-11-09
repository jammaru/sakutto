import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface FileDigest {
  name: string;
  sha256: string;
}

function walkFiles(directory: string, root = directory): FileDigest[] {
  const files: FileDigest[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walkFiles(path, root));
      continue;
    }
    const relativeName = relative(root, path).replaceAll('\\', '/');
    files.push({
      name: relativeName,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

export function compareDirectories(left: string, right: string): string[] {
  if (!existsSync(left)) return [`missing ${left}`];
  if (!existsSync(right)) return [`missing ${right}`];
  const first = walkFiles(left);
  const second = new Map(walkFiles(right).map((file) => [file.name, file.sha256]));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of first) {
    seen.add(file.name);
    const other = second.get(file.name);
    if (other === undefined) {
      problems.push(`missing in right: ${file.name}`);
      continue;
    }
    if (other !== file.sha256) problems.push(`differ: ${file.name}`);
  }
  for (const name of second.keys()) {
    if (!seen.has(name)) problems.push(`missing in left: ${name}`);
  }
  return problems;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  const left = process.argv[2];
  const right = process.argv[3];
  if (!left || !right) {
    console.error('Usage: node scripts/compare-extension-builds.ts <dir-a> <dir-b>');
    process.exitCode = 1;
  } else {
    const problems = compareDirectories(left, right);
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem);
      process.exitCode = 1;
    } else {
      console.log('the unpacked extensions match');
    }
  }
}
