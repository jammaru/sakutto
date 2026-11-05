import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@/shared/settings';

type StorageListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  getDelay: 0,
  setDelay: 0,
  failGet: false,
  listeners: new Set<StorageListener>(),
}));

vi.mock('wxt/browser', () => {
  const sleep = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

  return {
    browser: {
      i18n: {
        getUILanguage: () => 'en-US',
        getMessage: () => '',
      },
      storage: {
        local: {
          get: async (key: string) => {
            if (state.failGet) throw new Error('storage unavailable');
            await sleep(state.getDelay);
            return { [key]: state.values.get(key) };
          },
          set: async (values: Record<string, unknown>) => {
            await sleep(state.setDelay);
            for (const [key, value] of Object.entries(values)) state.values.set(key, value);
          },
        },
        onChanged: {
          addListener: (listener: StorageListener) => state.listeners.add(listener),
          removeListener: (listener: StorageListener) => state.listeners.delete(listener),
        },
      },
    },
  };
});

const { loadSettings, saveSettings, subscribeSettings } = await import('@/shared/storage');

beforeEach(() => {
  state.values.clear();
  state.getDelay = 0;
  state.setDelay = 0;
  state.failGet = false;
  state.listeners.clear();
});

describe('settings storage', () => {
  it('serializes concurrent patches so neither change is lost', async () => {
    state.getDelay = 20;

    const [first, second] = await Promise.all([
      saveSettings({ targetLanguage: 'ko' }),
      saveSettings({ form: 'plain' }),
    ]);

    expect(first).toMatchObject({ targetLanguage: 'ko', form: 'polite' });
    expect(second).toMatchObject({ targetLanguage: 'ko', form: 'plain' });
    expect(await loadSettings()).toMatchObject({ targetLanguage: 'ko', form: 'plain' });
  });

  it('propagates storage failures to the caller', async () => {
    state.failGet = true;

    await expect(loadSettings()).rejects.toThrow('storage unavailable');
    await expect(saveSettings({ form: 'plain' })).rejects.toThrow('storage unavailable');
  });

  it('notifies subscribers only for local settings changes', () => {
    const received: Settings[] = [];
    const unsubscribe = subscribeSettings((settings) => received.push(settings));

    expect(state.listeners.size).toBe(1);
    const listener = [...state.listeners][0];

    listener?.(
      {
        settings: {
          newValue: {
            schemaVersion: 1,
            targetLanguage: 'ko',
            form: 'plain',
            display: 'bilingual',
          },
        },
      },
      'local',
    );
    listener?.({ settings: { newValue: { schemaVersion: 1 } } }, 'sync');

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      targetLanguage: 'ko',
      form: 'plain',
      display: 'bilingual',
    });

    unsubscribe();
    expect(state.listeners.size).toBe(0);
  });
});
