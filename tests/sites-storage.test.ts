import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          const result: Record<string, unknown> = {};
          for (const name of keys) {
            if (state.values.has(name)) result[name] = state.values.get(name);
          }
          return result;
        },
        set: async (values: Record<string, unknown>) => {
          for (const [name, value] of Object.entries(values)) state.values.set(name, value);
        },
      },
      onChanged: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
  },
}));

const { loadSiteRules, saveSiteRule } = await import('@/dom/sites');

beforeEach(() => {
  state.values.clear();
});

describe('site target migration', () => {
  it('strips stored per-site languages once so the global target applies again', async () => {
    state.values.set('siteRules', {
      'news.example': { host: 'news.example', auto: 'ask', targetLanguage: 'en' },
    });

    const first = await loadSiteRules();
    expect(first['news.example']?.targetLanguage).toBeUndefined();
    expect(first['news.example']?.auto).toBe('ask');

    await saveSiteRule({
      host: 'news.example',
      auto: 'ask',
      targetLanguage: 'ko',
    });
    const second = await loadSiteRules();
    expect(second['news.example']?.targetLanguage).toBe('ko');
  });
});
