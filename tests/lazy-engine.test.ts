import { describe, expect, it, vi } from 'vitest';
import { abortError } from '@/engine/errors';
import type { BackendSelection } from '@/engine/in-browser/backend';
import { LazyInBrowserEngine } from '@/engine/in-browser/lazy-engine';
import type { TranslateOptions } from '@/engine/types';
import { collectChunks, FakeRuntime } from './support/fakes';
import { deferred, flushTasks } from './support/ports';

const SELECTION: BackendSelection = {
  tier: 'c8',
  backend: 'cpu-wasm',
  nGpuLayers: 0,
  nThreads: 8,
  nParallel: 1,
  nCtx: 2048,
};

function options(signal: AbortSignal = new AbortController().signal): TranslateOptions {
  return { tgt: 'ja', form: 'polite', priority: 10, signal };
}

describe('LazyInBrowserEngine', () => {
  it('keeps a shared load alive when the first caller aborts', async () => {
    const loaded = deferred<{ runtime: FakeRuntime; selection: BackendSelection }>();
    const loadRuntime = vi.fn(async (signal: AbortSignal) => {
      const result = await loaded.promise;
      if (signal.aborted) throw abortError();
      return result;
    });
    const engine = new LazyInBrowserEngine({ loadRuntime });

    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = collectChunks(
      engine.translate([{ id: 'a', text: 'Hello.' }], options(firstController.signal)),
    );
    await flushTasks();
    const second = collectChunks(
      engine.translate([{ id: 'a', text: 'Hello.' }], options(secondController.signal)),
    );
    await flushTasks();

    firstController.abort();
    await expect(first).rejects.toMatchObject({ code: 'aborted' });

    loaded.resolve({ runtime: new FakeRuntime(() => 'こんにちは'), selection: SELECTION });

    await expect(second).resolves.toEqual([
      { id: 'a', textDelta: 'こ', engine: 'plamo' },
      { id: 'a', textDelta: 'ん', engine: 'plamo' },
      { id: 'a', textDelta: 'に', engine: 'plamo' },
      { id: 'a', textDelta: 'ち', engine: 'plamo' },
      { id: 'a', textDelta: 'は', engine: 'plamo' },
      { id: 'a', final: 'こんにちは', engine: 'plamo' },
    ]);
    expect(loadRuntime).toHaveBeenCalledOnce();
  });

  it('aborts the shared load when every caller gives up', async () => {
    const loaded = deferred<{ runtime: FakeRuntime; selection: BackendSelection }>();
    let loadSignal: AbortSignal | undefined;
    const engine = new LazyInBrowserEngine({
      loadRuntime: async (signal) => {
        loadSignal = signal;
        return loaded.promise;
      },
    });

    const controller = new AbortController();
    const pending = collectChunks(
      engine.translate([{ id: 'a', text: 'Hello.' }], options(controller.signal)),
    );
    await flushTasks();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await flushTasks();
    expect(loadSignal?.aborted).toBe(true);
    loaded.resolve({ runtime: new FakeRuntime(() => 'x'), selection: SELECTION });
  });

  it('does not adopt a load that finishes after reset', async () => {
    const stale = deferred<{ runtime: FakeRuntime; selection: BackendSelection }>();
    const firstRuntime = new FakeRuntime(() => '古い');
    const secondRuntime = new FakeRuntime(() => '新しい');
    const loadRuntime = vi
      .fn()
      .mockImplementationOnce(async (signal: AbortSignal) => {
        const result = await stale.promise;
        if (signal.aborted) throw abortError();
        return result;
      })
      .mockImplementationOnce(async () => ({ runtime: secondRuntime, selection: SELECTION }));

    const engine = new LazyInBrowserEngine({ loadRuntime });
    const pending = collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));
    await flushTasks();

    engine.reset();
    stale.resolve({ runtime: firstRuntime, selection: SELECTION });
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });

    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(loadRuntime).toHaveBeenCalledTimes(2);
    expect(firstRuntime.requests).toHaveLength(0);
    expect(secondRuntime.requests).toHaveLength(1);
    expect(chunks.at(-1)).toEqual({ id: 'a', final: '新しい', engine: 'plamo' });
  });
});
