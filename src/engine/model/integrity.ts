import type { ModelEntry } from './catalog';

export type IntegrityDecision = 'missing' | 'verified' | 'needs-hash' | 'reject-size';

export interface IntegrityFile {
  size: number;
  lastModified: number;
}

export interface IntegrityManifest {
  sha256: string;
  size: number;
  commit: string;
  lastModified?: number;
}

/**
 * Whether a file on disk can be trusted as the pinned catalog entry without hashing.
 *
 * A matching size+lastModified pair with a matching sidecar is enough: hashing a 1.8 GB
 * GGUF on every launch is too slow. Any size that is not the pin is rejected immediately
 * so a different GGUF under the official name cannot be loaded. A lastModified or pin
 * change forces a SHA-256 pass before the file may be used.
 */
export function decideIntegrity(
  entry: Pick<ModelEntry, 'sha256' | 'size' | 'commit'>,
  file: IntegrityFile | null,
  manifest: IntegrityManifest | null,
): IntegrityDecision {
  if (!file || file.size === 0) return 'missing';
  if (file.size !== entry.size) return 'reject-size';
  if (!manifest) return 'needs-hash';
  if (
    manifest.sha256 !== entry.sha256 ||
    manifest.size !== entry.size ||
    manifest.commit !== entry.commit
  ) {
    return 'needs-hash';
  }
  if (manifest.lastModified === undefined) return 'verified';
  if (manifest.lastModified !== file.lastModified) return 'needs-hash';
  return 'verified';
}

export function digestMatchesPin(digest: string, entry: Pick<ModelEntry, 'sha256'>): boolean {
  return digest === entry.sha256;
}
