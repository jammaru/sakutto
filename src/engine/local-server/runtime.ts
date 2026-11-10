import type { CompletionRequest, LlamaRuntime } from '../in-browser/runtime';
import { completeOnServer, type LocalServerConfig, type LocalServerFetch } from './client';

export const LOCAL_SERVER_PARALLEL = 4;

export class LocalServerRuntime implements LlamaRuntime {
  readonly backend = 'local-server' as const;
  readonly threads = 1;
  readonly parallel = LOCAL_SERVER_PARALLEL;

  constructor(
    private readonly config: () => LocalServerConfig,
    private readonly fetchImpl: LocalServerFetch = fetch,
  ) {}

  async complete(request: CompletionRequest): Promise<void> {
    await completeOnServer(this.config(), request, this.fetchImpl);
  }

  async dispose(): Promise<void> {
    // HTTP sessions are per request.
  }
}
