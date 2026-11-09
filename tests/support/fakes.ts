import type { ModelEntry, ModelId } from '@/engine/model/catalog';
import type { ModelFileStore, ModelFileWriter, StorageEstimate } from '@/engine/model/file-store';
import type { CompletionRequest, LlamaRuntime } from '@/engine/in-browser/runtime';
import type { BackendKind } from '@/engine/in-browser/backend';
import type { IdentifiedEngine, TranslationChunk } from '@/engine/types';
import { abortError } from '@/engine/errors';

export class MemoryFileStore implements ModelFileStore {
  readonly files = new Map<string, Uint8Array>();
  quota = 4 * 1024 * 1024 * 1024;

  async size(path: string): Promise<number> {
    return this.files.get(path)?.length ?? 0;
  }

  async append(path: string, chunk: Uint8Array, offset: number): Promise<void> {
    const existing = this.files.get(path) ?? new Uint8Array(0);
    const next = new Uint8Array(Math.max(existing.length, offset + chunk.length));
    next.set(existing);
    next.set(chunk, offset);
    this.files.set(path, next);
  }

  async createWriter(path: string, offset: number): Promise<ModelFileWriter> {
    const existing = this.files.get(path) ?? new Uint8Array(0);
    let buffer = new Uint8Array(Math.max(existing.length, offset));
    buffer.set(existing);
    this.files.set(path, buffer);
    let position = offset;

    const ensure = (length: number): void => {
      if (length <= buffer.length) return;
      const grown = new Uint8Array(length);
      grown.set(buffer);
      buffer = grown;
      this.files.set(path, buffer);
    };

    return {
      write: async (chunk: Uint8Array) => {
        ensure(position + chunk.length);
        buffer.set(chunk, position);
        position += chunk.length;
        this.files.set(path, buffer.slice(0, position));
      },
      close: async () => {
        this.files.set(path, buffer.slice(0, position));
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
    this.files.delete(from);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async removeDirectory(path: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
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
  readonly backend: BackendKind = 'cpu-wasm';
  readonly threads = 8;
  readonly parallel: number;
  readonly requests: CompletionRequest[] = [];
  handler: (prompt: string) => string;

  constructor(handler: (prompt: string) => string, parallel = 1) {
    this.handler = handler;
    this.parallel = parallel;
  }

  async complete(request: CompletionRequest): Promise<void> {
    this.requests.push(request);
    const output = this.handler(request.prompt);
    for (const character of output) {
      if (request.signal.aborted) throw abortError();
      request.onToken(character);
      await Promise.resolve();
    }
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
