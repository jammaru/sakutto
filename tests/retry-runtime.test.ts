import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_ID, HIGH_QUALITY_MODEL_ID } from '@/engine/model/catalog';
import type { BackendSelection } from '@/engine/in-browser/backend';
import { CpuRetryRuntimeSlot } from '@/engine/offscreen/retry-runtime';
import { FakeRuntime } from './support/fakes';
import { deferred, flushTasks } from './support/ports';

const CPU: BackendSelection = {
  tier: 'c8',
  backend: 'cpu-wasm',
  nGpuLayers: 0,
  nThreads: 8,
  nParallel: 1,
  nCtx: 2048,
};

describe('CpuRetryRuntimeSlot', () => {
  it('lets cancel return before create finishes', async () => {
    const created = deferred<FakeRuntime>();
    const runtime = new FakeRuntime(() => 'x');
    const create = vi.fn(async () => created.promise);
    const slot = new CpuRetryRuntimeSlot({
      create,
      modelBlob: async () => new Blob(['weights']),
      activeModelId: () => DEFAULT_MODEL_ID,
      loaded: () => null,
      cpuSelection: () => CPU,
    });

    const controller = new AbortController();
    const pending = slot.load(controller.signal);
    await flushTasks();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(runtime.disposed).toBe(false);

    created.resolve(runtime);
    await flushTasks();
    expect(runtime.disposed).toBe(false);
    expect(create).toHaveBeenCalledOnce();
  });

  it('discards a load that finishes after the model id changes', async () => {
    const created = deferred<FakeRuntime>();
    const stale = new FakeRuntime(() => 'old');
    let active = DEFAULT_MODEL_ID;
    const slot = new CpuRetryRuntimeSlot({
      create: async () => created.promise,
      modelBlob: async () => new Blob(['weights']),
      activeModelId: () => active,
      loaded: () => null,
      cpuSelection: () => CPU,
    });

    const pending = slot.load(new AbortController().signal);
    await flushTasks();
    active = HIGH_QUALITY_MODEL_ID;
    slot.dispose();
    created.resolve(stale);

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await flushTasks();
    expect(stale.disposed).toBe(true);

    const next = new FakeRuntime(() => 'new');
    const fresh = new CpuRetryRuntimeSlot({
      create: async () => next,
      modelBlob: async () => new Blob(['weights']),
      activeModelId: () => HIGH_QUALITY_MODEL_ID,
      loaded: () => null,
      cpuSelection: () => CPU,
    });
    await expect(fresh.load(new AbortController().signal)).resolves.toBe(next);
    expect(stale.disposed).toBe(true);
  });

  it('does not block dispose on an in-flight create', async () => {
    const created = deferred<FakeRuntime>();
    const runtime = new FakeRuntime(() => 'x');
    const slot = new CpuRetryRuntimeSlot({
      create: async () => created.promise,
      modelBlob: async () => new Blob(['weights']),
      activeModelId: () => DEFAULT_MODEL_ID,
      loaded: () => null,
      cpuSelection: () => CPU,
    });

    const pending = slot.load(new AbortController().signal);
    await flushTasks();
    slot.dispose();
    created.resolve(runtime);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await flushTasks();
    expect(runtime.disposed).toBe(true);
  });
});
