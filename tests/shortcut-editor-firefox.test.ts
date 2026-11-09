import { describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => ({ calls: 0, fail: false, chromeUrls: [] as string[] }));

vi.mock('@/shared/browser', () => ({
  isFirefoxBuild: () => true,
}));

vi.mock('wxt/browser', () => ({
  browser: {
    commands: {
      openShortcutSettings: async () => {
        if (opened.fail) throw new Error('cannot open');
        opened.calls += 1;
      },
    },
    tabs: {
      create: async (options: { url: string }) => {
        opened.chromeUrls.push(options.url);
      },
    },
  },
}));

const { openShortcutEditor } = await import('@/shared/shortcut-editor');

describe('Firefox shortcut editor', () => {
  it('opens Firefox shortcut settings instead of a chrome:// page', async () => {
    opened.calls = 0;
    opened.fail = false;
    opened.chromeUrls.length = 0;
    expect(await openShortcutEditor()).toBe(true);
    expect(opened.calls).toBe(1);
    expect(opened.chromeUrls).toEqual([]);
  });

  it('reports a settings page it could not open', async () => {
    opened.fail = true;
    expect(await openShortcutEditor()).toBe(false);
  });
});
