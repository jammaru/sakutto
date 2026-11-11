import { isFirefoxBuild } from '@/shared/browser';
import { isRecord } from '@/shared/object';

export const SHARED_MODELS_DIRECTORY = 'sakutto-models';
export const SHARED_FOLDER_DB_NAME = 'sakutto-model-folder';
export const SHARED_FOLDER_STORE = 'handles';
export const SHARED_FOLDER_KEY = 'directory';

export type FolderPermission = 'granted' | 'denied' | 'prompt';

export interface StoredSharedFolder {
  handle: FileSystemDirectoryHandle;
  name: string;
  savedAt: number;
}

export interface SharedFolderHandleBucket {
  get(): Promise<StoredSharedFolder | null>;
  set(value: StoredSharedFolder): Promise<void>;
  clear(): Promise<void>;
}

export type DirectoryPicker = (options?: {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
}) => Promise<FileSystemDirectoryHandle>;

interface PermissionedHandle {
  queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

const DB_VERSION = 1;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

function asPermissioned(handle: FileSystemDirectoryHandle): PermissionedHandle {
  return handle as FileSystemDirectoryHandle & PermissionedHandle;
}

/** True when this build may use a stored directory handle. Firefox stays on OPFS. */
export function sharedFolderSupported(): boolean {
  return !isFirefoxBuild();
}

/** True when this page can show `showDirectoryPicker`. Offscreen documents often cannot. */
export function sharedFolderPickerAvailable(
  picker: unknown = typeof globalThis !== 'undefined'
    ? (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker
    : undefined,
): boolean {
  if (!sharedFolderSupported()) return false;
  return typeof picker === 'function';
}

export function lookupDirectoryPicker(): DirectoryPicker | null {
  if (typeof globalThis === 'undefined') return null;
  const picker = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  return typeof picker === 'function' ? picker : null;
}

export async function pickSharedModelFolder(
  picker: DirectoryPicker | null = lookupDirectoryPicker(),
): Promise<FileSystemDirectoryHandle> {
  if (!picker) {
    throw new Error('This browser cannot choose a folder for the translation model.');
  }
  return picker({
    id: 'sakutto-models',
    mode: 'readwrite',
    startIn: 'documents',
  });
}

/**
 * Offscreen documents and the service worker cannot show a permission prompt. A missing
 * `queryPermission` (OPFS-like handles) is treated as already granted.
 */
export async function queryFolderPermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<FolderPermission> {
  const query = asPermissioned(handle).queryPermission;
  if (typeof query !== 'function') return 'granted';
  const state = await query.call(handle, { mode });
  return state === 'granted' || state === 'denied' ? state : 'prompt';
}

/** Must run from a document with a user gesture (options page, not offscreen or the worker). */
export async function requestFolderPermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<FolderPermission> {
  const current = await queryFolderPermission(handle, mode);
  if (current === 'granted') return current;
  const request = asPermissioned(handle).requestPermission;
  if (typeof request !== 'function') return current;
  const state = await request.call(handle, { mode });
  return state === 'granted' || state === 'denied' ? state : 'prompt';
}

export function isStoredSharedFolder(value: unknown): value is StoredSharedFolder {
  if (!isRecord(value)) return false;
  if (typeof value.name !== 'string' || value.name.length === 0) return false;
  if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return false;
  return isDirectoryHandle(value.handle);
}

function isDirectoryHandle(value: unknown): value is FileSystemDirectoryHandle {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { kind?: unknown; getDirectoryHandle?: unknown };
  return record.kind === 'directory' && typeof record.getDirectoryHandle === 'function';
}

export class MemorySharedFolderBucket implements SharedFolderHandleBucket {
  private value: StoredSharedFolder | null = null;

  async get(): Promise<StoredSharedFolder | null> {
    return this.value;
  }

  async set(value: StoredSharedFolder): Promise<void> {
    this.value = value;
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

export class IndexedDbSharedFolderBucket implements SharedFolderHandleBucket {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(
    factory: IDBFactory | undefined = globalThis.indexedDB,
    name = SHARED_FOLDER_DB_NAME,
  ): Promise<IndexedDbSharedFolderBucket> {
    if (!factory) throw new Error('IndexedDB is not available.');
    const openRequest = factory.open(name, DB_VERSION);
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result;
      if (!db.objectStoreNames.contains(SHARED_FOLDER_STORE)) {
        db.createObjectStore(SHARED_FOLDER_STORE);
      }
    };
    const db = await promisify(openRequest);
    return new IndexedDbSharedFolderBucket(db);
  }

  async get(): Promise<StoredSharedFolder | null> {
    const transaction = this.db.transaction(SHARED_FOLDER_STORE, 'readonly');
    const stored = await promisify<unknown>(
      transaction.objectStore(SHARED_FOLDER_STORE).get(SHARED_FOLDER_KEY),
    );
    return isStoredSharedFolder(stored) ? stored : null;
  }

  async set(value: StoredSharedFolder): Promise<void> {
    const transaction = this.db.transaction(SHARED_FOLDER_STORE, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(SHARED_FOLDER_STORE).put(value, SHARED_FOLDER_KEY);
    await done;
  }

  async clear(): Promise<void> {
    const transaction = this.db.transaction(SHARED_FOLDER_STORE, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(SHARED_FOLDER_STORE).delete(SHARED_FOLDER_KEY);
    await done;
  }
}

let defaultBucket: SharedFolderHandleBucket | null = null;

export async function openSharedFolderBucket(): Promise<SharedFolderHandleBucket> {
  if (defaultBucket) return defaultBucket;
  defaultBucket = await IndexedDbSharedFolderBucket.open();
  return defaultBucket;
}

/** Test hook so unit tests do not open a real IndexedDB. */
export function setSharedFolderBucketForTests(bucket: SharedFolderHandleBucket | null): void {
  defaultBucket = bucket;
}

export async function loadStoredSharedFolder(
  bucket?: SharedFolderHandleBucket,
): Promise<StoredSharedFolder | null> {
  const store = bucket ?? (await openSharedFolderBucket().catch(() => null));
  if (!store) return null;
  return store.get();
}

export async function persistSharedFolderHandle(
  handle: FileSystemDirectoryHandle,
  bucket?: SharedFolderHandleBucket,
): Promise<StoredSharedFolder> {
  const stored: StoredSharedFolder = {
    handle,
    name: handle.name,
    savedAt: Date.now(),
  };
  const store = bucket ?? (await openSharedFolderBucket());
  await store.set(stored);
  return stored;
}

export async function clearStoredSharedFolder(bucket?: SharedFolderHandleBucket): Promise<void> {
  const store = bucket ?? (await openSharedFolderBucket().catch(() => null));
  if (!store) return;
  await store.clear();
}
