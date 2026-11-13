import type { ModelEntry, ModelId } from '@/engine/model/catalog';
import type {
  ModelFileStat,
  ModelFileStore,
  ModelFileWriter,
  StorageEstimate,
} from '@/engine/model/file-store';
import type {
  CompletionRequest,
  CompletionResult,
  LlamaRuntime,
} from '@/engine/in-browser/runtime';
import type { BackendKind } from '@/engine/in-browser/backend';
import type { IdentifiedEngine, TranslationChunk } from '@/engine/types';
import { abortError } from '@/engine/errors';

export class MemoryFileStore implements ModelFileStore {
  readonly files = new Map<string, Uint8Array>();
  readonly modified = new Map<string, number>();
  quota = 4 * 1024 * 1024 * 1024;
  now = () => Date.now();

  async size(path: string): Promise<number> {
    return this.files.get(path)?.length ?? 0;
  }

  async stat(path: string): Promise<ModelFileStat | null> {
    const data = this.files.get(path);
    if (!data) return null;
    return { size: data.length, lastModified: this.modified.get(path) ?? 0 };
  }

  async append(path: string, chunk: Uint8Array, offset: number): Promise<void> {
    const existing = this.files.get(path) ?? new Uint8Array(0);
    const next = new Uint8Array(Math.max(existing.length, offset + chunk.length));
    next.set(existing);
    next.set(chunk, offset);
    this.files.set(path, next);
    this.modified.set(path, this.now());
  }

  async createWriter(
    path: string,
    offset: number,
    options?: { keepExistingData?: boolean },
  ): Promise<ModelFileWriter> {
    const existing = this.files.get(path) ?? new Uint8Array(0);
    const keepExisting = options?.keepExistingData ?? offset > 0;
    let buffer = new Uint8Array(keepExisting ? Math.max(existing.length, offset) : offset);
    if (keepExisting) buffer.set(existing);
    this.files.set(path, buffer);
    let position = offset;

    const ensure = (length: number): void => {
      if (length <= buffer.length) return;
      const grown = new Uint8Array(length);
      grown.set(buffer);
      buffer = grown;
      this.files.set(path, buffer);
    };
    const visibleLength = (): number => (keepExisting ? buffer.length : position);

    return {
      write: async (chunk: Uint8Array) => {
        ensure(position + chunk.length);
        buffer.set(chunk, position);
        position += chunk.length;
        this.files.set(path, buffer.slice(0, visibleLength()));
        this.modified.set(path, this.now());
      },
      close: async () => {
        this.files.set(path, buffer.slice(0, visibleLength()));
        this.modified.set(path, this.now());
      },
    };
  }

  async read(path: string): Promise<Blob> {
    const data = this.files.get(path);
    if (!data) throw new DOMException(`Missing ${path}`, 'NotFoundError');
    return new Blob([new Uint8Array(data)]);
  }

  async move(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (!data) throw new DOMException(`Missing ${from}`, 'NotFoundError');
    this.files.set(to, data);
    this.modified.set(to, this.modified.get(from) ?? this.now());
    this.files.delete(from);
    this.modified.delete(from);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.modified.delete(path);
  }

  async removeDirectory(path: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) {
        this.files.delete(key);
        this.modified.delete(key);
      }
    }
  }

  async estimate(): Promise<StorageEstimate> {
    let usage = 0;
    for (const data of this.files.values()) usage += data.length;
    return { usage, quota: this.quota };
  }

  text(path: string): string {
    return new TextDecoder().decode(this.files.get(path) ?? new Uint8Array());
  }
}

export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

export class FakeRuntime implements LlamaRuntime {
  readonly backend: BackendKind;
  readonly threads = 8;
  readonly parallel: number;
  readonly requests: CompletionRequest[] = [];
  handler: (prompt: string) => string;
  /** When true, stop at maxTokens and report a length finish, like a collapsed kernel. */
  fillBudget = false;

  constructor(
    handler: (prompt: string) => string,
    parallel = 1,
    backend: BackendKind = 'cpu-wasm',
  ) {
    this.handler = handler;
    this.parallel = parallel;
    this.backend = backend;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult | void> {
    this.requests.push(request);
    const output = this.handler(request.prompt);
    let emitted = 0;
    for (const character of output) {
      if (request.signal.aborted) throw abortError();
      if (this.fillBudget && emitted >= request.maxTokens) return { hitMaxTokens: true };
      request.onToken(character);
      emitted += 1;
      await Promise.resolve();
    }
    return { hitMaxTokens: false };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  disposed = false;
}

export function fakeEngine(
  kind: 'plamo' | 'chrome',
  chunks: readonly TranslationChunk[],
  options: { error?: unknown; beforeChunks?: () => Promise<void> } = {},
): IdentifiedEngine & { calls: number } {
  let calls = 0;

  return {
    kind,
    get calls() {
      return calls;
    },
    async *translate(): AsyncIterable<TranslationChunk> {
      calls += 1;
      if (options.beforeChunks) await options.beforeChunks();
      if (options.error) throw options.error;
      for (const chunk of chunks) yield chunk;
    },
  };
}

export function makeEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: 'plamo-3-translate-0.8b-q4_k_m',
    params: '0.8B',
    quantization: 'Q4_K_M',
    repository: 'pfnet/example-GGUF',
    file: 'model.gguf',
    commit: 'abc123',
    size: 12,
    sha256: '0'.repeat(64),
    url: 'https://example.test/model.gguf',
    ...overrides,
  };
}

export function entryRecord(entry: ModelEntry): Readonly<Record<ModelId, ModelEntry>> {
  return { [entry.id]: entry } as Readonly<Record<ModelId, ModelEntry>>;
}

export async function collectChunks(
  iterable: AsyncIterable<TranslationChunk>,
): Promise<TranslationChunk[]> {
  const chunks: TranslationChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}
