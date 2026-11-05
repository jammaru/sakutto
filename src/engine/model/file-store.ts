export interface StorageEstimate {
  usage: number;
  quota: number;
}

export interface ModelFileWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface ModelFileStore {
  size(path: string): Promise<number>;
  append(path: string, chunk: Uint8Array, offset: number): Promise<void>;
  createWriter(path: string, offset: number): Promise<ModelFileWriter>;
  read(path: string): Promise<Blob>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  estimate(): Promise<StorageEstimate>;
}

interface MovableFileHandle extends FileSystemFileHandle {
  move?(directory: FileSystemDirectoryHandle, name: string): Promise<void>;
}

function isMissingEntry(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

function isMoveConflict(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'InvalidModificationError' || error.name === 'NoModificationAllowedError')
  );
}

function splitPath(path: string): { directories: string[]; name: string } {
  const parts = path.split('/').filter((part) => part.length > 0 && part !== '.');
  const name = parts.pop();
  if (!name) throw new Error(`Invalid path: ${path}`);
  return { directories: parts, name };
}

export class OpfsModelFileStore implements ModelFileStore {
  private constructor(private readonly root: FileSystemDirectoryHandle) {}

  static async open(directoryName = 'sakutto'): Promise<OpfsModelFileStore> {
    const origin = await navigator.storage.getDirectory();
    const root = await origin.getDirectoryHandle(directoryName, { create: true });
    return new OpfsModelFileStore(root);
  }

  async size(path: string): Promise<number> {
    try {
      const handle = await this.fileHandle(path, false);
      const file = await handle.getFile();
      return file.size;
    } catch (error) {
      if (isMissingEntry(error)) return 0;
      throw error;
    }
  }

  async append(path: string, chunk: Uint8Array, offset: number): Promise<void> {
    const handle = await this.fileHandle(path, true);
    const writable = await handle.createWritable({ keepExistingData: true });
    try {
      await writable.write({ type: 'write', position: offset, data: new Uint8Array(chunk) });
    } finally {
      await writable.close();
    }
  }

  async createWriter(path: string, offset: number): Promise<ModelFileWriter> {
    const handle = await this.fileHandle(path, true);
    const writable = await handle.createWritable({ keepExistingData: offset > 0 });
    let position = offset;

    return {
      write: async (chunk: Uint8Array) => {
        await writable.write({
          type: 'write',
          position,
          data: new Uint8Array(chunk),
        });
        position += chunk.length;
      },
      close: async () => {
        await writable.close();
      },
    };
  }

  async read(path: string): Promise<Blob> {
    const handle = await this.fileHandle(path, false);
    return handle.getFile();
  }

  async move(from: string, to: string): Promise<void> {
    if (from === to) return;

    const source = await this.fileHandle(from, false);
    const { directories, name } = splitPath(to);
    const targetDirectory = await this.directoryHandle(directories, true);
    await this.remove(to);

    if (typeof (source as MovableFileHandle).move === 'function') {
      try {
        await (source as MovableFileHandle).move?.(targetDirectory, name);
        return;
      } catch (error) {
        if (!isMoveConflict(error)) throw error;
      }
    }

    const blob = await source.getFile();
    const target = await targetDirectory.getFileHandle(name, { create: true });
    const writable = await target.createWritable();
    try {
      await writable.write(blob);
    } finally {
      await writable.close();
    }
    await this.remove(from);
  }

  async remove(path: string): Promise<void> {
    const { directories, name } = splitPath(path);
    try {
      const directory = await this.directoryHandle(directories, false);
      await directory.removeEntry(name);
    } catch (error) {
      if (!isMissingEntry(error)) throw error;
    }
  }

  async removeDirectory(path: string): Promise<void> {
    const { directories, name } = splitPath(path);
    try {
      const parent = await this.directoryHandle(directories, false);
      await parent.removeEntry(name, { recursive: true });
    } catch (error) {
      if (!isMissingEntry(error)) throw error;
    }
  }

  async estimate(): Promise<StorageEstimate> {
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  }

  private async directoryHandle(
    directories: readonly string[],
    create: boolean,
  ): Promise<FileSystemDirectoryHandle> {
    let directory = this.root;
    for (const segment of directories) {
      directory = await directory.getDirectoryHandle(segment, { create });
    }
    return directory;
  }

  private async fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
    const { directories, name } = splitPath(path);
    const directory = await this.directoryHandle(directories, create);
    return directory.getFileHandle(name, { create });
  }
}
