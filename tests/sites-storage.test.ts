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

const { deleteSiteRule, loadSiteRules, saveSiteRule } = await import('@/dom/sites');

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

describe('site rule deletion', () => {
  it('removes one stored rule and leaves the others in place', async () => {
    state.values.set('siteRules', {
      'news.example': { host: 'news.example', auto: 'always' },
      'docs.example': { host: 'docs.example', auto: 'never' },
    });

    await deleteSiteRule('news.example');

    const rules = await loadSiteRules();
    expect(rules['news.example']).toBeUndefined();
    expect(rules['docs.example']).toMatchObject({ host: 'docs.example', auto: 'never' });
  });

  it('normalizes the host before matching a stored rule', async () => {
    state.values.set('siteRules', {
      'news.example': { host: 'news.example', auto: 'ask' },
    });

    await deleteSiteRule('  NEWS.Example  ');

    const rules = await loadSiteRules();
    expect(rules['news.example']).toBeUndefined();
  });

  it('is a no-op for a host with no stored rule', async () => {
    state.values.set('siteRules', {
      'docs.example': { host: 'docs.example', auto: 'never' },
    });

    await deleteSiteRule('news.example');

    const rules = await loadSiteRules();
    expect(Object.keys(rules)).toEqual(['docs.example']);
  });

  it('serializes with a patch that is still saving', async () => {
    state.values.set('siteRules', {
      'news.example': { host: 'news.example', auto: 'ask' },
    });

    // The patch resolves first, then the delete removes what it saved: both writes land
    // in the queue, so the delete cannot read a half-written record.
    await Promise.all([
      saveSiteRule({ host: 'docs.example', auto: 'always' }),
      deleteSiteRule('news.example'),
    ]);

    const rules = await loadSiteRules();
    expect(rules['news.example']).toBeUndefined();
    expect(rules['docs.example']).toMatchObject({ host: 'docs.example', auto: 'always' });
  });
});
