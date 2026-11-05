import type { EngineKind } from '../types';
import type { CachedTranslation, TranslationCacheStore } from './store';

export interface TranslationCacheOptions {
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 5000;
const FLUSH_DELAY_MS = 2000;
const PRUNE_EVERY_PUTS = 100;

export class TranslationCache {
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly pendingUses = new Map<string, CachedTranslation>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private putsSincePrune = 0;

  constructor(
    private readonly store: TranslationCacheStore,
    options: TranslationCacheOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  async get(key: string): Promise<{ text: string; engine: EngineKind } | undefined> {
    try {
      const hit = await this.store.get(key);
      if (!hit) return undefined;

      this.pendingUses.set(key, { ...hit, lastUsedAt: this.now() });
      this.scheduleFlush();
      return { text: hit.text, engine: hit.engine };
    } catch {
      return undefined;
    }
  }

  async put(key: string, text: string, engine: EngineKind): Promise<void> {
    const timestamp = this.now();
    try {
      await this.store.put(key, { text, engine, createdAt: timestamp, lastUsedAt: timestamp });
      this.pendingUses.delete(key);
      this.putsSincePrune += 1;
      if (this.putsSincePrune >= PRUNE_EVERY_PUTS) await this.prune();
    } catch {
      // The cache is an optimization; failures must not affect translation.
    }
  }

  /** Writes the accumulated last-used timestamps in one batch and trims the store. */
  async prune(): Promise<void> {
    this.putsSincePrune = 0;
    try {
      await this.flush();
      await this.store.prune(this.maxEntries);
    } catch {
      // Same as above.
    }
  }

  async clear(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingUses.clear();
    this.putsSincePrune = 0;
    await this.store.clear();
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const entries = [...this.pendingUses];
    this.pendingUses.clear();
    for (const [key, value] of entries) {
      try {
        await this.store.put(key, value);
      } catch {
        // Same as above.
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }
}
