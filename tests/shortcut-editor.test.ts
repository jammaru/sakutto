import { describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({ urls: [] as string[], fail: false }));

vi.mock('wxt/browser', () => ({
  browser: {
    tabs: {
      create: async (options: { url: string }) => {
        if (created.fail) throw new Error('cannot open');
        created.urls.push(options.url);
        return { id: 1 };
      },
    },
  },
}));

const { openShortcutEditor } = await import('@/shared/shortcut-editor');

describe('shortcut editor', () => {
  it('opens the page where Chrome keeps extension shortcuts', async () => {
    created.urls.length = 0;
    created.fail = false;
    expect(await openShortcutEditor()).toBe(true);
    expect(created.urls).toEqual(['chrome://extensions/shortcuts']);
  });

  it('reports a tab it could not open instead of throwing', async () => {
    created.fail = true;
    expect(await openShortcutEditor()).toBe(false);
  });
});
