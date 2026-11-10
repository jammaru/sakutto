import type { CompletionRequest, LlamaRuntime } from '../in-browser/runtime';
import { completeOnServer, type LocalServerConfig, type LocalServerFetch } from './client';

export class LocalServerRuntime implements LlamaRuntime {
  readonly backend = 'local-server' as const;
  readonly threads = 1;

  constructor(
    private readonly config: () => LocalServerConfig,
    private readonly fetchImpl: LocalServerFetch = fetch,
  ) {}

  get parallel(): number {
    return Math.max(1, this.config().parallel);
  }

  async complete(request: CompletionRequest): Promise<void> {
    await completeOnServer(this.config(), request, this.fetchImpl);
  }

  async dispose(): Promise<void> {
    // HTTP sessions are per request.
  }
}
