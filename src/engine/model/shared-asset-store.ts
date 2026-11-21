import { OCR_MODEL_CATALOG, isOcrTier } from '@/engine/ocr/catalog';
import { OpfsModelFileStore } from './file-store';
import type { ModelFileStat, ModelFileStore, ModelFileWriter, StorageEstimate } from './file-store';
import {
  loadStoredSharedFolder,
  openSharedModelsDirectory,
  queryFolderPermission,
  sharedFolderSupported,
} from './shared-folder';

/**
 * OCR bundles use the same manager path vocabulary as the PLaMo GGUF (models/<id>/...),
 * but the user-facing folder is the shared sakutto-models root. This store keeps the two
 * kinds of weight separate: translation GGUF files stay at the root with their official
 * filenames, while each OCR bundle lives in its own ocr-<tier> subfolder.
 *
 * AssetManager writes its asset.json integrity sidecar inside that same subfolder, so a
 * folder reused by another profile or after a reinstall is recognised by size + SHA-256
 * without another download. The mapping is strictly allow-listed: no caller can use an OCR
 * path to read or delete an arbitrary file in the chosen folder.
 */
export function mapAssetPathToSharedName(path: string): string | null {
  const parts = path.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.length !== 3 || parts[0] !== 'models' || !parts[1]?.startsWith('ocr-')) return null;
  const tier = parts[1].slice('ocr-'.length);
  if (!isOcrTier(tier)) return null;
  const name = parts[2];
  if (!name) return null;
  if (name === 'asset.json') return parts[1] + '/' + name;
  const match = /^([a-z_]+)\.onnx(?:\.part)?$/u.exec(name);
  if (!match || !Object.hasOwn(OCR_MODEL_CATALOG, match[1] ?? '')) return null;
  return parts[1] + '/' + name;
}

function requireMapped(path: string): string {
  const mapped = mapAssetPathToSharedName(path);
  if (!mapped) throw new Error('Refusing a path that is not a pinned OCR asset file: ' + path);
  return mapped;
}

/** Folder store for multi-file OCR bundles, backed by the chosen directory as PLaMo. */
export class SharedFolderAssetStore implements ModelFileStore {
  constructor(private readonly inner: ModelFileStore) {}

  /** Opens the inner sakutto-models directory itself, not its parent. */
  static async open(directory: FileSystemDirectoryHandle): Promise<SharedFolderAssetStore> {
    const root = await openSharedModelsDirectory(directory);
    return new SharedFolderAssetStore(OpfsModelFileStore.fromHandle(root));
  }

  /** Reuses an already-opened shared root (for example the translation store's root). */
  static fromStore(store: ModelFileStore): SharedFolderAssetStore {
    return new SharedFolderAssetStore(store);
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

  /** Deletes one tier's dedicated subfolder, never the shared root or a GGUF file. */
  async removeDirectory(path: string): Promise<void> {
    const parts = path.split('/').filter((part) => part.length > 0);
    if (parts.length !== 2 || parts[0] !== 'models' || !parts[1]?.startsWith('ocr-')) {
      throw new Error('Refusing a directory that is not an OCR tier: ' + path);
    }
    if (!isOcrTier(parts[1].slice('ocr-'.length))) {
      throw new Error('Refusing a directory that is not an OCR tier: ' + path);
    }
    await this.inner.removeDirectory(parts[1]);
  }

  async estimate(): Promise<StorageEstimate> {
    // The chosen volume has no origin quota; AssetManager skips the free-space check.
    return { usage: 0, quota: 0 };
  }
}

/**
 * Resolves where OCR weights belong now, independent of whether translation has been
 * initialized. Shared folder first (when granted), browser storage otherwise. Null lets
 * OcrHost fall back to the same OPFS root translation uses.
 */
export async function openSharedOcrAssetStore(): Promise<ModelFileStore | null> {
  if (!sharedFolderSupported()) return null;
  const stored = await loadStoredSharedFolder().catch(() => null);
  if (!stored) return null;
  const permission = await queryFolderPermission(stored.handle).catch(() => 'denied');
  if (permission !== 'granted') return null;
  try {
    return await SharedFolderAssetStore.open(stored.handle);
  } catch {
    // A revoked or deleted folder must not break OCR: use browser storage instead.
    return null;
  }
}
