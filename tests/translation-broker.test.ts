import { describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import type { EngineClient } from '@/background/engine-client';
import { TranslationBroker } from '@/background/translation-broker';
import type { TranslateOptions, TranslationChunk } from '@/engine/types';
import { TRANSLATION_PORT, serializeTranslateOptions } from '@/engine/offscreen/protocol';
import { FakePort, deferred, flushTasks } from './support/ports';

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension',
      onConnect: { addListener: vi.fn() },
    },
  },
}));

function options(signal = new AbortController().signal): TranslateOptions {
  return { tgt: 'ja', form: 'polite', priority: 10, signal };
}

function connect(): FakePort {
  const port = new FakePort({
    name: TRANSLATION_PORT,
    sender: { id: 'test-extension' },
  });
  const listener = vi.mocked(browser.runtime.onConnect.addListener).mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('The broker did not register a connect listener.');
  listener(port.port);
  return port;
}

function start(port: FakePort, requestId = 'r1'): void {
  port.emit({
    type: 'start',
    requestId,
    segments: [{ id: 'a', text: 'Hello.' }],
    options: serializeTranslateOptions(options()),
  });
}

describe('TranslationBroker', () => {
  it('streams chunks with their provenance and a done event', async () => {
    const translate = vi.fn(async function* (): AsyncIterable<TranslationChunk> {
      yield { id: 'a', final: '簡易訳', engine: 'chrome' };
    });
    const broker = new TranslationBroker({ translate } as unknown as EngineClient);
    broker.start();

    const port = connect();
    start(port);
    await flushTasks();

    expect(port.messagesOfType('chunk')).toEqual([
      { type: 'chunk', requestId: 'r1', chunk: { id: 'a', final: '簡易訳', engine: 'chrome' } },
    ]);
    expect(port.messagesOfType('done')).toEqual([{ type: 'done', requestId: 'r1' }]);
  });

  it('does not send done after the caller cancels', async () => {
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    const translate = vi.fn(async function* (
      _segments: unknown,
      translateOptions: TranslateOptions,
    ): AsyncIterable<TranslationChunk> {
      signal = translateOptions.signal;
      await release.promise;
      yield { id: 'a', final: 'x', engine: 'plamo' };
    });
    const broker = new TranslationBroker({ translate } as unknown as EngineClient);
    broker.start();

    const port = connect();
    start(port);
    await flushTasks();
    port.emit({ type: 'cancel', requestId: 'r1' });
    release.resolve();
    await flushTasks();

    expect(signal?.aborted).toBe(true);
    expect(port.messagesOfType('done')).toHaveLength(0);
  });

  it('aborts translations when the caller disconnects', async () => {
    let signal: AbortSignal | undefined;
    const translate = vi.fn(async function* (
      _segments: unknown,
      translateOptions: TranslateOptions,
    ): AsyncIterable<TranslationChunk> {
      signal = translateOptions.signal;
      await new Promise((resolve) => {
        translateOptions.signal.addEventListener('abort', resolve, { once: true });
      });
      yield { id: 'a', final: 'x', engine: 'plamo' };
    });
    const broker = new TranslationBroker({ translate } as unknown as EngineClient);
    broker.start();

    const port = connect();
    start(port);
    await flushTasks();
    port.disconnect();
    await flushTasks();

    expect(signal?.aborted).toBe(true);
  });

  it('aborts the tab port when navigation cancels that tab', async () => {
    let signal: AbortSignal | undefined;
    const translate = vi.fn(async function* (
      _segments: unknown,
      translateOptions: TranslateOptions,
    ): AsyncIterable<TranslationChunk> {
      signal = translateOptions.signal;
      await new Promise((resolve) => {
        translateOptions.signal.addEventListener('abort', resolve, { once: true });
      });
      if (translateOptions.signal.aborted) return;
      yield { id: 'a', final: 'x', engine: 'plamo' };
    });
    const broker = new TranslationBroker({ translate } as unknown as EngineClient);
    broker.start();

    const port = new FakePort({
      name: TRANSLATION_PORT,
      sender: { id: 'test-extension', tab: { id: 7 } },
    });
    const listener = vi.mocked(browser.runtime.onConnect.addListener).mock.calls.at(-1)?.[0];
    if (!listener) throw new Error('The broker did not register a connect listener.');
    listener(port.port);
    start(port);
    await flushTasks();

    broker.cancelTab(7);
    await flushTasks();

    expect(signal?.aborted).toBe(true);
    broker.cancelTab(99);
  });
});
