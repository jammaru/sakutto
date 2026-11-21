import { knownRevisions, revisionForSize, type RevisionPin } from './catalog';

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
 * Whether a file on disk can be trusted as one of the catalog's official revisions without
 * hashing. A matching size+lastModified pair with a matching sidecar is enough: hashing a
 * 1.8 GB GGUF on every launch is too slow. Any size outside every known revision is rejected
 * immediately, so a different GGUF under the official name cannot be loaded. A lastModified
 * or revision change forces a SHA-256 pass before the file may be used.
 */
export function decideIntegrity(
  entry: RevisionPin,
  file: IntegrityFile | null,
  manifest: IntegrityManifest | null,
): IntegrityDecision {
  if (!file || file.size === 0) return 'missing';
  const revisions = knownRevisions(entry);
  // A sidecar for a different revision with the same size must not force a needless rehash.
  const revision = manifest
    ? (revisions.find(
        (item) =>
          item.size === file.size &&
          item.sha256 === manifest.sha256 &&
          item.commit === manifest.commit,
      ) ?? revisionForSize(entry, file.size))
    : revisionForSize(entry, file.size);
  if (!revision) return 'reject-size';
  if (!manifest) return 'needs-hash';
  if (
    manifest.sha256 !== revision.sha256 ||
    manifest.size !== revision.size ||
    manifest.commit !== revision.commit
  ) {
    return 'needs-hash';
  }
  if (manifest.lastModified === undefined) return 'verified';
  if (manifest.lastModified !== file.lastModified) return 'needs-hash';
  return 'verified';
}

/** Any known official revision is accepted; an unknown hash is never accepted. */
export function digestMatchesPin(digest: string, entry: RevisionPin): boolean {
  return knownRevisions(entry).some((revision) => revision.sha256 === digest);
}
