import { isAbortError } from '../errors';
import {
  DEFAULT_MODEL_ID,
  SELECTABLE_MODEL_IDS,
  getModel,
  type ModelEntry,
  type ModelId,
} from './catalog';
import type { ModelFileStore } from './file-store';
import { importModelFile, type ModelTransferProgress } from './import-export';
import { SHARED_MODELS_DIRECTORY } from './shared-folder';

type FolderModelEntry = Pick<ModelEntry, 'size' | 'sha256' | 'commit' | 'file' | 'revisions'>;

export interface SharedFolderFileMatch {
  modelId: ModelId;
  file: File;
  relativePath: string;
}

export interface FolderCopyProgress {
  modelId: ModelId;
  index: number;
  total: number;
  transfer: ModelTransferProgress;
}

export interface FolderCopyFailure {
  modelId: ModelId;
  error: unknown;
}

export interface FolderCopyResult {
  discovered: ModelId[];
  imported: ModelId[];
  failed: FolderCopyFailure[];
}

function relativePathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return (relative && relative.length > 0 ? relative : file.name).replaceAll('\\', '/');
}

function entryFor(
  modelId: ModelId,
  entries: Partial<Record<ModelId, FolderModelEntry>>,
): FolderModelEntry {
  return entries[modelId] ?? getModel(modelId);
}

/**
 * Finds official PLaMo GGUF files in a `webkitdirectory` selection. Both the parent folder
 * (`Sakutto/sakutto-models/<official>.gguf`) and the inner `sakutto-models` folder
 * (`sakutto-models/<official>.gguf`) are accepted. Files under `sakutto-models` win when
 * the same official filename appears twice.
 */
export function discoverSharedModelFiles(
  files: readonly File[],
  options: {
    modelIds?: readonly ModelId[];
    entries?: Partial<Record<ModelId, FolderModelEntry>>;
  } = {},
): SharedFolderFileMatch[] {
  const modelIds = options.modelIds ?? SELECTABLE_MODEL_IDS;
  const entries = options.entries ?? {};
  const byName = new Map<string, ModelId>();
  for (const modelId of modelIds) {
    byName.set(entryFor(modelId, entries).file.toLowerCase(), modelId);
  }

  const best = new Map<ModelId, { file: File; rank: number; relativePath: string }>();
  for (const file of files) {
    const relativePath = relativePathOf(file);
    const name = relativePath.split('/').pop() ?? file.name;
    const modelId = byName.get(name.toLowerCase());
    if (!modelId) continue;
    const rank =
      relativePath.startsWith(`${SHARED_MODELS_DIRECTORY}/`) ||
      relativePath.includes(`/${SHARED_MODELS_DIRECTORY}/`)
        ? 2
        : 1;
    const previous = best.get(modelId);
    if (!previous || rank > previous.rank) {
      best.set(modelId, { file, rank, relativePath });
    }
  }

  return modelIds.flatMap((modelId) => {
    const match = best.get(modelId);
    return match ? [{ modelId, file: match.file, relativePath: match.relativePath }] : [];
  });
}

/**
 * Copies directory-selected official models into OPFS with the same size and SHA-256 checks
 * as a download. No network request is made. A failed file leaves any previously installed
 * copy untouched; other matching models are still tried.
 */
export async function copySharedFolderFilesToOpfs(options: {
  files: readonly File[];
  store: ModelFileStore;
  signal: AbortSignal;
  modelIds?: readonly ModelId[];
  entries?: Partial<Record<ModelId, FolderModelEntry>>;
  onProgress?: (progress: FolderCopyProgress) => void;
  chunkBytes?: number;
}): Promise<FolderCopyResult> {
  const entries = options.entries ?? {};
  const matches = discoverSharedModelFiles(options.files, {
    ...(options.modelIds ? { modelIds: options.modelIds } : {}),
    entries,
  });
  const imported: ModelId[] = [];
  const failed: FolderCopyFailure[] = [];

  for (const [index, match] of matches.entries()) {
    try {
      await importModelFile({
        file: match.file,
        modelId: match.modelId,
        store: options.store,
        signal: options.signal,
        entry: entryFor(match.modelId, entries),
        ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}),
        onProgress: (transfer) => {
          try {
            options.onProgress?.({
              modelId: match.modelId,
              index,
              total: matches.length,
              transfer,
            });
          } catch {
            // Progress listeners are cosmetic and must not interrupt the copy.
          }
        },
      });
      imported.push(match.modelId);
    } catch (error) {
      if (isAbortError(error) || options.signal.aborted) throw error;
      failed.push({ modelId: match.modelId, error });
    }
  }

  return {
    discovered: matches.map((match) => match.modelId),
    imported,
    failed,
  };
}

export function importedDefaultModel(result: FolderCopyResult): boolean {
  return result.imported.includes(DEFAULT_MODEL_ID);
}
