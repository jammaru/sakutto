import type { EngineKind } from '../types';

export interface CachedTranslation {
  text: string;
  engine: EngineKind;
  createdAt: number;
  lastUsedAt: number;
}

export interface TranslationCacheStore {
  get(key: string): Promise<CachedTranslation | undefined>;
  put(key: string, value: CachedTranslation): Promise<void>;
  /** Removes the least recently used rows until at most `maxEntries` remain. */
  prune(maxEntries: number): Promise<number>;
  clear(): Promise<void>;
}

interface StoredTranslation extends CachedTranslation {
  key: string;
}

const DB_NAME = 'sakutto-translations';
const DB_VERSION = 1;
const STORE_NAME = 'translations';
const LAST_USED_INDEX = 'lastUsedAt';

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

export class MemoryTranslationCacheStore implements TranslationCacheStore {
  private readonly entries = new Map<string, CachedTranslation>();

  async get(key: string): Promise<CachedTranslation | undefined> {
    const value = this.entries.get(key);
    return value ? { ...value } : undefined;
  }

  async put(key: string, value: CachedTranslation): Promise<void> {
    this.entries.set(key, { ...value });
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  async prune(maxEntries: number): Promise<number> {
    if (this.entries.size <= maxEntries) return 0;

    const ordered = [...this.entries.entries()].sort(
      (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
    );
    const excess = this.entries.size - maxEntries;
    for (const [key] of ordered.slice(0, excess)) this.entries.delete(key);
    return excess;
  }

  get size(): number {
    return this.entries.size;
  }
}

export class IndexedDbTranslationCacheStore implements TranslationCacheStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(
    factory: IDBFactory = indexedDB,
    name = DB_NAME,
  ): Promise<IndexedDbTranslationCacheStore> {
    const openRequest = factory.open(name, DB_VERSION);

    openRequest.onupgradeneeded = () => {
      const db = openRequest.result;
      if (db.objectStoreNames.contains(STORE_NAME)) return;
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      store.createIndex(LAST_USED_INDEX, 'lastUsedAt');
    };

    const db = await promisify(openRequest);
    return new IndexedDbTranslationCacheStore(db);
  }

  async get(key: string): Promise<CachedTranslation | undefined> {
    const transaction = this.db.transaction(STORE_NAME, 'readonly');
    const stored = await promisify<StoredTranslation | undefined>(
      transaction.objectStore(STORE_NAME).get(key),
    );
    if (!stored) return undefined;
    return {
      text: stored.text,
      engine: stored.engine,
      createdAt: stored.createdAt,
      lastUsedAt: stored.lastUsedAt,
    };
  }

  async put(key: string, value: CachedTranslation): Promise<void> {
    const transaction = this.db.transaction(STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_NAME).put({ key, ...value } satisfies StoredTranslation);
    await done;
  }

  async clear(): Promise<void> {
    const transaction = this.db.transaction(STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_NAME).clear();
    await done;
  }

  async prune(maxEntries: number): Promise<number> {
    const countTransaction = this.db.transaction(STORE_NAME, 'readonly');
    const store = countTransaction.objectStore(STORE_NAME);
    const count = await promisify(store.count());
    if (count <= maxEntries) return 0;

    const excess = count - maxEntries;
    const index = store.index(LAST_USED_INDEX);
    const keys = (await promisify(index.getAllKeys(undefined, excess))) as string[];

    const transaction = this.db.transaction(STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    const target = transaction.objectStore(STORE_NAME);
    for (const key of keys) target.delete(key);
    await done;
    return keys.length;
  }
}
