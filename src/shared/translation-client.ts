import { browser } from 'wxt/browser';
import { EngineError, isAbortError } from '@/engine/errors';
import {
  TRANSLATION_PORT,
  errorFromPayload,
  isTranslationServerMessage,
  serializeTranslateOptions,
  type TranslationClientMessage,
} from '@/engine/offscreen/protocol';
import { ChunkStream } from '@/engine/queue/chunk-stream';
import type { TranslateOptions, TranslateSegment, TranslationChunk } from '@/engine/types';

/**
 * Streams a translation batch through the background broker. The service worker multiplexes
 * this connection onto the single offscreen engine.
 */
export async function* translateViaBackground(
  segments: readonly TranslateSegment[],
  options: TranslateOptions,
): AsyncGenerator<TranslationChunk> {
  if (options.signal.aborted || segments.length === 0) return;

  const requestId = crypto.randomUUID();
  const port = browser.runtime.connect({ name: TRANSLATION_PORT });
  const stream = new ChunkStream<TranslationChunk>();

  const onMessage = (message: unknown): void => {
    if (!isTranslationServerMessage(message) || message.requestId !== requestId) return;

    if (message.type === 'chunk') {
      stream.push(message.chunk);
    } else if (message.type === 'done') {
      stream.end();
    } else {
      stream.fail(errorFromPayload(message.error));
    }
  };

  const onDisconnect = (): void => {
    stream.fail(new EngineError('offscreen-unavailable', 'The translation connection closed.'));
  };

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);

  const cancel = (): void => {
    try {
      port.postMessage({ type: 'cancel', requestId } satisfies TranslationClientMessage);
    } catch {
      // The port is already gone.
    }
    stream.end();
  };
  options.signal.addEventListener('abort', cancel, { once: true });

  try {
    port.postMessage({
      type: 'start',
      requestId,
      segments: segments.map((segment) => ({ ...segment })),
      options: serializeTranslateOptions(options),
    } satisfies TranslationClientMessage);

    for await (const chunk of stream) yield chunk;
  } catch (error) {
    if (options.signal.aborted || isAbortError(error)) return;
    throw error instanceof EngineError
      ? error
      : new EngineError('offscreen-unavailable', 'The translation connection failed.', {
          cause: error,
        });
  } finally {
    options.signal.removeEventListener('abort', cancel);
    try {
      port.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}
