import { describe, expect, it } from 'vitest';
import { OffscreenController } from '@/background/offscreen-lifecycle';

function fakeApi(initial: boolean) {
  const state = {
    exists: initial,
    creates: 0,
    closes: 0,
    createGate: Promise.resolve(),
  };

  const api = {
    hasDocument: async () => state.exists,
    createDocument: async () => {
      state.creates += 1;
      await state.createGate;
      state.exists = true;
    },
    closeDocument: async () => {
      state.closes += 1;
      state.exists = false;
    },
  };

  return { api, state };
}

describe('OffscreenController', () => {
  it('creates the document once for concurrent callers', async () => {
    const { api, state } = fakeApi(false);
    const controller = new OffscreenController(api);

    await Promise.all([controller.ensure(), controller.ensure(), controller.ensure()]);

    expect(state.creates).toBe(1);
    expect(state.exists).toBe(true);
  });

  it('reuses an existing document', async () => {
    const { api, state } = fakeApi(true);
    const controller = new OffscreenController(api);

    await controller.ensure();
    await controller.ensure();

    expect(state.creates).toBe(0);
  });

  it('closes and recreates the document after a crash', async () => {
    const { api, state } = fakeApi(true);
    const controller = new OffscreenController(api);

    await controller.recreate();

    expect(state.closes).toBe(1);
    expect(state.creates).toBe(1);
    expect(state.exists).toBe(true);
  });

  it('accepts a create failure when another context already opened the document', async () => {
    const { api, state } = fakeApi(false);
    api.createDocument = async () => {
      state.creates += 1;
      state.exists = true;
      throw new Error('Only a single offscreen document may be created.');
    };
    const controller = new OffscreenController(api);

    await expect(controller.ensure()).resolves.toBeUndefined();
    expect(state.creates).toBe(1);
  });

  it('propagates a create failure when no document exists', async () => {
    const { api } = fakeApi(false);
    api.createDocument = async () => {
      throw new Error('offscreen is unavailable');
    };
    const controller = new OffscreenController(api);

    await expect(controller.ensure()).rejects.toThrow('offscreen is unavailable');
  });
});
