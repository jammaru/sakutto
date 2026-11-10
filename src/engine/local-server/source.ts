import type {
  IdentifiedEngine,
  TranslateOptions,
  TranslateSegment,
  TranslationChunk,
} from '../types';
import type { EngineSource } from '@/shared/engine-status';

/**
 * Picks the in-browser PLaMo runtime or the local-server runtime for a request. Chrome is
 * still chosen only for pairs PLaMo cannot do, by RoutingEngine above this.
 */
export class PlamoSourceEngine implements IdentifiedEngine {
  readonly kind = 'plamo' as const;

  constructor(
    private readonly inBrowser: IdentifiedEngine,
    private readonly localServer: IdentifiedEngine,
    private readonly source: () => EngineSource,
  ) {}

  async *translate(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk> {
    const engine = this.source() === 'local-server' ? this.localServer : this.inBrowser;
    yield* engine.translate(segments, options);
  }
}
