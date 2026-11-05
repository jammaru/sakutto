import { describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { translateViaBackground } from '@/shared/translation-client';
import type { TranslateOptions, TranslationChunk } from '@/engine/types';
import { FakePort, flushTasks } from './support/ports';

vi.mock('wxt/browser', () => ({
  browser: { runtime: { connect: vi.fn() } },
}));

const connect = vi.mocked(browser.runtime.connect);

function options(signal = new AbortController().signal): TranslateOptions {
  return { tgt: 'ja', form: 'polite', priority: 10, signal };
}

async function collect(iterable: AsyncIterable<TranslationChunk>): Promise<TranslationChunk[]> {
  const chunks: TranslationChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe('translateViaBackground', () => {
  it('streams chunks from the background broker', async () => {
    const port = new FakePort({ name: 'sakutto:translate' });
    connect.mockReturnValue(port.port);

    const pending = collect(translateViaBackground([{ id: 'a', text: 'Hello.' }], options()));
    await flushTasks();

    const start = port.messagesOfType('start')[0] as { requestId: string };
    port.emit({
      type: 'chunk',
      requestId: start.requestId,
      chunk: { id: 'a', final: 'こんにちは' },
    });
    port.emit({ type: 'done', requestId: start.requestId });

    await expect(pending).resolves.toEqual([{ id: 'a', final: 'こんにちは' }]);
  });

  it('fails with offscreen-unavailable when the broker disconnects', async () => {
    const port = new FakePort({ name: 'sakutto:translate' });
    connect.mockReturnValue(port.port);

    const iterator = translateViaBackground([{ id: 'a', text: 'Hello.' }], options())[
      Symbol.asyncIterator
    ]();
    const first = iterator.next();
    await flushTasks();

    port.disconnect();

    await expect(first).rejects.toMatchObject({ code: 'offscreen-unavailable' });
  });

  it('cancels the request when the caller aborts', async () => {
    const port = new FakePort({ name: 'sakutto:translate' });
    connect.mockReturnValue(port.port);
    const controller = new AbortController();

    const pending = collect(
      translateViaBackground([{ id: 'a', text: 'Hello.' }], options(controller.signal)),
    );
    await flushTasks();

    controller.abort();
    await expect(pending).resolves.toEqual([]);
    expect(port.messagesOfType('cancel')).toHaveLength(1);
  });
});
