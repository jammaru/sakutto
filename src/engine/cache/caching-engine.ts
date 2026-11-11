import type {
  Engine,
  IdentifiedEngine,
  TranslateOptions,
  TranslateSegment,
  TranslationChunk,
} from '../types';
import { TranslationCache } from './cache';
import { buildTranslationCacheKey } from './key';

export class CachingEngine implements IdentifiedEngine {
  constructor(
    private readonly inner: IdentifiedEngine,
    private readonly cache: TranslationCache,
    private readonly modelId: string | (() => string),
    private readonly backend: string | (() => string) = 'unspecified',
  ) {}

  get kind() {
    return this.inner.kind;
  }

  async *translate(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk> {
    const misses: TranslateSegment[] = [];
    const keys = new Map<string, string>();
    const aliases = new Map<string, string[]>();
    const model = typeof this.modelId === 'function' ? this.modelId() : this.modelId;
    const backend = typeof this.backend === 'function' ? this.backend() : this.backend;

    for (const segment of segments) {
      if (options.signal.aborted) return;

      const key = buildTranslationCacheKey({
        model,
        backend,
        tgt: options.tgt,
        form: options.form,
        text: segment.text,
        src: options.src,
        glossary: options.glossary,
      });
      keys.set(segment.id, key);

      const hit = await this.cache.get(key);
      if (hit) {
        yield { id: segment.id, final: hit.text, engine: hit.engine };
        continue;
      }

      const copies = aliases.get(key);
      if (copies) {
        copies.push(segment.id);
        continue;
      }
      aliases.set(key, []);
      misses.push(segment);
    }

    if (misses.length === 0) return;

    const inner: Engine = this.inner;
    for await (const chunk of inner.translate(misses, options)) {
      if (options.signal.aborted) return;
      const key = keys.get(chunk.id);
      const copies = key ? (aliases.get(key) ?? []) : [];
      if (chunk.final !== undefined && chunk.final.length > 0 && key && chunk.error !== true) {
        await this.cache.put(key, chunk.final, chunk.engine ?? this.inner.kind);
      }
      yield chunk;
      for (const id of copies) {
        yield { ...chunk, id };
      }
    }
  }
}
