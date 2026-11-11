import { getModel, isModelId, type ModelId } from './catalog';
import {
  OpfsModelFileStore,
  type ModelFileStat,
  type ModelFileStore,
  type ModelFileWriter,
  type StorageEstimate,
} from './file-store';
import { SHARED_MODELS_DIRECTORY } from './shared-folder';

function modelIdFromManagerPath(path: string): ModelId | null {
  const parts = path.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts[0] !== 'models' || typeof parts[1] !== 'string' || !isModelId(parts[1])) return null;
  return parts[1];
}

/**
 * Maps ModelManager paths (`models/<id>/model.gguf`) onto the official PFN filenames in
 * `<chosen>/sakutto-models/`. Unknown paths are refused so this store never reads or
 * deletes an arbitrary GGUF.
 */
export function mapManagerPathToSharedName(path: string): string | null {
  const modelId = modelIdFromManagerPath(path);
  if (!modelId) return null;
  const official = getModel(modelId).file;
  const parts = path.split('/').filter((part) => part.length > 0 && part !== '.');
  const rest = parts.slice(2).join('/');
  if (rest.length === 0 || rest === 'model.gguf') return official;
  if (rest === 'model.gguf.part') return `${official}.part`;
  if (rest === 'model.json') return `${official}.verified.json`;
  return null;
}

export function pinnedSharedNames(modelId: ModelId): readonly string[] {
  const official = getModel(modelId).file;
  return [official, `${official}.part`, `${official}.verified.json`];
}

function requireMapped(path: string): string {
  const mapped = mapManagerPathToSharedName(path);
  if (!mapped) throw new Error(`Refusing a path that is not a pinned PLaMo model file: ${path}`);
  return mapped;
}

/**
 * User-chosen folder store. The engine still speaks ModelManager paths; this class is the
 * only place those paths become official PFN filenames.
 */
export class SharedFolderModelFileStore implements ModelFileStore {
  constructor(private readonly inner: ModelFileStore) {}

  static async open(directory: FileSystemDirectoryHandle): Promise<SharedFolderModelFileStore> {
    const root = await directory.getDirectoryHandle(SHARED_MODELS_DIRECTORY, { create: true });
    return new SharedFolderModelFileStore(OpfsModelFileStore.fromHandle(root));
  }

  async size(path: string): Promise<number> {
    return this.inner.size(requireMapped(path));
  }

  async stat(path: string): Promise<ModelFileStat | null> {
    return this.inner.stat(requireMapped(path));
  }

  async append(path: string, chunk: Uint8Array, offset: number): Promise<void> {
    await this.inner.append(requireMapped(path), chunk, offset);
  }

  async createWriter(path: string, offset: number): Promise<ModelFileWriter> {
    return this.inner.createWriter(requireMapped(path), offset);
  }

  async read(path: string): Promise<Blob> {
    return this.inner.read(requireMapped(path));
  }

  async move(from: string, to: string): Promise<void> {
    await this.inner.move(requireMapped(from), requireMapped(to));
  }

  async remove(path: string): Promise<void> {
    await this.inner.remove(requireMapped(path));
  }

  /**
   * Deletes only the official GGUF, its `.part` file, and our sidecar. It never removes
   * the `sakutto-models` directory or any other name the user may have placed there.
   */
  async removeDirectory(path: string): Promise<void> {
    const modelId = modelIdFromManagerPath(path);
    if (!modelId) return;
    for (const name of pinnedSharedNames(modelId)) {
      await this.inner.remove(name);
    }
  }

  async estimate(): Promise<StorageEstimate> {
    // The user-chosen volume has no origin quota we can read. ModelManager skips the
    // free-space check when quota is 0.
    return { usage: 0, quota: 0 };
  }
}
