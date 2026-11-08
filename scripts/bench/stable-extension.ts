import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ROOT } from './host.ts';

/**
 * One directory every live run loads the extension from.
 *
 * Chrome derives an unpacked extension's ID from the absolute path it is loaded from, and
 * an origin's OPFS storage is keyed by that ID. Loading two builds from two paths therefore
 * gives two origins and two separate 546 MB copies of the model inside the same browser
 * profile, even though both are the same extension. An A/B that swaps the build directory
 * per run grows the profile by that much every time.
 *
 * Copying each build to this one path before launching keeps the ID constant, so every run
 * reuses the single stored model. The copy is the build the run actually loads, so nothing
 * about the measurement changes.
 */
export const STABLE_EXTENSION = resolve(ROOT, 'bench/.cache/ext-live');

/** Files that are not part of the extension and must not be copied or count as stale. */
const IGNORED = new Set(['.DS_Store']);

async function entries(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((name) => !IGNORED.has(name)).sort();
  } catch {
    return [];
  }
}

/**
 * Mirrors `from` into the stable directory and returns the path to load.
 *
 * The mirror replaces the previous build rather than merging into it, so a file that only
 * existed in the old build cannot survive into the new one and change the extension.
 */
export async function stageExtension(from: string): Promise<string> {
  const source = resolve(ROOT, from);
  if (source === STABLE_EXTENSION) return source;

  await mkdir(STABLE_EXTENSION, { recursive: true });
  for (const name of await entries(STABLE_EXTENSION)) {
    await rm(resolve(STABLE_EXTENSION, name), { recursive: true, force: true });
  }
  await cp(source, STABLE_EXTENSION, { recursive: true });
  return STABLE_EXTENSION;
}
