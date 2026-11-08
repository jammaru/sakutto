import { describe, expect, it, vi } from 'vitest';
import { abortError, EngineError } from '@/engine/errors';
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

describe('LazyInBrowserEngine after the GPU is lost', () => {
  const gone = () => new EngineError('gpu-lost', 'The GPU stopped working.');
  const a = { id: 'a', text: 'Hello.' };
  const b = { id: 'b', text: 'Bye.' };

  function dying(afterToken = false): FakeRuntime {
    const runtime = new FakeRuntime(() => '');
    runtime.complete = async (request) => {
      if (afterToken) request.onToken('壊');
      throw gone();
    };
    return runtime;
  }

  function engineOver(runtimes: FakeRuntime[], onGpuLost = vi.fn(async () => undefined)) {
    const loadRuntime = vi.fn(async () => {
      const runtime = runtimes.shift();
      if (!runtime) throw new Error('nothing left to load');
      return { runtime, selection: SELECTION };
    });
    return { engine: new LazyInBrowserEngine({ loadRuntime, onGpuLost }), loadRuntime, onGpuLost };
  }

  it('reloads and finishes the request', async () => {
    const { engine, loadRuntime, onGpuLost } = engineOver([dying(), new FakeRuntime(() => 'は')]);

    await expect(collectChunks(engine.translate([a], options()))).resolves.toEqual([
      { id: 'a', textDelta: 'は', engine: 'plamo' },
      { id: 'a', final: 'は', engine: 'plamo' },
    ]);
    expect(onGpuLost).toHaveBeenCalledOnce();
    expect(loadRuntime).toHaveBeenCalledTimes(2);
  });

  it('starts over the text already streamed from the lost runtime', async () => {
    const { engine } = engineOver([dying(true), new FakeRuntime(() => 'はい')]);

    await expect(collectChunks(engine.translate([a], options()))).resolves.toEqual([
      { id: 'a', textDelta: '壊', engine: 'plamo' },
      { id: 'a', textDelta: 'は', engine: 'plamo', restart: true },
      { id: 'a', textDelta: 'い', engine: 'plamo' },
      { id: 'a', final: 'はい', engine: 'plamo' },
    ]);
  });

  it('recovers once for every request on the lost runtime', async () => {
    const { engine, loadRuntime, onGpuLost } = engineOver([dying(), new FakeRuntime(() => 'は')]);

    await Promise.all([
      collectChunks(engine.translate([a], options())),
      collectChunks(engine.translate([b], options())),
    ]);

    expect(onGpuLost).toHaveBeenCalledOnce();
    expect(loadRuntime).toHaveBeenCalledTimes(2);
  });

  it('does not translate again what already finished', async () => {
    // Long enough that the two texts are not packed into one request.
    const first_ = { id: 'a', text: 'A sentence of ordinary length. '.repeat(12) };
    const next = { id: 'b', text: 'Another ordinary sentence here. '.repeat(12) };
    const second = new FakeRuntime(() => 'は');
    let calls = 0;
    const first = new FakeRuntime(() => '');
    first.complete = async (request) => {
      calls += 1;
      if (calls > 1) throw gone();
      request.onToken('先');
    };
    const { engine } = engineOver([first, second]);

    const chunks = await collectChunks(engine.translate([first_, next], options()));

    expect(chunks.filter((chunk) => chunk.final !== undefined)).toHaveLength(2);
    expect(second.requests).toHaveLength(1);
  });

  it('gives up after walking every step', async () => {
    const { engine, loadRuntime } = engineOver([dying(), dying(), dying(), dying()]);

    await expect(collectChunks(engine.translate([a], options()))).rejects.toMatchObject({
      code: 'gpu-lost',
    });
    expect(loadRuntime).toHaveBeenCalledTimes(4);
  });

  it('leaves any other failure to the caller', async () => {
    const broken = new FakeRuntime(() => '');
    broken.complete = async () => {
      throw new EngineError('model-load-failed', 'refused');
    };
    const { engine, onGpuLost } = engineOver([broken]);

    await expect(collectChunks(engine.translate([a], options()))).rejects.toMatchObject({
      code: 'model-load-failed',
    });
    expect(onGpuLost).not.toHaveBeenCalled();
  });
});
